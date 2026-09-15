import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseFfprobe, pickPlayableVideo } from "./inspect.ts";
import {
  CancelledError,
  formatToolError,
  PREVIEW_DIR_NAME,
  PREVIEW_FINISHED_FILE,
  PREVIEW_ORIGINAL_FILE,
  PREVIEW_PUBLISHED_MARKER,
  claimOptimizerWorkDir,
  removePreviewPairDir,
  removeReviewArtifact,
  toolLocaleEnv,
  WORK_DIR_GUARD,
} from "./optimize.ts";
import type { RemotePreviewDocument } from "./cluster.ts";
import { PREVIEW_SDR_1080P_PROFILE, PREVIEW_TIMEOUT_MS } from "./cluster.ts";
import type {
  AudioTrack,
  PreviewArtifact,
  PreviewH264Encoder,
  PreviewPreset,
  PreviewTransformLabels,
} from "./types.ts";

export type PreviewRendererControl = {
  isCancelled: () => boolean;
  onProgress: (progress: number) => void;
  registerChild: (child: { kill: (signal?: NodeJS.Signals | number) => boolean | void }) => void;
};

export type PreviewRenderer = (
  task: RemotePreviewDocument,
  control: PreviewRendererControl,
) => Promise<{ ok: true; published?: boolean } | { ok: false; error: string }>;

export const PREVIEW_CLIP_MS = 15_000;
export const PREVIEW_MIN_DURATION_MS = 1_000;
export const PREVIEW_PAIR_RESERVE_BYTES = 128 * 1024 * 1024;
export const PREVIEW_CACHE_MAX_BYTES = 2 * 1024 ** 3;
export const PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PREVIEW_PROFILE_VERSION = 1;
export const PREVIEW_MAX_STREAM_PINS = 32;
export const PREVIEW_PRESENTATION_SLACK_MS = 250;

export const PREVIEW_SHORT_DURATION = "Both copies need at least one second of video to compare.";
export const PREVIEW_MISSING_STREAMS = "A preview needs playable video and audio on both copies.";
export const PREVIEW_HDR_UNAVAILABLE = "HDR10 previews need the same HDR on both copies so Polisharr can convert them the same way.";
export const PREVIEW_DV_UNAVAILABLE = "Dolby Vision previews are unavailable in this release.";
export const PREVIEW_HDR10PLUS_UNAVAILABLE = "HDR10+ previews are unavailable in this release.";
export const PREVIEW_NO_SOFTWARE_ENCODE = "No hardware H.264 encoder is available. Polisharr will not fall back to a software encode.";
export const PREVIEW_INVALID_START = "That timestamp is past the end of both copies.";
export const PREVIEW_INVALID_DURATION = "Clip duration must be greater than zero.";
export const PREVIEW_INVALID_PRESET = "That sample position is not valid.";
export const PREVIEW_INVALID_AUDIO = "That audio track is not on this copy.";
export const PREVIEW_CLIP_TOO_SHORT = "That timestamp does not leave one second to compare.";
export const PREVIEW_PAIR_INCOMPLETE = "The preview pair did not publish both clips.";
export const PREVIEW_SAR_WARNING = "The original and finished copies have different display aspect ratios. Neither image is stretched.";
export const PREVIEW_SIZE_CAP = "A preview clip exceeded the 128 MiB pair limit.";
export const PREVIEW_AUDIO_LABEL = "AAC stereo (downmixed for browser playback)";
export const PREVIEW_COLOR_SDR = "SDR";
export const PREVIEW_COLOR_HDR10_TO_SDR = "HDR10 converted to SDR with the same BT.2390 tonemap on both copies";

export { PREVIEW_DIR_NAME, PREVIEW_FINISHED_FILE, PREVIEW_ORIGINAL_FILE, PREVIEW_PUBLISHED_MARKER };

export type PreviewAudioChoice = {
  index: number;
  language: string;
  channels: number;
  codec: string;
  default: boolean;
};

