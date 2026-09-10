import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, stat, statfs, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { isIsoPath, MAX_FEATURE_SEC, parseFfprobe } from "./inspect.ts";
import type { ExecutablePlan, InspectionReport, Suggestion, WriteMode } from "./types.ts";
import { keepWritesLanguage, planHasVideoTranscode } from "./types.ts";
import {
  audioFillsSizeCap,
  copiedAudioBitrateBps,
  exceedsSizeCap,
  raisedTargetBytes,
  videoBitrateForTarget,
} from "./size-budget.ts";

const execFileAsync = promisify(execFile);

export function toolLocaleEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}

export type OptimizeRequest = {
  sourcePath: string;
  reviewDir: string;
  suggestion?: Suggestion;
  plan?: ExecutablePlan;
  report: InspectionReport;
  target: "hevc" | "av1";
  backend: "cuda" | "vaapi" | "none";
  vaapiDevice?: string | null;
  ffmpeg: string;
  ffprobe: string;
  mkvmerge: string;
  conservative: boolean;
  onPhase?: (phase: "muxing" | "creating_stereo" | "transcoding" | "finishing", progress: number) => void;
  onLog?: (text: string) => void;
  isCancelled?: () => boolean;
  jobId?: string;
  nodeId?: string;
};

export function optimizerWorkDir(reviewDir: string, nodeId?: string, jobId?: string): string {
  return nodeId ? join(reviewDir, ".work", nodeId, jobId ?? "job") : join(reviewDir, ".work");
}

export type OptimizeResult = {
  sidecarPath: string;
  output: InspectionReport;
};

export type Optimizer = (req: OptimizeRequest) => Promise<OptimizeResult>;

export function isExecutablePlan(value: unknown): value is ExecutablePlan {
  return Boolean(value && typeof value === "object" && value !== null && "origin" in value && "video" in value);
}

export function planFromSuggestion(suggestion: Suggestion, writeMode: WriteMode = "sidecar"): ExecutablePlan {
  const transcode = suggestion.actions.includes("transcode");
  const hours = Math.max(suggestion.now.sizePerHourGb && suggestion.now.sizeBytes
    ? suggestion.now.sizeBytes / (suggestion.now.sizePerHourGb * 1024 ** 3)
    : 1, 0.1);
  const nowBytes = suggestion.now.sizeBytes ?? 0;
  const afterBytes = suggestion.after.sizeBytes;
  const plannedBytes = afterBytes != null && afterBytes > 0
    ? afterBytes
    : Math.round((suggestion.after.sizePerHourGb ?? 2.5) * hours * 1024 ** 3);
  const currentBytes = nowBytes > 0 ? nowBytes : plannedBytes;
  const targetBytes = Math.min(plannedBytes, currentBytes);
  const codec = suggestion.after.codec?.toLowerCase() === "av1" ? "av1" : "hevc";
  const addStereo = suggestion.actions.includes("add_stereo");
  const stereoSource = suggestion.stereoSource ?? suggestion.keepAudio[0] ?? suggestion.stripAudio[0] ?? 0;
  const replaceSource = addStereo && suggestion.stripAudio.includes(stereoSource) ? stereoSource : null;
  return {
    origin: "bulk",
    video: transcode
      ? { kind: "size", codec, targetBytes, downscale1080p: false, bitDepth: 8, mustEncode: suggestion.mustEncode !== false }
      : { kind: "copy" },
    audio: [
      ...suggestion.keepAudio.map((index) => ({ op: "keep" as const, index, language: suggestion.keepAudioLanguages?.[String(index)] })),
      ...suggestion.stripAudio.filter((index) => index !== replaceSource).map((index) => ({ op: "remove" as const, index })),
      ...(replaceSource != null
        ? [{ op: "replace_downmix" as const, index: replaceSource, channels: 2 }]
        : addStereo
          ? [{ op: "add_downmix" as const, index: stereoSource, channels: 2 }]
          : []),
    ],
    subtitles: [
      ...suggestion.keepSubs.map((index) => ({ op: "keep" as const, index })),
      ...suggestion.stripSubs.map((index) => ({ op: "remove" as const, index })),
    ],
    container: "mkv",
    remuxInput: suggestion.actions.includes("remux"),
    writeMode,
    warning: suggestion.warning,
    reasons: [...suggestion.reasons],
    estimatedOutputBytes: suggestion.after.sizeBytes,
    category: suggestion.category,
  };
}

export function resolvePlan(value: Suggestion | ExecutablePlan | undefined, writeMode: WriteMode = "sidecar"): ExecutablePlan {
  if (isExecutablePlan(value)) return value;
  if (!value) throw new Error("The job has no executable plan.");
  return planFromSuggestion(value, writeMode);
}

