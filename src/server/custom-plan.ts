import { isIsoPath, isUntaggedLanguage } from "./inspect.ts";
import { languageDisplayName } from "./language-id.ts";
import { is4k, sizeCategory } from "./suggest.ts";
import type {
  AudioOp,
  CustomPlanDraft,
  CustomPlanResult,
  ExecutablePlan,
  HardwareInfo,
  InspectionReport,
  LibraryItem,
  PlanFieldError,
  Settings,
  SubtitleOp,
  VideoIntent,
  VideoTarget,
  WriteMode,
} from "./types.ts";
import { keepWritesLanguage, planHasVideoTranscode } from "./types.ts";

export type CustomPlanInput = {
  item: LibraryItem;
  report: InspectionReport;
  settings: Settings;
  hardware: HardwareInfo;
  draft: CustomPlanDraft;
  av1Available?: boolean;
};

export function validateCustomPlan(input: CustomPlanInput): CustomPlanResult {
  const errors: PlanFieldError[] = [];
  const { item, report, settings, hardware, draft } = input;
  const av1Available = input.av1Available ?? hardware.av1;
  const listed = report.listingState === "complete";
  const iso = isIsoPath(item.path);
  const videoDraft = draft.video ?? { mode: "copy" as const };
  const write = resolveWriteMode(settings.writeMode, draft.writeMode);
  const writeMode = write.writeMode;

  if (!listed && draft.audio?.some((c) => c.action !== "keep")) {
    errors.push({ field: "audio", message: "Track edits are unavailable until streams can be listed." });
  }
  if (!listed && draft.subtitles?.some((c) => c.action !== "keep")) {
    errors.push({ field: "subtitles", message: "Track edits are unavailable until streams can be listed." });
  }

  const audioOps = listed ? buildAudioOps(report, draft.audio ?? [], errors) : report.audio.map(keepAudioOp);
  const subOps = listed ? buildSubtitleOps(report, draft.subtitles ?? [], errors) : report.subtitles.map(keepSubtitleOp);
  const video = buildVideo(item, report, hardware, videoDraft, errors, av1Available);

  const remux = iso && (draft.remuxToMkv !== false);
  const trackWork = audioOps.some((op) => op.op !== "keep") || subOps.some((op) => op.op !== "keep");
  const languageWork = audioOps.some(keepWritesLanguage) || subOps.some(keepWritesLanguage);
  const videoWork = video.kind !== "copy";
  const hasWork = remux || trackWork || videoWork || languageWork;
  if (!hasWork) {
    errors.push({ field: "plan", message: "This plan does not change the file. Choose a track, remux, or encode option before Queue." });
  }

  if (errors.length) return { ok: false, errors };

  const plan: ExecutablePlan = {
    origin: "custom",
    video,
    audio: audioOps,
    subtitles: subOps,
    container: "mkv",
    remuxInput: false,
    writeMode,
    writeModeLocked: write.locked,
    warning: videoWarning(report, video),
    reasons: planReasons({ iso: remux, video, audio: audioOps, subtitles: subOps, writeMode, globalWrite: settings.writeMode, report }),
    estimatedOutputBytes: estimateOutputBytes(report, video),
    category: sizeCategory(item, report),
  };
  void planHasVideoTranscode(plan);
  return { ok: true, plan };
}

export function estimateOutputBytes(report: InspectionReport, video: VideoIntent): number | null {
  if (video.kind === "copy") return report.sizeBytes;
  if (video.kind === "size") return video.targetBytes;
  const pixels = Math.max(1, report.width * report.height);
  const sourcePixels = pixels;
  const outPixels = video.downscale1080p ? Math.min(pixels, 1920 * 1080) : pixels;
  const codecFactor = video.codec === "av1" ? 0.72 : 0.88;
  const quality = clamp(video.quality, 1, 51);
  const qualityFactor = (52 - quality) / 51;
  const scale = outPixels / sourcePixels;
  const raw = report.sizeBytes * codecFactor * qualityFactor * scale;
  return Math.round(clamp(raw, report.sizeBytes * 0.05, report.sizeBytes * 0.98));
}

