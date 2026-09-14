import { describe, expect, it } from "vitest";
import type { PreviewStatus, ReviewAudioTrack } from "./api";
import {
  actualIntervalCopy,
  audibleSides,
  canCompareStatus,
  cancelPreviewThen,
  commonDurationMs,
  compareHotkey,
  compareLayout,
  createExclusiveRunner,
  customStartMs,
  defaultPreviewAudio,
  initialLinkedPlayer,
  isUnavailablePreview,
  PREVIEW_DRIFT_MS,
  PREVIEW_LIMITS_COPY,
  presetStartMs,
  previewClipUrl,
  previewRequestBody,
  previewStatusCopy,
  previewTrackOption,
  previewTransformLines,
  previewUiKind,
  reduceLinkedPlayer,
  selectionAfterRemoval,
  shouldCancelPreview,
} from "./review-compare";

function track(index: number, partial: Partial<ReviewAudioTrack> = {}): ReviewAudioTrack {
  return { index, language: "eng", channels: 2, codec: "aac", default: false, ...partial };
}

function task(partial: Partial<PreviewStatus> = {}): PreviewStatus {
  return {
    id: "prv-1",
    reviewId: "rev-1",
    status: "queued",
    waitReason: null,
    nodeId: null,
    nodeName: null,
    error: null,
    interval: { startMs: 6_000, durationMs: 15_000 },
    tracks: { originalAudioIndex: 1, sidecarAudioIndex: 2 },
    clips: null,
    transform: null,
    ...partial,
  };
}

describe("compare request timing", () => {
  it("does not build a preview request until a sample is chosen", () => {
    expect(previewRequestBody({
      sample: null,
      customClock: "1:00",
      durationMs: 3_600_000,
      originalAudioIndex: 1,
      sidecarAudioIndex: 1,
    })).toBeNull();
  });

  it("sends 10%, 50%, and 85% starts and clamps so a 15s clip still fits", () => {
    expect(presetStartMs(0.1, 60_000)).toBe(6_000);
    expect(presetStartMs(0.5, 60_000)).toBe(30_000);
    expect(presetStartMs(0.85, 60_000)).toBe(45_000);
    expect(previewRequestBody({
      sample: "p10",
      customClock: "",
      durationMs: 60_000,
      originalAudioIndex: 2,
      sidecarAudioIndex: 3,
    })).toEqual({
      startMs: 6_000,
      durationMs: 15_000,
      originalAudioIndex: 2,
      sidecarAudioIndex: 3,
      preset: "custom",
    });
  });

  it("accepts a custom clock and rejects a timestamp at the end of the file", () => {
    expect(customStartMs("1:23", 120_000)).toBe(83_000);
    expect(customStartMs("2:00", 120_000)).toBeNull();
    expect(previewRequestBody({
      sample: "custom",
      customClock: "0:12",
      durationMs: 60_000,
      originalAudioIndex: null,
      sidecarAudioIndex: null,
    })).toMatchObject({ startMs: 12_000, preset: "custom" });
  });
});

describe("preview status and labels", () => {
  it("names queued, playback-held, generating, unavailable, failed, and ready", () => {
    expect(previewUiKind(null)).toBe("idle");
    expect(previewUiKind(task({ status: "queued" }))).toBe("queued");
    expect(previewUiKind(task({ status: "queued", waitReason: "playback" }))).toBe("playback-held");
    expect(previewUiKind(task({ status: "running" }))).toBe("generating");
    expect(previewUiKind(task({ status: "failed", error: "ISO sources cannot generate preview clips in this release." }))).toBe("unavailable");
    expect(previewUiKind(task({ status: "failed", error: "ffmpeg exited 1" }))).toBe("failed");
    expect(previewUiKind(task({ status: "ready" }))).toBe("ready");
    expect(previewStatusCopy(null)).toContain("does not start that work until you choose one");
    expect(previewStatusCopy(task({ waitReason: "node" }))).toBe("Queued until an H.264 preview node is free.");
    expect(previewStatusCopy(task({ status: "queued", waitReason: "playback" }))).toBe("Waiting for playback to finish.");
    expect(previewStatusCopy(task({ status: "running", nodeName: "5090" }))).toBe("Generating clips on 5090.");
    expect(isUnavailablePreview("No encode node can generate H.264 preview clips.")).toBe(true);
  });

  it("shows the actual interval and clip URLs from the response", () => {
    expect(actualIntervalCopy({ startMs: 6_000, durationMs: 15_000 })).toBe("Actual clip 0:06–0:21 (15s).");
    expect(previewClipUrl("rev-1", "prv-1", "original")).toBe("/api/review/rev-1/previews/prv-1/clips/original");
    expect(commonDurationMs({
      source: { codec: "hevc", sizeBytes: 1, sizePerHourGb: 1, durationSec: 100, tracks: "" },
      sidecar: { codec: "hevc", sizeBytes: 1, sizePerHourGb: 1, durationSec: 80, tracks: "" },
    })).toBe(80_000);
  });

  it("labels scaled picture, AAC downmix, and HDR-to-SDR without claiming native quality", () => {
    expect(PREVIEW_LIMITS_COPY).toContain("do not prove native HDR or surround playback quality");
    expect(PREVIEW_LIMITS_COPY).toContain("AAC stereo");
    expect(PREVIEW_LIMITS_COPY).toContain("converts HDR to SDR");
    expect(previewTransformLines({
      scale: "1280×720",
      audio: "AAC stereo (downmixed for browser playback)",
      color: "SDR",
      warnings: ["The original and finished copies have different display aspect ratios. Neither image is stretched."],
    })).toEqual([
      "Polisharr scaled the picture to 1280×720.",
      "AAC stereo (downmixed for browser playback).",
      "Polisharr converts HDR to SDR when it can generate a pair.",
      "The original and finished copies have different display aspect ratios. Neither image is stretched.",
    ]);
  });

  it("marks added and removed audio tracks and defaults to original surround plus added stereo", () => {
    const original = [track(1, { channels: 8, codec: "truehd", default: true })];
    const finished = [
      track(1, { channels: 8, codec: "truehd", default: true }),
      track(2, { channels: 2, codec: "aac" }),
    ];
    expect(defaultPreviewAudio(original, finished)).toEqual({ originalAudioIndex: 1, sidecarAudioIndex: 2 });
    expect(previewTrackOption(original[0]!, "original", finished)).toBe("eng truehd 7.1");
    expect(previewTrackOption(finished[1]!, "finished", original)).toBe("eng aac stereo (added)");
    expect(previewTrackOption(original[0]!, "original", [track(2)])).toBe("eng truehd 7.1 (removed from the finished copy)");
  });
});