export function shouldSkipSizeEncode(plan: ExecutablePlan, working: InspectionReport): boolean {
  if (plan.video.kind !== "size") return false;
  if (plan.video.mustEncode !== false) return false;
  const durationSec = Math.max(working.durationSec, 1);
  const hours = durationSec / 3600;
  const capGbPerHour = hours > 0 ? plan.video.targetBytes / 1024 ** 3 / hours : 0;
  if (!exceedsSizeCap(working.sizePerHourGb, capGbPerHour)) return true;
  return audioFillsSizeCap({
    targetBytes: plan.video.targetBytes,
    durationSec,
    audioBitrateBps: copiedAudioBitrateBps(working.audio, durationSec),
  });
}

function sizePlanForWorkingFile(plan: ExecutablePlan, working: InspectionReport): ExecutablePlan {
  if (plan.video.kind !== "size") return plan;
  const durationSec = Math.max(working.durationSec, 1);
  const audioBitrateBps = copiedAudioBitrateBps(working.audio, durationSec);
  if (!audioFillsSizeCap({ targetBytes: plan.video.targetBytes, durationSec, audioBitrateBps })) return plan;
  if (plan.origin === "custom") return plan;
  return {
    ...plan,
    video: {
      ...plan.video,
      targetBytes: raisedTargetBytes({ capBytes: plan.video.targetBytes, durationSec, audioBitrateBps }),
    },
  };
}

export type CapacityProbe = (path: string) => Promise<number>;

export function ffmpegOptimizer(options: { capacity?: CapacityProbe } = {}): Optimizer {
  return async (req) => {
    const plan = resolvePlan(req.plan ?? req.suggestion, req.plan?.writeMode ?? "sidecar");
    await mkdir(req.reviewDir, { recursive: true });
    const plannedBytes = plan.estimatedOutputBytes ?? req.report.sizeBytes;
    await assertReviewCapacity(req.reviewDir, Math.max(req.report.sizeBytes, plannedBytes) + 256 * 1024 ** 2, options.capacity);
    const workDir = optimizerWorkDir(req.reviewDir, req.nodeId, req.jobId);
    await mkdir(workDir, { recursive: true });
    const suffix = req.jobId ? `-${req.jobId}` : "";
    const sidecarPath = join(req.reviewDir, `${basename(req.sourcePath).replace(/\.[^.]+$/, "")}${suffix}.mkv`);
    const temps: string[] = [];
    try {
      let current = req.sourcePath;
      const emit = progressEmitter(req.onPhase);
      if (isIsoPath(req.sourcePath)) {
        emit("muxing", 0.02);
        const remuxed = join(workDir, `${Date.now()}-iso.mkv`);
        temps.push(remuxed);
        await remuxIso(req.ffmpeg, req.ffprobe, current, remuxed, req.report, {
          onTime: (sec) => emit("muxing", scaleProgress(0.02, 0.28, sec / Math.max(req.report.durationSec, 1))),
          onLog: req.onLog,
          isCancelled: req.isCancelled,
        });
        current = remuxed;
      }
      const extras = await createAudioExtras(req, plan, workDir, current, temps);
      const subtitleExtras = needsMux(plan) ? await createSubtitleExtras(req, plan, workDir, current, temps) : [];
      if (needsMux(plan) || extras.length || subtitleExtras.length) {
        emit("muxing", 0.3);
        const muxed = join(workDir, `${Date.now()}-mux.mkv`);
        temps.push(muxed);
        const muxPlan = planWithoutExtractedSubtitles(plan, subtitleExtras);
        const trackIds = needsTrackSelection(muxPlan)
          ? await identifyMkvmergeTrackIds(req.mkvmerge, current, req.report)
          : undefined;
        await run(req.mkvmerge, muxPlanArgs(current, muxed, muxPlan, extras, trackIds, subtitleExtras), {
          successfulExitCodes: [0, 1],
          onLog: req.onLog,
          onChunk: (text) => {
            const ratio = parseMkvmergeProgress(text);
            if (ratio != null) emit("muxing", scaleProgress(0.3, 0.42, ratio));
          },
          isCancelled: req.isCancelled,
        });
        current = muxed;
      }
      if (planHasVideoTranscode(plan)) {
        if (req.isCancelled?.()) throw new CancelledError();
        const encodeReport = await probeOutput(req.ffprobe, current);
        const durationReport = isoRemuxIsShort(req.report.durationSec, encodeReport.durationSec)
          ? req.report
          : encodeReport.durationSec > 1
            ? encodeReport
            : req.report;
        if (!shouldSkipSizeEncode(plan, durationReport)) {
          if (req.backend === "none") {
            throw new Error("Hardware encode is unavailable. Polisharr will not fall back to a software encode.");
          }
          emit("transcoding", 0.45);
          const encoded = join(workDir, `${Date.now()}-enc.mkv`);
          temps.push(encoded);
          const encodePlan = sizePlanForWorkingFile(
            plan.video.kind === "copy"
              ? plan
              : { ...plan, video: { ...plan.video, bitDepth: encodeReport.bitDepth || plan.video.bitDepth } },
            durationReport,
          );
          const durationSec = Math.max(durationReport.durationSec, 1);
          await run(req.ffmpeg, encodeArgs(current, encoded, { ...req, plan: encodePlan, report: durationReport }), {
            onLog: req.onLog,
            onChunk: (text) => {
              const sec = parseFfmpegProgress(text);
              if (sec != null) emit("transcoding", scaleProgress(0.45, 0.92, sec / durationSec));
            },
            isCancelled: req.isCancelled,
          });
          current = encoded;
        }
      }
      emit("finishing", 0.95);
      if (current !== sidecarPath) await copyFile(current, sidecarPath);
      const output = await probeOutput(req.ffprobe, sidecarPath);
      if (output.durationSec <= 0 || (req.report.durationSec > 0 && output.durationSec < req.report.durationSec * 0.9)) {
        const srcMin = Math.round(req.report.durationSec / 60);
        const outMin = Math.round(output.durationSec / 60);
        throw new Error(
          isIsoPath(req.sourcePath)
            ? `The remuxed file is ${outMin} minutes; the disc listing was ${srcMin} minutes. ffmpeg likely copied a short title instead of the feature.`
            : "The finished file is missing duration or is shorter than the original.",
        );
      }
      assertTrackIntegrity(plan, output);
      return { sidecarPath, output };
    } catch (error) {
      await safeUnlink(sidecarPath);
      throw error;
    } finally {
      await Promise.all(temps.map(safeUnlink));
    }
  };
}