export type PreviewMediaInfo = {
  durationMs: number;
  width: number;
  height: number;
  sarNum: number;
  sarDen: number;
  hdr: "none" | "hdr10" | "hdr10plus" | "dolby_vision";
  videoIndex: number;
  audio: PreviewAudioChoice[];
  hasVideo: boolean;
};

export type PreviewVideoSize = {
  width: number;
  height: number;
  sarNum: number;
  sarDen: number;
};

export type MatchedPreviewSize = {
  original: { width: number; height: number };
  finished: { width: number; height: number };
  sarMismatch: boolean;
  label: string;
};

export type NormalizedInterval =
  | { ok: true; startMs: number; durationMs: number }
  | { ok: false; error: string };

export type PreviewColor = "sdr" | "hdr10-to-sdr";

export type ColorDecision =
  | { ok: true; color: PreviewColor }
  | { ok: false; error: string };

export type RunFile = (
  bin: string,
  args: string[],
  opts: {
    timeoutMs: number;
    onSpawn?: (child: { kill: (signal?: NodeJS.Signals | number) => boolean | void }) => void;
    onStdout?: (text: string) => void;
    isCancelled?: () => boolean;
  },
) => Promise<{ stdout: string; stderr: string }>;

export type ProbedClip = {
  durationMs: number;
  startMs: number;
  hasH264: boolean;
  hasAac: boolean;
  audioChannels: number;
};

export function normalizePreviewInterval(
  input: { startMs?: number; durationMs?: number; preset?: PreviewPreset | null },
  commonDurationMs: number,
): NormalizedInterval {
  if (input.preset != null && input.preset !== "start" && input.preset !== "middle" && input.preset !== "end" && input.preset !== "custom") {
    return { ok: false, error: PREVIEW_INVALID_PRESET };
  }
  if (input.durationMs != null && (!(input.durationMs > 0) || !Number.isFinite(input.durationMs))) {
    return { ok: false, error: PREVIEW_INVALID_DURATION };
  }
  if (input.startMs != null && (input.startMs < 0 || !Number.isFinite(input.startMs))) {
    return { ok: false, error: PREVIEW_INVALID_START };
  }
  const wantMs = input.durationMs != null && input.durationMs > 0 ? input.durationMs : PREVIEW_CLIP_MS;
  const clipMs = Math.min(wantMs, commonDurationMs);
  let startMs = input.startMs ?? 0;
  if (input.preset === "start") startMs = 0;
  else if (input.preset === "middle") startMs = Math.max(0, (commonDurationMs - clipMs) / 2);
  else if (input.preset === "end") startMs = Math.max(0, commonDurationMs - clipMs);
  if (startMs >= commonDurationMs) return { ok: false, error: PREVIEW_INVALID_START };
  let durationMs = Math.min(wantMs, commonDurationMs - startMs);
  if (durationMs < PREVIEW_MIN_DURATION_MS && (input.preset === "start" || input.preset === "middle" || input.preset === "end")) {
    startMs = Math.max(0, commonDurationMs - Math.min(wantMs, commonDurationMs));
    durationMs = Math.min(wantMs, commonDurationMs - startMs);
  }
  if (durationMs < PREVIEW_MIN_DURATION_MS) return { ok: false, error: PREVIEW_CLIP_TOO_SHORT };
  return { ok: true, startMs: Math.round(startMs), durationMs: Math.round(durationMs) };
}

export function previewColorDecision(
  original: Pick<PreviewMediaInfo, "hdr">,
  finished: Pick<PreviewMediaInfo, "hdr">,
): ColorDecision {
  const kinds = [original.hdr, finished.hdr];
  if (kinds.some((kind) => kind === "dolby_vision")) return { ok: false, error: PREVIEW_DV_UNAVAILABLE };
  if (kinds.some((kind) => kind === "hdr10plus")) return { ok: false, error: PREVIEW_HDR10PLUS_UNAVAILABLE };
  if (original.hdr === "hdr10" && finished.hdr === "hdr10") return { ok: true, color: "hdr10-to-sdr" };
  if (kinds.some((kind) => kind === "hdr10")) return { ok: false, error: PREVIEW_HDR_UNAVAILABLE };
  return { ok: true, color: "sdr" };
}