describe("linked playback", () => {
  it("plays and pauses both sides and keeps one audio element audible", () => {
    let state = initialLinkedPlayer("original");
    expect(audibleSides(state)).toEqual(["original"]);
    state = reduceLinkedPlayer(state, { type: "play" });
    expect(state.pauseOriginal).toBe(false);
    expect(state.pauseFinished).toBe(false);
    state = reduceLinkedPlayer(state, { type: "audible", side: "finished" });
    expect(audibleSides(state)).toEqual(["finished"]);
    state = reduceLinkedPlayer(state, { type: "pause" });
    expect(state.pauseOriginal).toBe(true);
    expect(state.pauseFinished).toBe(true);
  });

  it("pauses both sides while either is buffering", () => {
    let state = reduceLinkedPlayer(initialLinkedPlayer(), { type: "play" });
    state = reduceLinkedPlayer(state, { type: "waiting", side: "original" });
    expect(state.pauseOriginal).toBe(true);
    expect(state.pauseFinished).toBe(true);
    state = reduceLinkedPlayer(state, { type: "ready", side: "original" });
    expect(state.pauseOriginal).toBe(false);
    expect(state.pauseFinished).toBe(false);
  });

  it("resynchronizes when drift exceeds 250 ms and uses the audible side as the clock", () => {
    let state = reduceLinkedPlayer(initialLinkedPlayer("original"), { type: "play" });
    state = reduceLinkedPlayer(state, { type: "tick", originalTimeSec: 1, finishedTimeSec: 1 + (PREVIEW_DRIFT_MS / 1000) });
    expect(state.seekToSec).toBeNull();
    state = reduceLinkedPlayer(state, { type: "tick", originalTimeSec: 1, finishedTimeSec: 1.4 });
    expect(state.seekToSec).toBe(1);
    expect(state.pauseOriginal).toBe(true);
    expect(state.pauseFinished).toBe(true);
    state = reduceLinkedPlayer(initialLinkedPlayer("finished"), { type: "play" });
    state = reduceLinkedPlayer(state, { type: "tick", originalTimeSec: 1, finishedTimeSec: 1.4 });
    expect(state.seekToSec).toBe(1.4);
  });

  it("seeks both sides together", () => {
    const state = reduceLinkedPlayer(initialLinkedPlayer(), { type: "seek", timeSec: 8 });
    expect(state.seekToSec).toBe(8);
    expect(state.pauseOriginal).toBe(true);
    expect(state.pauseFinished).toBe(true);
  });
});

describe("keyboard, layout, and Keep coordination", () => {
  it("maps keyboard controls for play, audio, seek, A/B, and close", () => {
    expect(compareHotkey(" ")).toEqual({ action: "playpause" });
    expect(compareHotkey("1")).toEqual({ action: "audible", side: "original" });
    expect(compareHotkey("2")).toEqual({ action: "audible", side: "finished" });
    expect(compareHotkey("ArrowLeft")).toEqual({ action: "seek", deltaSec: -2 });
    expect(compareHotkey("[")).toEqual({ action: "view", side: "original" });
    expect(compareHotkey("Escape")).toEqual({ action: "close" });
  });

  it("uses side-by-side on desktop and A/B on a narrow viewport", () => {
    expect(compareLayout(1024)).toBe("split");
    expect(compareLayout(390)).toBe("ab");
  });

  it("offers Compare clips on pending and waiting cards only", () => {
    expect(canCompareStatus("pending")).toBe(true);
    expect(canCompareStatus("waiting")).toBe(true);
    expect(canCompareStatus("keeping")).toBe(false);
  });

  it("keeps other selected rows after a Keep or Discard", () => {
    expect(selectionAfterRemoval({ a: true, b: true, c: false }, ["a"])).toEqual({ b: true });
  });

  it("cancels an active preview before Keep or Discard and still mutates when cancel fails", async () => {
    expect(shouldCancelPreview("queued")).toBe(true);
    expect(shouldCancelPreview("failed")).toBe(false);
    const mutate = async () => "kept";
    await expect(cancelPreviewThen({
      task: { id: "prv-1", status: "running" },
      cancel: async () => {
        throw new Error("preview already gone");
      },
      mutate,
    })).resolves.toBe("kept");
  });

  it("skips overlapping status polls", async () => {
    const runner = createExclusiveRunner();
    let release: () => void = () => undefined;
    const first = runner.run(() => new Promise<string>((resolve) => {
      release = () => resolve("one");
    }));
    const second = await runner.run(async () => "two");
    expect(second).toBeUndefined();
    release();
    expect(await first).toBe("one");
  });
});