function assertTrackIntegrity(plan: ExecutablePlan, output: InspectionReport): void {
  if (!output.videoCodec || output.videoCodec === "unknown" || output.width <= 0 || output.height <= 0) {
    throw new Error("The finished file has no playable video stream.");
  }
  if (plan.video.kind !== "copy" && !new RegExp(plan.video.codec === "av1" ? "av1" : "hevc|h265", "i").test(output.videoCodec)) {
    throw new Error(`The finished file has ${output.videoCodec} video; the plan requested ${plan.video.codec.toUpperCase()}.`);
  }
  const expectedAudio = plan.audio.filter((op) => op.op !== "remove").length;
  const expectedSubtitles = plan.subtitles.filter((op) => op.op === "keep").length;
  if (output.audio.length < expectedAudio) {
    throw new Error("The finished file is missing one or more planned audio tracks.");
  }
  if (output.subtitles.length < expectedSubtitles) {
    throw new Error("The finished file is missing one or more planned subtitle tracks.");
  }
  if (expectedAudio > 0 && output.audio.every((track) => track.channels <= 0)) {
    throw new Error("The finished file has no usable audio tracks.");
  }
}

async function createAudioExtras(
  req: OptimizeRequest,
  plan: ExecutablePlan,
  workDir: string,
  source: string,
  temps: string[],
): Promise<AudioExtra[]> {
  const extras: AudioExtra[] = [];
  for (const op of plan.audio) {
    if (op.op !== "replace_aac" && op.op !== "replace_downmix" && op.op !== "add_downmix") continue;
    req.onPhase?.("creating_stereo", 0.12);
    const dest = join(workDir, `${Date.now()}-${op.op}-${op.index}.aac`);
    temps.push(dest);
    const sourceTrack = req.report.audio.find((t) => t.index === op.index);
    const channels = op.op === "replace_aac"
      ? sourceTrack?.channels ?? 2
      : op.channels;
    const language = sourceTrack?.language || "und";
    const durationSec = Math.max(req.report.durationSec, 1);
    await run(req.ffmpeg, audioAacArgs(source, dest, op.index, channels, req.conservative ? "128k" : "160k", language), {
      onLog: req.onLog,
      onChunk: (text) => {
        const sec = parseFfmpegProgress(text);
        if (sec != null) req.onPhase?.("creating_stereo", scaleProgress(0.12, 0.28, sec / durationSec));
      },
      isCancelled: req.isCancelled,
    });
    extras.push({ path: dest, language });
  }
  return extras;
}

async function createSubtitleExtras(
  req: OptimizeRequest,
  plan: ExecutablePlan,
  workDir: string,
  source: string,
  temps: string[],
): Promise<SubtitleExtra[]> {
  const extras: SubtitleExtra[] = [];
  for (const op of plan.subtitles) {
    if (op.op !== "keep") continue;
    const track = req.report.subtitles.find((item) => item.index === op.index);
    if (!track || !/mov_text|eia_608|eia_708|webvtt/i.test(track.codec)) continue;
    req.onPhase?.("muxing", 0.22);
    const dest = join(workDir, `${Date.now()}-sub-${op.index}.srt`);
    temps.push(dest);
    await run(req.ffmpeg, [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-map",
      `0:${op.index}`,
      "-c:s",
      "srt",
      dest,
    ]);
    extras.push({ path: dest, language: track.language || "und", index: op.index });
  }
  return extras;
}