export function displaySize(size: PreviewVideoSize): { width: number; height: number; dar: number } {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const sarNum = size.sarNum > 0 ? size.sarNum : 1;
  const sarDen = size.sarDen > 0 ? size.sarDen : 1;
  const displayWidth = width * sarNum / sarDen;
  return { width: displayWidth, height, dar: displayWidth / height };
}

export function fitWithin(width: number, height: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(1, maxW / Math.max(width, 1), maxH / Math.max(height, 1));
  return { width: evenPixels(width * scale), height: evenPixels(height * scale) };
}

export function matchedPreviewSize(original: PreviewVideoSize, finished: PreviewVideoSize): MatchedPreviewSize {
  const capW = 1920;
  const capH = 1080;
  const a = displaySize(original);
  const b = displaySize(finished);
  const aFit = fitWithin(a.width, a.height, capW, capH);
  const bFit = fitWithin(b.width, b.height, capW, capH);
  const sarMismatch = Math.abs(a.dar - b.dar) > 0.02;
  if (sarMismatch) {
    return {
      original: aFit,
      finished: bFit,
      sarMismatch: true,
      label: `${aFit.width}×${aFit.height} and ${bFit.width}×${bFit.height}`,
    };
  }
  const width = evenPixels(Math.min(aFit.width, bFit.width));
  const height = evenPixels(width / a.dar);
  return {
    original: { width, height },
    finished: { width, height },
    sarMismatch: false,
    label: `${width}×${height}`,
  };
}

export function defaultPreviewAudio(
  original: PreviewAudioChoice[],
  sidecar: PreviewAudioChoice[],
): { originalAudioIndex: number | null; sidecarAudioIndex: number | null } {
  const origDefault = original.find((track) => track.default) ?? original[0];
  const sideDefault = sidecar.find((track) => track.default) ?? sidecar[0];
  const origSurround = original.find((track) => track.channels > 2 && (!origDefault || track.language === origDefault.language))
    ?? original.find((track) => track.channels > 2);
  const sideStereo = origSurround
    ? sidecar.find((track) => track.channels === 2 && track.language === origSurround.language)
    : undefined;
  const origHasStereo = origSurround
    ? original.some((track) => track.channels === 2 && track.language === origSurround.language)
    : false;
  if (origSurround && sideStereo && !origHasStereo) {
    return { originalAudioIndex: origSurround.index, sidecarAudioIndex: sideStereo.index };
  }
  if (origDefault) {
    const match = sidecar.find((track) => track.language === origDefault.language && track.channels === origDefault.channels)
      ?? sidecar.find((track) => track.language === origDefault.language)
      ?? sideDefault;
    return { originalAudioIndex: origDefault.index, sidecarAudioIndex: match?.index ?? null };
  }
  return { originalAudioIndex: null, sidecarAudioIndex: sideDefault?.index ?? null };
}

export function resolvePreviewAudioIndex(tracks: PreviewAudioChoice[], requested: number | null, fallback: number | null): number | null {
  if (requested == null) return fallback;
  return tracks.some((track) => track.index === requested) ? requested : null;
}

export function previewCacheKey(input: {
  reviewId: string;
  sourceRevision: string;
  sidecarRevision: string;
  startMs: number;
  durationMs: number;
  originalAudioIndex: number;
  sidecarAudioIndex: number;
}): string {
  return [
    input.reviewId,
    input.sourceRevision,
    input.sidecarRevision,
    String(input.startMs),
    String(input.durationMs),
    String(input.originalAudioIndex),
    String(input.sidecarAudioIndex),
    PREVIEW_SDR_1080P_PROFILE,
    String(PREVIEW_PROFILE_VERSION),
  ].join("|");
}

