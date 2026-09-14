import { formatClipClock, parseClipClock } from "./title-plan";
import { channelLabel } from "./title-display";
import type { PreviewStatus, ReviewAudioTrack, ReviewRow } from "./api";

export const PREVIEW_CLIP_MS = 15_000;
export const PREVIEW_DRIFT_MS = 250;
export const PREVIEW_POLL_MS = 1000;
export const COMPARE_AB_MAX_PX = 640;

export const PREVIEW_LIMITS_COPY =
  "These clips support review. They do not prove native HDR or surround playback quality. Polisharr scales the picture, encodes AAC stereo (downmixed for the browser), and converts HDR to SDR when it can generate a pair. Those steps can hide or introduce differences.";

export const PREVIEW_KEYBOARD_COPY =
  "Space plays or pauses. 1 hears the original. 2 hears the finished copy. Left and right arrows seek.";

export const PREVIEW_PRESETS = [
  { id: "p10", label: "10%", fraction: 0.1 },
  { id: "p50", label: "50%", fraction: 0.5 },
  { id: "p85", label: "85%", fraction: 0.85 },
] as const;

export type PreviewPresetId = (typeof PREVIEW_PRESETS)[number]["id"];
export type PreviewSample = PreviewPresetId | "custom";
export type CompareSide = "original" | "finished";
export type CompareLayout = "split" | "ab";
export type PreviewUiKind =
  | "idle"
  | "queued"
  | "playback-held"
  | "generating"
  | "unavailable"
  | "failed"
  | "ready"
  | "cancelled";

export function canCompareStatus(status: ReviewRow["status"]): boolean {
  return status === "pending" || status === "waiting";
}

export function compareLayout(widthPx: number): CompareLayout {
  return widthPx < COMPARE_AB_MAX_PX ? "ab" : "split";
}

export function commonDurationMs(item: Pick<ReviewRow, "source" | "sidecar">): number {
  return Math.round(Math.min(item.source.durationSec, item.sidecar.durationSec) * 1000);
}

export function presetStartMs(fraction: number, durationMs: number, clipMs = PREVIEW_CLIP_MS): number {
  if (!(durationMs > 0)) return 0;
  const raw = Math.round(fraction * durationMs);
  const maxStart = Math.max(0, durationMs - clipMs);
  return Math.min(Math.max(0, raw), maxStart);
}

export function customStartMs(clock: string, durationMs: number): number | null {
  const sec = parseClipClock(clock);
  if (sec == null || sec < 0) return null;
  const startMs = Math.round(sec * 1000);
  if (startMs >= durationMs) return null;
  return startMs;
}

export function previewRequestBody(input: {
  sample: PreviewSample | null;
  customClock: string;
  durationMs: number;
  originalAudioIndex: number | null;
  sidecarAudioIndex: number | null;
}): {
  startMs: number;
  durationMs: number;
  originalAudioIndex: number | null;
  sidecarAudioIndex: number | null;
  preset: "custom";
} | null {
  if (input.sample == null) return null;
  const preset = PREVIEW_PRESETS.find((row) => row.id === input.sample);
  const startMs = preset
    ? presetStartMs(preset.fraction, input.durationMs)
    : customStartMs(input.customClock, input.durationMs);
  if (startMs == null) return null;
  return {
    startMs,
    durationMs: PREVIEW_CLIP_MS,
    originalAudioIndex: input.originalAudioIndex,
    sidecarAudioIndex: input.sidecarAudioIndex,
    preset: "custom",
  };
}

export function actualIntervalCopy(interval: { startMs: number; durationMs: number } | null | undefined): string | null {
  if (!interval) return null;
  const start = formatClipClock(interval.startMs / 1000);
  const end = formatClipClock((interval.startMs + interval.durationMs) / 1000);
  const seconds = Math.max(1, Math.round(interval.durationMs / 1000));
  return `Actual clip ${start}–${end} (${seconds}s).`;
}

export function previewClipUrl(reviewId: string, taskId: string, side: CompareSide): string {
  return `/api/review/${encodeURIComponent(reviewId)}/previews/${encodeURIComponent(taskId)}/clips/${side}`;
}