function needsMux(plan: ExecutablePlan): boolean {
  return Boolean(plan.remuxInput)
    || plan.audio.some((op) => op.op !== "keep" || keepWritesLanguage(op))
    || plan.subtitles.some((op) => op.op !== "keep" || keepWritesLanguage(op));
}

function needsTrackSelection(plan: ExecutablePlan): boolean {
  return plan.audio.some((op) => op.op === "remove" || op.op === "replace_aac" || op.op === "replace_downmix" || keepWritesLanguage(op)) ||
    plan.subtitles.some((op) => op.op === "remove" || keepWritesLanguage(op));
}

export class CancelledError extends Error {
  constructor() {
    super("The job was cancelled.");
    this.name = "CancelledError";
  }
}

export function muxArgs(source: string, dest: string, suggestion: Suggestion, stereo?: string): string[] {
  return muxPlanArgs(source, dest, planFromSuggestion(suggestion), stereo ? [{ path: stereo, language: "und" }] : []);
}

type MkvmergeTrackIds = {
  audio: ReadonlyMap<number, number>;
  subtitles: ReadonlyMap<number, number>;
};

export type AudioExtra = { path: string; language: string };
export type SubtitleExtra = { path: string; language: string; index: number };

export function muxPlanArgs(
  source: string,
  dest: string,
  plan: ExecutablePlan,
  extras: AudioExtra[] = [],
  trackIds?: MkvmergeTrackIds,
  subtitleExtras: SubtitleExtra[] = [],
): string[] {
  const keepAudio = plan.audio.filter((op) => op.op === "keep" || op.op === "add_downmix").map((op) => op.index);
  const replaced = new Set(plan.audio.filter((op) => op.op === "replace_aac" || op.op === "replace_downmix").map((op) => op.index));
  const audio = keepAudio.filter((index) => !replaced.has(index)).map((index) => trackId(trackIds?.audio, index, "audio"));
  const keepSubs = plan.subtitles
    .filter((op) => op.op === "keep")
    .map((op) => trackId(trackIds?.subtitles, op.index, "subtitle"));
  const editsAudio = plan.audio.some((op) => op.op === "remove" || op.op === "replace_aac" || op.op === "replace_downmix");
  const editsSubtitles = plan.subtitles.some((op) => op.op === "remove");
  const args = ["-o", dest];
  if (editsAudio && audio.length) args.push("--audio-tracks", [...new Set(audio)].join(","));
  else if (editsAudio) args.push("--no-audio");
  if (editsSubtitles && keepSubs.length) args.push("--subtitle-tracks", keepSubs.join(","));
  else if (editsSubtitles) args.push("--no-subtitles");
  for (const op of plan.audio) {
    if (op.op === "keep" && keepWritesLanguage(op) && op.language) {
      args.push("--language", `${trackId(trackIds?.audio, op.index, "audio")}:${op.language}`);
    }
  }
  for (const op of plan.subtitles) {
    if (op.op === "keep" && keepWritesLanguage(op) && op.language) {
      args.push("--language", `${trackId(trackIds?.subtitles, op.index, "subtitle")}:${op.language}`);
    }
  }
  args.push(source);
  for (const extra of extras) {
    taggedExtraArgs(args, extra);
  }
  for (const extra of subtitleExtras) {
    taggedExtraArgs(args, extra);
  }
  return args;
}

function taggedExtraArgs(args: string[], extra: { path: string; language: string }): void {
  if (extra.language && extra.language !== "und") args.push("--language", `0:${extra.language}`);
  args.push(extra.path);
}

function planWithoutExtractedSubtitles(plan: ExecutablePlan, extracted: SubtitleExtra[]): ExecutablePlan {
  if (extracted.length === 0) return plan;
  const indexes = new Set(extracted.map((extra) => extra.index));
  return {
    ...plan,
    subtitles: plan.subtitles.map((op) => (indexes.has(op.index) ? { op: "remove" as const, index: op.index } : op)),
  };
}

function trackId(ids: ReadonlyMap<number, number> | undefined, ffprobeIndex: number, kind: "audio" | "subtitle"): number {
  if (!ids) return ffprobeIndex;
  const id = ids.get(ffprobeIndex);
  if (id == null) throw new Error(`mkvmerge could not match the planned ${kind} track.`);
  return id;
}