export function revisionKey(revision: { canonicalPath: string; sizeBytes: number | null; mtimeMs: number | null; fileId: string | null } | null): string {
  if (!revision) return "";
  return [revision.canonicalPath, revision.sizeBytes ?? "", revision.mtimeMs ?? "", revision.fileId ?? ""].join(":");
}

export function transformLabels(input: {
  size: MatchedPreviewSize;
  color: PreviewColor;
}): PreviewTransformLabels {
  return {
    scale: input.size.label,
    audio: PREVIEW_AUDIO_LABEL,
    color: input.color === "hdr10-to-sdr" ? PREVIEW_COLOR_HDR10_TO_SDR : PREVIEW_COLOR_SDR,
    warnings: input.size.sarMismatch ? [PREVIEW_SAR_WARNING] : [],
  };
}

export function parseRatio(value: unknown): { num: number; den: number } {
  if (typeof value !== "string") return { num: 1, den: 1 };
  const match = value.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return { num: 1, den: 1 };
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!(num > 0) || !(den > 0)) return { num: 1, den: 1 };
  return { num, den };
}

export function parsePreviewMedia(path: string, sizeBytes: number, probe: Record<string, unknown>): PreviewMediaInfo {
  const report = parseFfprobe(path, sizeBytes, probe);
  const streams = Array.isArray(probe.streams) ? probe.streams.filter(isRecord) : [];
  const video = pickPlayableVideo(streams);
  const sar = parseRatio(video?.sample_aspect_ratio);
  const format = isRecord(probe.format) ? probe.format : {};
  const durationMs = Math.round(Math.max(report.durationSec, numberOr(format.duration, 0)) * 1000);
  return {
    durationMs,
    width: report.width,
    height: report.height,
    sarNum: sar.num,
    sarDen: sar.den,
    hdr: report.hdr,
    videoIndex: report.videoIndex ?? 0,
    audio: report.audio.map(audioChoice),
    hasVideo: Boolean(report.videoCodec && report.videoCodec !== "unknown" && report.width > 0 && report.height > 0),
  };
}

export function mediaFromInspection(
  report: {
    durationSec: number;
    width: number;
    height: number;
    hdr: PreviewMediaInfo["hdr"];
    videoIndex?: number;
    audio: AudioTrack[];
    videoCodec: string;
  },
  durationSec = report.durationSec,
): PreviewMediaInfo {
  return {
    durationMs: Math.round(Math.max(durationSec, 0) * 1000),
    width: report.width,
    height: report.height,
    sarNum: 1,
    sarDen: 1,
    hdr: report.hdr,
    videoIndex: report.videoIndex ?? 0,
    audio: report.audio.map(audioChoice),
    hasVideo: Boolean(report.videoCodec && report.videoCodec !== "unknown" && report.width > 0 && report.height > 0),
  };
}

export async function probePreviewMedia(ffprobe: string, path: string, runFile: RunFile = defaultRunFile): Promise<PreviewMediaInfo> {
  const { stdout } = await runFile(ffprobe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path], {
    timeoutMs: 30_000,
  });
  const parsed: unknown = JSON.parse(stdout);
  const probe = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const size = existsSync(path) ? statSync(path).size : 0;
  return parsePreviewMedia(path, size, probe);
}

export function parseProbedClip(probe: Record<string, unknown>): ProbedClip {
  const format = isRecord(probe.format) ? probe.format : {};
  const streams = Array.isArray(probe.streams) ? probe.streams.filter(isRecord) : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationSec = numberOr(format.duration, numberOr(video?.duration, 0));
  const startSec = numberOr(format.start_time, numberOr(video?.start_time, 0));
  return {
    durationMs: Math.round(durationSec * 1000),
    startMs: Math.round(startSec * 1000),
    hasH264: stringOr(video?.codec_name, "") === "h264",
    hasAac: stringOr(audio?.codec_name, "") === "aac",
    audioChannels: intOr(audio?.channels, 0),
  };
}