function resolveWriteMode(globalMode: WriteMode, override: CustomPlanDraft["writeMode"]): { writeMode: WriteMode; locked: boolean } {
  if (override === "sidecar" || override === "direct") return { writeMode: override, locked: true };
  return { writeMode: globalMode, locked: false };
}

function buildVideo(
  item: LibraryItem,
  report: InspectionReport,
  hardware: HardwareInfo,
  draft: NonNullable<CustomPlanDraft["video"]>,
  errors: PlanFieldError[],
  av1Available = hardware.av1,
): VideoIntent {
  if (draft.mode === "copy") {
    if (draft.downscale1080p) {
      errors.push({ field: "video.downscale1080p", message: "4K to 1080p needs a size or quality encode. A remux cannot downscale." });
    }
    return { kind: "copy" };
  }
  const codec: VideoTarget = draft.codec ?? "hevc";
  if (codec === "av1" && !av1Available) {
    errors.push({ field: "video.codec", message: "AV1 encode is hidden because no encode node can encode AV1." });
  }
  const downscale = Boolean(draft.downscale1080p);
  if (downscale && !is4k(item, report)) {
    errors.push({ field: "video.downscale1080p", message: "4K to 1080p is only available for a 4K source." });
  }
  if (draft.mode === "size") {
    const sourceBytes = Math.max(report.sizeBytes, item.sizeBytes, 1);
    if (!(draft.targetBytes > 0) || draft.targetBytes < 1_000_000 || draft.targetBytes > sourceBytes * 4) {
      errors.push({ field: "video.targetBytes", message: "Enter a target file size greater than 1 MB and not wildly larger than the source." });
    }
    return { kind: "size", codec, targetBytes: draft.targetBytes, downscale1080p: downscale, bitDepth: report.bitDepth };
  }
  if (!(draft.quality >= 1 && draft.quality <= 51)) {
    errors.push({ field: "video.quality", message: "Encoder quality must be between 1 (larger) and 51 (smaller)." });
  }
  return { kind: "quality", codec, quality: draft.quality, downscale1080p: downscale, bitDepth: report.bitDepth };
}

function buildAudioOps(report: InspectionReport, choices: NonNullable<CustomPlanDraft["audio"]>, errors: PlanFieldError[]): AudioOp[] {
  const byIndex = new Map(report.audio.map((t) => [t.index, t]));
  const ops: AudioOp[] = report.audio.map(keepAudioOp);
  for (const choice of choices) {
    const track = byIndex.get(choice.index);
    if (!track) {
      errors.push({ field: `audio.${choice.index}`, message: "That audio track is not in this file." });
      continue;
    }
    const slot = ops.findIndex((op) => op.index === choice.index);
    if (choice.action === "keep") continue;
    if (choice.action === "remove") {
      ops[slot] = { op: "remove", index: choice.index };
      continue;
    }
    if (choice.action === "replace_aac") {
      if (choice.channels != null && choice.channels !== track.channels) {
        errors.push({ field: `audio.${choice.index}`, message: "A same-layout AAC change must keep the original channel count." });
      }
      ops[slot] = { op: "replace_aac", index: choice.index };
      continue;
    }
    const channels = choice.channels ?? 2;
    if (!validDownmix(track.channels, channels)) {
      errors.push({ field: `audio.${choice.index}`, message: "A downmix can only go to a smaller layout, such as 5.1 or stereo." });
      continue;
    }
    if (choice.action === "replace_downmix") ops[slot] = { op: "replace_downmix", index: choice.index, channels };
    if (choice.action === "add_downmix") ops.push({ op: "add_downmix", index: choice.index, channels });
  }
  if (!ops.some((op) => op.op !== "remove")) {
    errors.push({ field: "audio", message: "Keep at least one usable audio track so the file is not silent." });
  }
  return ops;
}

function buildSubtitleOps(report: InspectionReport, choices: NonNullable<CustomPlanDraft["subtitles"]>, errors: PlanFieldError[]): SubtitleOp[] {
  const known = new Set(report.subtitles.map((t) => t.index));
  const ops: SubtitleOp[] = report.subtitles.map(keepSubtitleOp);
  for (const choice of choices) {
    if (!known.has(choice.index)) {
      errors.push({ field: `subtitles.${choice.index}`, message: "That subtitle track is not in this file." });
      continue;
    }
    const slot = ops.findIndex((op) => op.index === choice.index);
    if (choice.action === "remove" && slot >= 0) ops[slot] = { op: "remove", index: choice.index };
  }
  return ops;
}