async function identifyMkvmergeTrackIds(
  mkvmerge: string,
  source: string,
  report: InspectionReport,
): Promise<MkvmergeTrackIds> {
  try {
    const { stdout } = await execFileAsync(mkvmerge, ["-J", source], { maxBuffer: 1024 * 512, env: toolLocaleEnv() });
    const identified = JSON.parse(stdout) as { tracks?: Array<{ id?: unknown; type?: unknown }> };
    const tracks = Array.isArray(identified.tracks) ? identified.tracks : [];
    const ids = (type: "audio" | "subtitles") => tracks
      .filter((track) => track.type === type && Number.isSafeInteger(track.id))
      .map((track) => Number(track.id));
    return {
      audio: trackIdsByOrder(report.audio, ids("audio")),
      subtitles: trackIdsByOrder(report.subtitles, ids("subtitles")),
    };
  } catch (error) {
    const err = error as { message?: string; stderr?: string; stdout?: string };
    if (err.message?.includes("Unexpected end of JSON") || err.message?.includes("Unexpected token")) {
      // Older mkvmerge wrappers can emit no JSON for identify. Fall back to the
      // normal Matroska ordering: video, audio, then subtitles.
      return {
        audio: new Map(report.audio.map((track, index) => [track.index, index + 1] as const)),
        subtitles: new Map(report.subtitles.map((track, index) => [track.index, index + 1 + report.audio.length] as const)),
      };
    }
    throw new Error(formatToolError(mkvmerge, { message: err.message, stderr: err.stderr, stdout: err.stdout }));
  }
}

function trackIdsByOrder(tracks: Array<{ index: number }>, mkvmergeIds: number[]): ReadonlyMap<number, number> {
  return new Map(tracks.flatMap((track, index) => {
    const id = mkvmergeIds[index];
    return id == null ? [] : [[track.index, id] as const];
  }));
}

export async function assertReviewCapacity(
  reviewDir: string,
  requiredBytes: number,
  capacity: CapacityProbe = availableBytes,
): Promise<void> {
  const freeBytes = await capacity(reviewDir);
  if (freeBytes >= requiredBytes) return;
  const needGb = (requiredBytes / 1024 ** 3).toFixed(1);
  const freeGb = (freeBytes / 1024 ** 3).toFixed(1);
  throw new Error(`The review volume has ${freeGb} GB of free space, but this job needs about ${needGb} GB.`);
}

async function availableBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

export function optimizeSteps(sourcePath: string, plan: ExecutablePlan): Array<"iso_remux" | "mux" | "encode"> {
  const steps: Array<"iso_remux" | "mux" | "encode"> = [];
  if (isIsoPath(sourcePath)) steps.push("iso_remux");
  if (needsMux(plan) || plan.audio.some((op) => op.op === "add_downmix" || op.op === "replace_aac" || op.op === "replace_downmix")) {
    steps.push("mux");
  }
  if (planHasVideoTranscode(plan)) steps.push("encode");
  return steps;
}

export function isBlurayIso(path: string): boolean {
  return /bdmv|br-disk|bd-disk|bluray|blu-ray/i.test(path);
}

export function isoDemuxArgs(source: string, force?: "bluray" | "plain"): string[] {
  if (force === "plain") return ["-i", source];
  if (force === "bluray" || isBlurayIso(source)) return ["-i", `bluray:${source}`];
  return ["-i", source];
}

export function isoInputAttempts(source: string): string[][] {
  const bluray = ["-i", `bluray:${source}`];
  const blurayFmt = ["-f", "bluray", "-i", source];
  const plain = ["-i", source];
  const playlists = [0, 1].map((n) => ["-playlist", String(n), "-i", `bluray:${source}`]);
  // A raw `-i disc.iso` on BR-DISK is often misread as a lone AC3 stream and has no video to map.
  if (isBlurayIso(source)) return [bluray, ...playlists, blurayFmt];
  return [plain, bluray, ...playlists];
}

export function isoRemuxIsShort(expectedSec: number, actualSec: number): boolean {
  if (!(actualSec > 1)) return true;
  if (actualSec < 60) return true;
  // A raw ISO probe can report millions of seconds of dummy AC3. Do not reject a feature-length remux against that.
  if (!(expectedSec > 120) || expectedSec > MAX_FEATURE_SEC) return false;
  return actualSec < expectedSec * 0.5;
}

export function isoCopyMaps(report?: InspectionReport): string[] {
  const audio = (report?.audio ?? []).filter((track) => track.channels > 0);
  const subs = report?.subtitles ?? [];
  if ((report?.width ?? 0) >= 16 && audio.length > 0) {
    const maps = ["-map", "0:v:0?"];
    for (const track of audio) maps.push("-map", `0:${track.index}?`);
    for (const track of subs) maps.push("-map", `0:${track.index}?`);
    return maps;
  }
  // A raw `-i disc.iso` is often misread as a lone AC3 stream. Optional maps let that attempt
  // fail closed without "0:v:0 matches no streams", then the bluray: input can copy the feature.
  return ["-map", "0:v:0?", "-map", "0:a:0?", "-map", "0:a?"];
}