export function clipsMatchInterval(original: ProbedClip, finished: ProbedClip, durationMs: number): boolean {
  if (!original.hasH264 || !finished.hasH264 || !original.hasAac || !finished.hasAac) return false;
  if (original.audioChannels < 1 || finished.audioChannels < 1) return false;
  if (Math.abs(original.startMs - finished.startMs) > PREVIEW_PRESENTATION_SLACK_MS) return false;
  if (original.startMs > PREVIEW_PRESENTATION_SLACK_MS || finished.startMs > PREVIEW_PRESENTATION_SLACK_MS) return false;
  if (Math.abs(original.durationMs - durationMs) > PREVIEW_PRESENTATION_SLACK_MS) return false;
  if (Math.abs(finished.durationMs - durationMs) > PREVIEW_PRESENTATION_SLACK_MS) return false;
  return true;
}

export function buildClipArgs(input: {
  sourcePath: string;
  destPath: string;
  encoder: PreviewH264Encoder;
  vaapiDevice?: string | null;
  startMs: number;
  durationMs: number;
  videoIndex: number;
  audioIndex: number;
  width: number;
  height: number;
  tonemap?: boolean;
}): string[] {
  const startSec = (input.startMs / 1000).toFixed(3);
  const durationSec = (input.durationMs / 1000).toFixed(3);
  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];
  appendHwAccel(args, input.encoder, input.vaapiDevice);
  args.push(
    "-ss",
    startSec,
    "-accurate_seek",
    "-i",
    input.sourcePath,
    "-t",
    durationSec,
    "-map",
    `0:${input.videoIndex}`,
    "-map",
    `0:${input.audioIndex}`,
    "-sn",
    "-dn",
    "-vf",
    scaleFilter(input.encoder, input.width, input.height, input.tonemap === true),
    "-c:v",
    input.encoder,
  );
  appendEncoderSettings(args, input.encoder);
  args.push(
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-b:a",
    "160k",
    "-avoid_negative_ts",
    "make_zero",
    "-fflags",
    "+genpts",
    "-start_at_zero",
    "-movflags",
    "+faststart",
    "-fs",
    String(PREVIEW_PAIR_RESERVE_BYTES),
    input.destPath,
  );
  assertHardwareVideoEncoder(args);
  return args;
}

export function assertHardwareVideoEncoder(args: string[]): void {
  if (args.includes("libx264") || args.includes("libx265") || args.includes("libaom-av1") || args.includes("libsvtav1")) {
    throw new Error(PREVIEW_NO_SOFTWARE_ENCODE);
  }
  const codecAt = args.lastIndexOf("-c:v");
  const encoder = codecAt >= 0 ? args[codecAt + 1] : "";
  if (encoder !== "h264_nvenc" && encoder !== "h264_vaapi" && encoder !== "h264_videotoolbox") {
    throw new Error(PREVIEW_NO_SOFTWARE_ENCODE);
  }
}

export function ownedPreviewPath(root: string, candidate: string): string | null {
  if (!root || !candidate) return null;
  try {
    const rootReal = realpathSync(root);
    const abs = resolve(candidate);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return null;
    }
    const real = st.isSymbolicLink() ? realpathSync(abs) : realpathSync(abs);
    const rel = relative(rootReal, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    if (rel.split(/[/\\]/).some((part) => part === "..")) return null;
    return real;
  } catch {
    return null;
  }
}

export function previewFileName(side: "original" | "finished"): string {
  return side === "original" ? PREVIEW_ORIGINAL_FILE : PREVIEW_FINISHED_FILE;
}

export function parseByteRange(header: string | undefined, size: number):
  | { ok: true; start: number; end: number }
  | { ok: false } {
  if (!header) return { ok: true, start: 0, end: Math.max(0, size - 1) };
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { ok: false };
  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) return { ok: false };
  let start: number;
  let end: number;
  if (!hasStart) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = hasEnd ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return { ok: false };
  }
  return { ok: true, start, end: Math.min(end, size - 1) };
}