export function isUnavailablePreview(error: string | null | undefined): boolean {
  if (!error) return false;
  return /unavailable|ISO sources cannot|No encode node can generate|needs playable video|at least one second/i.test(error);
}

export function previewUiKind(task: PreviewStatus | null): PreviewUiKind {
  if (!task) return "idle";
  if (task.status === "ready") return "ready";
  if (task.status === "running") return "generating";
  if (task.status === "cancelled" || task.status === "expired") return "cancelled";
  if (task.status === "failed") return isUnavailablePreview(task.error) ? "unavailable" : "failed";
  if (task.status === "queued" && task.waitReason === "playback") return "playback-held";
  return "queued";
}

export function previewStatusCopy(task: PreviewStatus | null): string {
  const kind = previewUiKind(task);
  if (kind === "idle") {
    return "Pick a sample to generate matching clips. Polisharr does not start that work until you choose one.";
  }
  if (kind === "generating") {
    return task?.nodeName ? `Generating clips on ${task.nodeName}.` : "Generating clips.";
  }
  if (kind === "playback-held") return "Waiting for playback to finish.";
  if (kind === "ready") return "Clips are ready.";
  if (kind === "unavailable") return task?.error ?? "This preview is unavailable.";
  if (kind === "failed") return task?.error ?? "Preview generation failed.";
  if (task?.status === "expired") return "This preview expired. Pick a sample to generate a new pair.";
  if (kind === "cancelled") return "Preview cancelled. The finished copy is still here for Keep or Discard.";
  if (task?.waitReason === "node") return "Queued until an H.264 preview node is free.";
  if (task?.waitReason === "input_lock") return "Waiting until Keep or Discard finishes with this file.";
  if (task?.waitReason === "cache_capacity") return "Waiting for preview cache space.";
  return "Queued.";
}

export function previewTransformLines(transform: PreviewStatus["transform"] | null | undefined): string[] {
  const scale = transform?.scale
    ? `Polisharr scaled the picture to ${transform.scale}.`
    : "Polisharr scales the picture to fit the browser and never upscales.";
  const audio = transform?.audio
    ? (transform.audio.endsWith(".") ? transform.audio : `${transform.audio}.`)
    : "Audio is AAC stereo, downmixed for browser playback.";
  const color = transform?.color && /hdr/i.test(transform.color)
    ? `Color: ${transform.color}.`
    : "Polisharr converts HDR to SDR when it can generate a pair.";
  return [scale, audio, color, ...(transform?.warnings ?? [])];
}

export function defaultPreviewAudio(
  original: ReviewAudioTrack[],
  sidecar: ReviewAudioTrack[],
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

function trackKey(track: ReviewAudioTrack): string {
  return `${track.language}|${track.channels}|${track.codec}`;
}

export function previewTrackOption(
  track: ReviewAudioTrack,
  role: CompareSide,
  counterpart: ReviewAudioTrack[],
): string {
  const language = !track.language || track.language === "und" ? "untagged" : track.language;
  const base = `${language} ${track.codec} ${channelLabel(track.channels)}`;
  const found = counterpart.some((other) => trackKey(other) === trackKey(track));
  if (role === "original" && !found) return `${base} (removed from the finished copy)`;
  if (role === "finished" && !found) return `${base} (added)`;
  return base;
}

export function selectionAfterRemoval(
  selected: Record<string, boolean> | undefined,
  removedIds: Iterable<string>,
): Record<string, boolean> {
  const drop = new Set(removedIds);
  const next: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(selected ?? {})) {
    if (on && !drop.has(id)) next[id] = true;
  }
  return next;
}

export function shouldCancelPreview(status: PreviewStatus["status"] | undefined): boolean {
  return status === "queued" || status === "running" || status === "ready";
}

export async function cancelPreviewThen<T>(input: {
  task: Pick<PreviewStatus, "id" | "status"> | null;
  cancel: () => Promise<unknown>;
  mutate: () => Promise<T>;
}): Promise<T> {
  if (input.task && shouldCancelPreview(input.task.status)) {
    try {
      await input.cancel();
    } catch {
      // Keep and Discard still run; the server waits for preview readers.
    }
  }
  return input.mutate();
}

export type CompareHotkey =
  | { action: "playpause" }
  | { action: "audible"; side: CompareSide }
  | { action: "view"; side: CompareSide }
  | { action: "seek"; deltaSec: number }
  | { action: "close" };