export function isoRemuxArgs(source: string, dest: string, _plan?: ExecutablePlan, report?: InspectionReport): string[] {
  return isoRemuxArgSets(source, dest, report)[0] ?? [];
}

export function isoRemuxInputs(source: string, report?: InspectionReport): string[][] {
  const preferred = report?.isoPlaylist != null
    ? [["-playlist", String(report.isoPlaylist), "-i", `bluray:${source}`]]
    : [];
  const rest = isoInputAttempts(source).filter((args) => JSON.stringify(args) !== JSON.stringify(preferred[0]));
  return [...preferred, ...rest];
}

export function isoRemuxLanguageArgs(report?: InspectionReport): string[] {
  const args: string[] = [];
  const audio = (report?.audio ?? []).filter((track) => track.channels > 0 && track.language && track.language !== "und");
  const subs = (report?.subtitles ?? []).filter((track) => track.language && track.language !== "und");
  audio.forEach((track, i) => {
    args.push(`-metadata:s:a:${i}`, `language=${track.language}`);
  });
  subs.forEach((track, i) => {
    args.push(`-metadata:s:s:${i}`, `language=${track.language}`);
  });
  return args;
}

export function isoMapVariants(report?: InspectionReport): string[][] {
  return [
    isoCopyMaps(report),
    ["-map", "0:v:0?", "-map", "0:a:0?"],
    ["-map", "0:v:0?", "-map", "0:a?"],
  ];
}

export function isoRemuxArgSets(source: string, dest: string, report?: InspectionReport): string[][] {
  const head = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
    "-fflags",
    "+genpts+discardcorrupt",
    "-max_error_rate",
    "1",
    "-analyzeduration",
    "100M",
    "-probesize",
    "100M",
  ];
  const sets: string[][] = [];
  for (const input of isoRemuxInputs(source, report)) {
    for (const maps of isoMapVariants(report)) {
      sets.push([...head, ...input, ...maps, ...isoRemuxLanguageArgs(report), "-c", "copy", dest]);
    }
  }
  return sets;
}

async function remuxIso(
  ffmpeg: string,
  ffprobe: string,
  source: string,
  dest: string,
  report: InspectionReport,
  progress?: { onTime?: (sec: number) => void; onLog?: (text: string) => void; isCancelled?: () => boolean },
): Promise<void> {
  let lastError: unknown;
  for (const args of isoRemuxArgSets(source, dest, report)) {
    try {
      await run(ffmpeg, args, {
        onLog: progress?.onLog,
        onChunk: (text) => {
          const sec = parseFfmpegProgress(text);
          if (sec != null) progress?.onTime?.(sec);
        },
        isCancelled: progress?.isCancelled,
      });
      const remuxed = await probeOutput(ffprobe, dest).catch(() => null);
      if (!remuxed || isoRemuxIsShort(report.durationSec, remuxed.durationSec)) {
        await safeUnlink(dest);
        const minutes = Math.max(1, Math.round((remuxed?.durationSec ?? 0) / 60));
        const listed = Math.max(1, Math.round(report.durationSec / 60));
        lastError = new Error(
          `The remuxed file is ${minutes} minutes; the disc listing was ${listed} minutes. ffmpeg likely copied a short title instead of the feature.`,
        );
        continue;
      }
      return;
    } catch (error) {
      lastError = error;
      await safeUnlink(dest);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("ffmpeg could not remux this disc image into a Matroska file.");
}

export function audioAacArgs(
  source: string,
  dest: string,
  index: number,
  channels: number,
  bitrate: string,
  language = "und",
): string[] {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
    "-i",
    source,
    "-map",
    `0:${index}`,
    "-ac",
    String(channels),
    "-c:a",
    "aac",
    "-b:a",
    bitrate,
  ];
  if (language && language !== "und") args.push("-metadata:s:a:0", `language=${language}`);
  args.push(dest);
  return args;
}

const BANNER = /^(ffmpeg version|copyright|built with|configuration:|libav)/i;

export function formatToolError(bin: string, error: { message?: string; stderr?: string | Buffer; stdout?: string | Buffer }): string {
  const output = `${String(error.stderr ?? "")}\n${String(error.stdout ?? "")}`.trim();
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !BANNER.test(line));
  const useful =
    lines.find((line) => /error|cannot|failed|invalid|not found|no nvenc|unknown encoder/i.test(line)) ??
    lines.at(-1) ??
    (error.message && !BANNER.test(error.message) ? error.message : null) ??
    "The tool exited without a useful message.";
  return `${bin} failed. ${useful}`;
}