export async function publishPreviewPair(dir: string): Promise<boolean> {
  const original = join(dir, `.partial-${PREVIEW_ORIGINAL_FILE}`);
  const finished = join(dir, `.partial-${PREVIEW_FINISHED_FILE}`);
  const originalDest = join(dir, PREVIEW_ORIGINAL_FILE);
  const finishedDest = join(dir, PREVIEW_FINISHED_FILE);
  if (!(await fileSize(original)) || !(await fileSize(finished))) return false;
  await rename(original, originalDest);
  await rename(finished, finishedDest);
  await writeFile(join(dir, PREVIEW_PUBLISHED_MARKER), "");
  await removeReviewArtifact(join(dir, WORK_DIR_GUARD));
  return true;
}

export async function publishedPairValid(dir: string): Promise<boolean> {
  return publishedPairValidSync(dir);
}

export function publishedPairValidSync(dir: string): boolean {
  try {
    statSync(join(dir, PREVIEW_PUBLISHED_MARKER));
  } catch {
    return false;
  }
  return syncSize(join(dir, PREVIEW_ORIGINAL_FILE)) > 0 && syncSize(join(dir, PREVIEW_FINISHED_FILE)) > 0;
}

export async function publishedPairBytes(dir: string): Promise<number> {
  return publishedPairBytesSync(dir);
}

export function publishedPairBytesSync(dir: string): number {
  return syncSize(join(dir, PREVIEW_ORIGINAL_FILE)) + syncSize(join(dir, PREVIEW_FINISHED_FILE));
}

export function buildPreviewArtifact(input: {
  interval: { startMs: number; durationMs: number };
  originalAudioIndex: number;
  sidecarAudioIndex: number;
  size: MatchedPreviewSize;
  labels: PreviewTransformLabels;
}): PreviewArtifact {
  return {
    originalClipId: randomClipId("o"),
    finishedClipId: randomClipId("f"),
    originalFile: PREVIEW_ORIGINAL_FILE,
    finishedFile: PREVIEW_FINISHED_FILE,
    interval: input.interval,
    originalAudioIndex: input.originalAudioIndex,
    sidecarAudioIndex: input.sidecarAudioIndex,
    width: input.size.original.width,
    height: input.size.original.height,
    finishedWidth: input.size.finished.width,
    finishedHeight: input.size.finished.height,
    labels: input.labels,
  };
}

export function createPreviewRenderer(opts: {
  ffmpeg: string;
  ffprobe: string;
  encoder: () => Promise<PreviewH264Encoder | null>;
  vaapiDevice?: () => Promise<string | null | undefined>;
  runFile?: RunFile;
}): PreviewRenderer {
  const runFile = opts.runFile ?? defaultRunFile;
  return async (task, control) => {
    try {
      return await renderPreviewPair({
        ffmpeg: opts.ffmpeg,
        ffprobe: opts.ffprobe,
        encoder: await opts.encoder(),
        vaapiDevice: (await opts.vaapiDevice?.()) ?? null,
        task,
        control,
        runFile,
      });
    } catch (error) {
      if (error instanceof CancelledError) return { ok: false, error: "The preview was cancelled." };
      return { ok: false, error: error instanceof Error ? error.message : "The preview failed." };
    }
  };
}