export function compareHotkey(key: string): CompareHotkey | null {
  if (key === "Escape") return { action: "close" };
  if (key === " " || key === "k") return { action: "playpause" };
  if (key === "1" || key === "o") return { action: "audible", side: "original" };
  if (key === "2" || key === "f") return { action: "audible", side: "finished" };
  if (key === "ArrowLeft") return { action: "seek", deltaSec: -2 };
  if (key === "ArrowRight") return { action: "seek", deltaSec: 2 };
  if (key === "[") return { action: "view", side: "original" };
  if (key === "]") return { action: "view", side: "finished" };
  return null;
}

export function createExclusiveRunner() {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined;
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    },
  };
}

export type LinkedPlayerEvent =
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "seek"; timeSec: number }
  | { type: "waiting"; side: CompareSide }
  | { type: "ready"; side: CompareSide }
  | { type: "audible"; side: CompareSide }
  | { type: "tick"; originalTimeSec: number; finishedTimeSec: number };

export type LinkedPlayerState = {
  wantPlaying: boolean;
  originalWaiting: boolean;
  finishedWaiting: boolean;
  originalMuted: boolean;
  finishedMuted: boolean;
  audible: CompareSide;
  seekToSec: number | null;
  pauseOriginal: boolean;
  pauseFinished: boolean;
};

export function initialLinkedPlayer(audible: CompareSide = "original"): LinkedPlayerState {
  return applyPauseFlags({
    wantPlaying: false,
    originalWaiting: false,
    finishedWaiting: false,
    originalMuted: audible !== "original",
    finishedMuted: audible !== "finished",
    audible,
    seekToSec: null,
    pauseOriginal: true,
    pauseFinished: true,
  });
}

function applyPauseFlags(state: LinkedPlayerState): LinkedPlayerState {
  const blocked = state.originalWaiting || state.finishedWaiting;
  const pause = !state.wantPlaying || blocked;
  return { ...state, pauseOriginal: pause, pauseFinished: pause };
}

export function reduceLinkedPlayer(state: LinkedPlayerState, event: LinkedPlayerEvent): LinkedPlayerState {
  if (event.type === "play") return applyPauseFlags({ ...state, wantPlaying: true });
  if (event.type === "pause") return applyPauseFlags({ ...state, wantPlaying: false });
  if (event.type === "toggle") return applyPauseFlags({ ...state, wantPlaying: !state.wantPlaying });
  if (event.type === "seek") {
    return applyPauseFlags({
      ...state,
      seekToSec: Math.max(0, event.timeSec),
      originalWaiting: true,
      finishedWaiting: true,
    });
  }
  if (event.type === "waiting") {
    return applyPauseFlags({
      ...state,
      originalWaiting: event.side === "original" ? true : state.originalWaiting,
      finishedWaiting: event.side === "finished" ? true : state.finishedWaiting,
    });
  }
  if (event.type === "ready") {
    return applyPauseFlags({
      ...state,
      originalWaiting: event.side === "original" ? false : state.originalWaiting,
      finishedWaiting: event.side === "finished" ? false : state.finishedWaiting,
      seekToSec: null,
    });
  }
  if (event.type === "audible") {
    return {
      ...state,
      audible: event.side,
      originalMuted: event.side !== "original",
      finishedMuted: event.side !== "finished",
    };
  }
  if (state.originalWaiting || state.finishedWaiting || state.seekToSec != null) return state;
  const driftMs = Math.abs(event.originalTimeSec - event.finishedTimeSec) * 1000;
  if (driftMs <= PREVIEW_DRIFT_MS) return state;
  const target = state.audible === "original" ? event.originalTimeSec : event.finishedTimeSec;
  return applyPauseFlags({
    ...state,
    seekToSec: Math.max(0, target),
    originalWaiting: true,
    finishedWaiting: true,
  });
}

export function audibleSides(state: Pick<LinkedPlayerState, "originalMuted" | "finishedMuted">): CompareSide[] {
  const sides: CompareSide[] = [];
  if (!state.originalMuted) sides.push("original");
  if (!state.finishedMuted) sides.push("finished");
  return sides;
}