// NVDEC on Turing+ (including Ada) actually decodes these. MPEG-4 Part 2 and friends stay on the CPU so the encode still runs.
const NVDEC_CODECS = new Set(["av1", "h264", "hevc", "mjpeg", "mpeg1video", "mpeg2video", "vc1", "vp8", "vp9"]);
const VAAPI_DECODE_CODECS = new Set(["av1", "h264", "hevc", "mjpeg", "mpeg1video", "mpeg2video", "vc1", "vp8", "vp9"]);

function usesNvdec(backend: OptimizeRequest["backend"], codec: string): boolean {
  return backend === "cuda" && NVDEC_CODECS.has(codec.toLowerCase());
}

function usesVaapiDecode(backend: OptimizeRequest["backend"], codec: string): boolean {
  return backend === "vaapi" && VAAPI_DECODE_CODECS.has(codec.toLowerCase());
}

function cudaVideoFilter(downscale: boolean, tenBit: boolean): string {
  const format = tenBit ? "p010" : "nv12";
  return downscale ? `scale_cuda=w=1920:h=1080:format=${format}` : `scale_cuda=format=${format}`;
}

export function encodeArgs(source: string, dest: string, req: OptimizeRequest): string[] {
  const plan = req.plan ?? (req.suggestion ? planFromSuggestion(req.suggestion) : undefined);
  const video = plan?.video;
  const codec = video && video.kind !== "copy" ? video.codec : req.target;
  const encoder = codec === "av1"
    ? req.backend === "vaapi" ? "av1_vaapi" : "av1_nvenc"
    : req.backend === "vaapi" ? "hevc_vaapi" : "hevc_nvenc";
  const tenBit = (video && video.kind !== "copy" ? video.bitDepth : req.report.bitDepth) >= 10;
  const downscale = video?.kind !== "copy" && Boolean(video?.downscale1080p);
  const nvdec = usesNvdec(req.backend, req.report.videoCodec);
  const vaapiDecode = usesVaapiDecode(req.backend, req.report.videoCodec);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];
  if (req.backend === "vaapi") {
    const device = req.vaapiDevice || "/dev/dri/renderD128";
    args.push("-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va");
    if (vaapiDecode) {
      // hwaccel flags must precede -i or ffmpeg still decodes on the CPU, then hwupload.
      args.push("-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi");
    }
  } else if (nvdec) {
    // hwaccel flags must precede -i or ffmpeg still decodes on the CPU.
    args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
  }
  const videoMap = req.report.videoIndex == null ? "0:v:0" : `0:${req.report.videoIndex}`;
  args.push("-i", source, "-map", videoMap, "-map", "0:a?", "-map", "0:s?", "-map", "0:t?");
  if (req.backend === "vaapi") {
    const format = tenBit ? "p010" : "nv12";
    if (vaapiDecode) {
      args.push("-vf", downscale ? `scale_vaapi=w=1920:h=1080:format=${format}` : `scale_vaapi=format=${format}`);
    } else {
      const filters = [`format=${format}`, "hwupload=extra_hw_frames=64"];
      if (downscale) filters.push("scale_vaapi=w=1920:h=1080");
      args.push("-vf", filters.join(","));
    }
  } else if (nvdec) {
    args.push("-vf", cudaVideoFilter(downscale, tenBit));
  } else if (downscale) {
    args.push("-vf", "scale=1920:1080");
  }
  args.push("-c:v", encoder);
  if (tenBit && codec !== "av1") args.push("-profile:v", "main10");
  if (video?.kind === "quality") {
    if (req.backend === "vaapi") args.push("-qp", String(video.quality));
    else args.push("-cq", String(video.quality), "-rc", "vbr");
  } else {
    args.push(...sizeModeRateControl(req.backend, String(nvencBitrate(req, video))));
  }
  if (req.backend !== "vaapi" && !nvdec) args.push("-pix_fmt", tenBit ? "p010le" : "yuv420p");
  args.push("-c:a", "copy", ...subtitleEncodeArgs(req.report), dest);
  return args;
}

const TEXT_SUBTITLE_CODECS = new Set([
  "mov_text",
  "eia_608",
  "eia_608_closed_captions",
  "webvtt",
  "subrip",
  "srt",
  "ass",
  "ssa",
  "text",
  "ttxt",
]);

export function isTextSubtitleCodec(codec: string): boolean {
  return TEXT_SUBTITLE_CODECS.has(codec.toLowerCase().replace(/-/g, "_"));
}

export function subtitleEncodeArgs(report: InspectionReport): string[] {
  const converts = report.subtitles.map((track) => /mov_text|eia_608|eia_708|webvtt/i.test(track.codec));
  if (converts.length === 0 || converts.every((convert) => !convert)) return ["-c:s", "copy"];
  if (converts.every(Boolean)) return ["-c:s", "srt"];
  return converts.flatMap((convert, index) => ["-c:s:" + String(index), convert ? "srt" : "copy"]);
}