export async function renderPreviewPair(input: {
  ffmpeg: string;
  ffprobe: string;
  encoder: PreviewH264Encoder | null;
  vaapiDevice?: string | null;
  task: RemotePreviewDocument;
  control: PreviewRendererControl;
  runFile?: RunFile;
}): Promise<{ ok: true; published: true } | { ok: false; error: string }> {
  const runFile = input.runFile ?? defaultRunFile;
  const plan = input.task.render;
  const cacheDir = plan?.cacheDir || input.task.cacheDir;
  if (!input.encoder) return { ok: false, error: PREVIEW_NO_SOFTWARE_ENCODE };
  if (!plan || !cacheDir) return { ok: false, error: "The preview task is missing a render plan." };
  if (input.control.isCancelled()) return { ok: false, error: "The preview was cancelled." };
  await mkdir(cacheDir, { recursive: true });
  await claimOptimizerWorkDir(cacheDir);
  const originalPartial = join(cacheDir, `.partial-${PREVIEW_ORIGINAL_FILE}`);
  const finishedPartial = join(cacheDir, `.partial-${PREVIEW_FINISHED_FILE}`);
  try {
    await renderOneClip({
      ffmpeg: input.ffmpeg,
      encoder: input.encoder,
      vaapiDevice: input.vaapiDevice,
      sourcePath: input.task.sourcePath,
      destPath: originalPartial,
      startMs: plan.startMs,
      durationMs: plan.durationMs,
      videoIndex: plan.originalVideoIndex,
      audioIndex: plan.originalAudioIndex,
      width: plan.originalWidth,
      height: plan.originalHeight,
      tonemap: plan.tonemap === true,
      siblingPath: finishedPartial,
      control: input.control,
      runFile,
      progressAt: 0.45,
    });
    if (input.control.isCancelled()) throw new CancelledError();
    await renderOneClip({
      ffmpeg: input.ffmpeg,
      encoder: input.encoder,
      vaapiDevice: input.vaapiDevice,
      sourcePath: input.task.sidecarPath,
      destPath: finishedPartial,
      startMs: plan.startMs,
      durationMs: plan.durationMs,
      videoIndex: plan.sidecarVideoIndex,
      audioIndex: plan.sidecarAudioIndex,
      width: plan.finishedWidth,
      height: plan.finishedHeight,
      tonemap: plan.tonemap === true,
      siblingPath: originalPartial,
      control: input.control,
      runFile,
      progressAt: 0.9,
    });
    const originalProbe = await probeClipFile(input.ffprobe, originalPartial, runFile);
    const finishedProbe = await probeClipFile(input.ffprobe, finishedPartial, runFile);
    if (!clipsMatchInterval(originalProbe, finishedProbe, plan.durationMs)) {
      return { ok: false, error: "The preview clips did not start together or were not playable." };
    }
    if (!(await publishPreviewPair(cacheDir))) return { ok: false, error: PREVIEW_PAIR_INCOMPLETE };
    input.control.onProgress(1);
    return { ok: true, published: true };
  } catch (error) {
    await removePreviewPairDir(cacheDir);
    if (error instanceof CancelledError) return { ok: false, error: "The preview was cancelled." };
    return { ok: false, error: error instanceof Error ? error.message : "The preview failed." };
  }
}