function keepAudioOp(track: InspectionReport["audio"][number]): AudioOp {
  if (track.languagePending && !isUntaggedLanguage(track.language)) {
    return { op: "keep", index: track.index, language: track.language };
  }
  return { op: "keep", index: track.index };
}

function keepSubtitleOp(track: InspectionReport["subtitles"][number]): SubtitleOp {
  if (track.languagePending && !isUntaggedLanguage(track.language)) {
    return { op: "keep", index: track.index, language: track.language };
  }
  return { op: "keep", index: track.index };
}

function validDownmix(from: number, to: number): boolean {
  if (to >= from) return false;
  return to === 6 || to === 2;
}

function videoWarning(report: InspectionReport, video: VideoIntent): string | null {
  if (video.kind === "copy") return null;
  if (report.hdr === "dolby_vision" || report.hdr === "hdr10plus") {
    return "Dolby Vision or HDR10+ metadata may be lost when this file is re-encoded.";
  }
  return null;
}

function planReasons(input: {
  iso: boolean;
  video: VideoIntent;
  audio: AudioOp[];
  subtitles: SubtitleOp[];
  writeMode: WriteMode;
  globalWrite: WriteMode;
  report: InspectionReport;
}): string[] {
  const reasons: string[] = [];
  if (input.iso && input.video.kind === "copy") reasons.push("Remux the disc image into a Matroska file without changing the video.");
  if (input.video.kind === "size") {
    reasons.push(`Encode video to ${input.video.codec.toUpperCase()} targeting a ${formatBytes(input.video.targetBytes)} file.`);
    if (input.video.downscale1080p) reasons.push("Downscale 4K video to 1080p.");
  }
  if (input.video.kind === "quality") {
    reasons.push(`Encode video to ${input.video.codec.toUpperCase()} with encoder quality ${input.video.quality}.`);
    if (input.video.downscale1080p) reasons.push("Downscale 4K video to 1080p.");
  }
  for (const op of input.audio) {
    const track = input.report.audio.find((t) => t.index === op.index);
    const name = trackLabel(track?.title || track?.language || `track ${op.index}`);
    if (op.op === "keep" && keepWritesLanguage(op) && op.language) {
      reasons.push(`Write ${languageDisplayName(op.language)} on audio ${name}.`);
    }
    if (op.op === "remove") reasons.push(`Remove audio ${name}.`);
    if (op.op === "replace_aac") reasons.push(`Replace audio ${name} with AAC at the same channel layout.`);
    if (op.op === "replace_downmix") reasons.push(`Replace audio ${name} with an AAC ${layoutName(op.channels)} downmix.`);
    if (op.op === "add_downmix") reasons.push(`Add an AAC ${layoutName(op.channels)} downmix from audio ${name}.`);
  }
  for (const op of input.subtitles) {
    const track = input.report.subtitles.find((t) => t.index === op.index);
    const name = trackLabel(track?.title || track?.language || `track ${op.index}`);
    if (op.op === "keep" && keepWritesLanguage(op) && op.language) {
      reasons.push(`Write ${languageDisplayName(op.language)} on subtitle ${name}.`);
    }
    if (op.op !== "remove") continue;
    reasons.push(`Remove subtitle ${name}.`);
  }
  if (input.writeMode !== input.globalWrite) {
    reasons.push(input.writeMode === "direct"
      ? "Write this job directly over the library file after an integrity check."
      : "Write this job as a sidecar for Review, even though the house default is direct write.");
  } else if (input.writeMode === "direct") {
    reasons.push("Write directly over the library file after an integrity check.");
  }
  return reasons;
}

function trackLabel(value: string): string {
  return value.trim() || "track";
}

function layoutName(channels: number): string {
  if (channels >= 8) return "7.1";
  if (channels >= 6) return "5.1";
  return "stereo";
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