function sizeModeRateControl(backend: OptimizeRequest["backend"], bitrate: string): string[] {
  const bufsize = String(Number(bitrate) * 2);
  if (backend === "vaapi") {
    return ["-rc_mode", "CBR", "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bufsize];
  }
  return ["-rc", "cbr", "-multipass", "qres", "-rc-lookahead", "32", "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bufsize];
}

export function nvencBitrate(req: OptimizeRequest, video: ExecutablePlan["video"] | undefined): number {
  const durationSec = req.report.durationSec;
  if (!(durationSec > 1)) {
    throw new Error("Cannot pick a bitrate from the target file size because the file has no duration.");
  }
  const hours = durationSec / 3600;
  const targetBytes = video?.kind === "size"
    ? video.targetBytes
    : (req.suggestion?.after.sizePerHourGb ?? 2.5) * hours * 1024 ** 3;
  const codec = video && video.kind !== "copy" ? video.codec : req.target;
  return videoBitrateForTarget({
    targetBytes,
    durationSec,
    audioBitrateBps: copiedAudioBitrateBps(req.report.audio, durationSec),
    codec: codec === "av1" ? "av1" : "hevc",
  });
}

export function parseFfmpegProgress(text: string): number | null {
  const us = [...text.matchAll(/out_time_us=(\d+)/g)].pop();
  if (us) return Number(us[1]) / 1_000_000;
  // ffmpeg's out_time_ms is microseconds despite the name.
  const ms = [...text.matchAll(/out_time_ms=(\d+)/g)].pop();
  if (ms) return Number(ms[1]) / 1_000_000;
  const clock = [...text.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return null;
}

export function parseMkvmergeProgress(text: string): number | null {
  const match = [...text.matchAll(/Progress:\s*(\d+(?:\.\d+)?)%/g)].pop();
  return match ? Math.min(1, Number(match[1]) / 100) : null;
}

export function scaleProgress(start: number, end: number, ratio: number): number {
  const r = Math.min(1, Math.max(0, ratio));
  return start + (end - start) * r;
}

function progressEmitter(
  onPhase?: (phase: "muxing" | "creating_stereo" | "transcoding" | "finishing", progress: number) => void,
): (phase: "muxing" | "creating_stereo" | "transcoding" | "finishing", progress: number) => void {
  let lastValue = -1;
  let lastAt = 0;
  return (phase, progress) => {
    const now = Date.now();
    if (progress < lastValue + 0.002 && now - lastAt < 400) return;
    lastValue = progress;
    lastAt = now;
    onPhase?.(phase, progress);
  };
}

async function run(
  bin: string,
  args: string[],
  opts?: { onChunk?: (text: string) => void; onLog?: (text: string) => void; isCancelled?: () => boolean; successfulExitCodes?: readonly number[] },
): Promise<void> {
  if (!opts?.onChunk && !opts?.isCancelled) {
    try {
      await execFileAsync(bin, args, { timeout: 0, maxBuffer: 2 * 1024 * 1024, env: toolLocaleEnv() });
      return;
    } catch (error) {
      const err = error as { message?: string; stderr?: string; stdout?: string };
      throw new Error(formatToolError(bin, { message: err.message, stderr: err.stderr, stdout: err.stdout }));
    }
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: toolLocaleEnv() });
    let stdout = "";
    let stderr = "";
    const onCancel = setInterval(() => {
      if (opts.isCancelled?.()) child.kill("SIGTERM");
    }, 400);
    child.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      stdout = (stdout + text).slice(-2_000_000);
      opts.onLog?.(text);
      opts.onChunk?.(text);
    });
    child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      stderr = (stderr + text).slice(-2_000_000);
      opts.onLog?.(text);
    });
    child.on("error", (error) => {
      clearInterval(onCancel);
      reject(new Error(formatToolError(bin, { message: error.message, stderr, stdout })));
    });
    child.on("close", (code) => {
      clearInterval(onCancel);
      if (opts.isCancelled?.()) {
        reject(new CancelledError());
        return;
      }
      if ((opts.successfulExitCodes ?? [0]).includes(code ?? -1)) resolve();
      else reject(new Error(formatToolError(bin, { stderr, stdout })));
    });
  });
}

async function probeOutput(ffprobe: string, path: string): Promise<InspectionReport> {
  const { stdout } = await execFileAsync(ffprobe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path], {
    maxBuffer: 1024 * 512,
    env: toolLocaleEnv(),
  });
  const size = (await stat(path)).size;
  return parseFfprobe(path, size, JSON.parse(stdout) as Record<string, unknown>);
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The temp file may never have been created.
  }
}