export async function defaultRunFile(
  bin: string,
  args: string[],
  opts: {
    timeoutMs: number;
    onSpawn?: (child: { kill: (signal?: NodeJS.Signals | number) => boolean | void }) => void;
    onStdout?: (text: string) => void;
    isCancelled?: () => boolean;
  },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child: ChildProcess = execFile(bin, args, {
      timeout: opts.timeoutMs,
      env: toolLocaleEnv(),
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      clearInterval(cancelWatch);
      if (opts.isCancelled?.()) {
        reject(new CancelledError());
        return;
      }
      if (error) {
        const err = error as { killed?: boolean; message?: string };
        if (err.killed) {
          reject(new Error(PREVIEW_SIZE_CAP));
          return;
        }
        reject(new Error(formatToolError(bin, { message: err.message, stderr, stdout })));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    opts.onSpawn?.(child);
    child.stdout?.on("data", (buf: Buffer) => opts.onStdout?.(buf.toString("utf8")));
    const cancelWatch = setInterval(() => {
      if (opts.isCancelled?.()) child.kill("SIGTERM");
    }, 200);
  });
}

function appendHwAccel(args: string[], encoder: PreviewH264Encoder, vaapiDevice?: string | null): void {
  if (encoder === "h264_nvenc") {
    args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
    return;
  }
  if (encoder === "h264_vaapi") {
    const device = vaapiDevice || "/dev/dri/renderD128";
    args.push("-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va", "-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi");
    return;
  }
  args.push("-hwaccel", "videotoolbox");
}

function scaleFilter(encoder: PreviewH264Encoder, width: number, height: number, tonemap = false): string {
  if (encoder === "h264_nvenc") {
    const map = tonemap ? "tonemap_cuda=tonemap=bt2390:desat=0:format=nv12," : "";
    return `${map}scale_cuda=w=${width}:h=${height}:format=nv12,hwdownload,format=nv12`;
  }
  if (encoder === "h264_vaapi") {
    const map = tonemap ? "tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709," : "";
    return `${map}scale_vaapi=w=${width}:h=${height}:format=nv12`;
  }
  const map = tonemap
    ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=nv12,"
    : "";
  return `${map}scale=${width}:${height},format=nv12`;
}

function appendEncoderSettings(args: string[], encoder: PreviewH264Encoder): void {
  if (encoder === "h264_nvenc") {
    args.push("-preset", "p5", "-profile:v", "high", "-rc", "cbr", "-b:v", "5M", "-maxrate", "8M", "-bufsize", "10M");
    return;
  }
  if (encoder === "h264_vaapi") {
    args.push("-profile:v", "high", "-rc_mode", "CBR", "-b:v", "5M", "-maxrate", "8M", "-bufsize", "10M");
    return;
  }
  args.push("-allow_sw", "0", "-realtime", "0", "-profile:v", "high", "-q:v", "65", "-pix_fmt", "nv12", "-b:v", "5M");
}

async function renderOneClip(input: {
  ffmpeg: string;
  encoder: PreviewH264Encoder;
  vaapiDevice?: string | null;
  sourcePath: string;
  destPath: string;
  startMs: number;
  durationMs: number;
  videoIndex: number;
  audioIndex: number;
  width: number;
  height: number;
  tonemap?: boolean;
  siblingPath: string;
  control: PreviewRendererControl;
  runFile: RunFile;
  progressAt: number;
}): Promise<void> {
  const args = buildClipArgs({
    sourcePath: input.sourcePath,
    destPath: input.destPath,
    encoder: input.encoder,
    vaapiDevice: input.vaapiDevice,
    startMs: input.startMs,
    durationMs: input.durationMs,
    videoIndex: input.videoIndex,
    audioIndex: input.audioIndex,
    width: input.width,
    height: input.height,
    tonemap: input.tonemap === true,
  });
  let child: { kill: (signal?: NodeJS.Signals) => boolean | void } | undefined;
  const watch = setInterval(() => {
    const total = syncSize(input.destPath) + syncSize(input.siblingPath);
    if (total > PREVIEW_PAIR_RESERVE_BYTES) {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Process may already have exited.
      }
    }
  }, 200);
  try {
    await input.runFile(input.ffmpeg, args, {
      timeoutMs: PREVIEW_TIMEOUT_MS,
      isCancelled: input.control.isCancelled,
      onSpawn: (spawned) => {
        child = spawned;
        input.control.registerChild(spawned);
      },
      onStdout: () => input.control.onProgress(input.progressAt),
    });
  } finally {
    clearInterval(watch);
  }
  if (syncSize(input.destPath) + syncSize(input.siblingPath) > PREVIEW_PAIR_RESERVE_BYTES) {
    throw new Error(PREVIEW_SIZE_CAP);
  }
  if (!(await fileSize(input.destPath))) throw new Error(PREVIEW_PAIR_INCOMPLETE);
}

async function probeClipFile(ffprobe: string, path: string, runFile: RunFile): Promise<ProbedClip> {
  const { stdout } = await runFile(ffprobe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path], {
    timeoutMs: 15_000,
  });
  const parsed: unknown = JSON.parse(stdout);
  const probe = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  return parseProbedClip(probe);
}

function audioChoice(track: AudioTrack): PreviewAudioChoice {
  return {
    index: track.index,
    language: track.language,
    channels: track.channels,
    codec: track.codec,
    default: track.default === true,
  };
}

function evenPixels(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function intOr(value: unknown, fallback: number): number {
  return Math.trunc(numberOr(value, fallback));
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function syncSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function randomClipId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
