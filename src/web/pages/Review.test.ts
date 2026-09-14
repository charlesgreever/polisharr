import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PreviewStatus, ReviewRow } from "../api";
import { PREVIEW_LIMITS_COPY } from "../review-compare";
import { formatEncodeDuration, reviewEncodeLine } from "../review-copy";
import { CompareClipsView, frameFacts, keepAllConfirmCopy, keepStartedCopy } from "./Review.tsx";

function reviewRow(partial: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: "rev-1",
    displayTitle: "Film",
    status: "pending",
    flagged: false,
    flagReason: null,
    source: {
      codec: "truehd",
      sizeBytes: 1_000_000_000,
      sizePerHourGb: 8,
      durationSec: 3600,
      tracks: "1 audio / 0 subtitles",
      audio: [{ index: 1, language: "eng", channels: 8, codec: "truehd", default: true }],
    },
    sidecar: {
      codec: "aac",
      sizeBytes: 400_000_000,
      sizePerHourGb: 3,
      durationSec: 3600,
      tracks: "2 audio / 0 subtitles",
      audio: [
        { index: 1, language: "eng", channels: 8, codec: "truehd", default: true },
        { index: 2, language: "eng", channels: 2, codec: "aac" },
      ],
    },
    error: null,
    ...partial,
  };
}

function previewTask(partial: Partial<PreviewStatus> = {}): PreviewStatus {
  return {
    id: "prv-1",
    reviewId: "rev-1",
    status: "queued",
    waitReason: null,
    nodeId: null,
    nodeName: null,
    error: null,
    interval: { startMs: 360_000, durationMs: 15_000 },
    tracks: { originalAudioIndex: 1, sidecarAudioIndex: 2 },
    clips: null,
    transform: null,
    ...partial,
  };
}

const noop = () => undefined;

function renderCompare(partial: Partial<Parameters<typeof CompareClipsView>[0]> = {}) {
  return renderToStaticMarkup(createElement(CompareClipsView, {
    item: reviewRow(),
    task: null,
    sample: null,
    customClock: "0:00",
    originalAudioIndex: 1,
    sidecarAudioIndex: 2,
    audible: "original",
    viewSide: "original",
    layout: "split",
    onClose: noop,
    onSelectPreset: noop,
    onCustomClock: noop,
    onLoadCustom: noop,
    onOriginalAudio: noop,
    onSidecarAudio: noop,
    onAudible: noop,
    onViewSide: noop,
    onPlayPause: noop,
    onRetry: noop,
    onCancelPreview: noop,
    onKeep: noop,
    onDiscard: noop,
    onCancelWait: noop,
    ...partial,
  }));
}

describe("Keep all copy", () => {
  it("names the file count and that library files will be replaced", () => {
    expect(keepAllConfirmCopy(3)).toBe("Keep all 3 files? This replaces each library file with its new copy.");
    expect(keepAllConfirmCopy(1)).toBe("Keep all 1 file? This replaces each library file with its new copy.");
  });

  it("names accepted and skipped Keep counts", () => {
    expect(keepStartedCopy(3, 0)).toBe("Keep started for 3.");
    expect(keepStartedCopy(2, 1)).toBe("Keep started for 2; skipped 1.");
    expect(keepStartedCopy(1, 1, 2)).toBe("Keep started for 1; waiting for playback on 2; skipped 1.");
    expect(keepStartedCopy(0, 0, 2)).toBe("Waiting for playback on 2.");
  });

  it("names node, encode API, GPU, and duration without calling VAAPI QuickSync", () => {
    expect(formatEncodeDuration(48_000)).toBe("48 sec");
    expect(formatEncodeDuration(12 * 60_000)).toBe("12 min");
    expect(formatEncodeDuration(64 * 60_000)).toBe("1 hr 4 min");
    expect(reviewEncodeLine({
      nodeName: "deskmini",
      encodeApi: "VAAPI",
      gpuName: "Intel Battlemage G31",
      encodeMs: 12 * 60_000,
    })).toBe("Ran on deskmini · VAAPI · Intel Battlemage G31 · 12 min");
    expect(reviewEncodeLine({ encodeApi: "VAAPI" })).toBe("VAAPI");
    expect(reviewEncodeLine({ encodeApi: "VAAPI" })).not.toContain("QuickSync");
    expect(reviewEncodeLine({ encodeApi: "VideoToolbox", gpuName: "Apple M4 Pro" })).toBe("VideoToolbox · Apple M4 Pro");
    expect(reviewEncodeLine({})).toBeNull();
  });

  it("joins Now and Sidecar facts for the contact sheet", () => {
    expect(frameFacts({
      codec: "h264",
      sizeBytes: 1_000_000_000,
      sizePerHourGb: 2.5,
      durationSec: 3600,
      tracks: "1 audio / 0 subtitles",
    })).toContain("h264");
  });
});

describe("Compare clips dialog", () => {
  it("lists 10%, 50%, and 85% without starting clip generation", () => {
    const html = renderCompare();
    expect(html).toContain("10%");
    expect(html).toContain("50%");
    expect(html).toContain("85%");
    expect(html).toContain("Custom timestamp");
    expect(html).toContain("does not start that work until you choose one");
    expect(html).not.toContain("/clips/");
    expect(html).not.toContain("<video");
  });

  it("labels original and finished tracks, including an added stereo mix", () => {
    const html = renderCompare();
    expect(html).toContain("eng truehd 7.1");
    expect(html).toContain("eng aac stereo (added)");
    expect(html).toContain("Original audio");
    expect(html).toContain("Finished copy audio");
  });

  it("explains scaled picture, AAC downmix, and that clips do not prove native HDR or surround quality", () => {
    const html = renderCompare();
    expect(html).toContain(PREVIEW_LIMITS_COPY);
    expect(html).toContain("AAC stereo");
    expect(html).toContain("HDR to SDR");
    expect(html).toContain("do not prove native HDR or surround playback quality");
  });

  it("shows generating, playback-held, unavailable, and failed without hiding Keep or Discard", () => {
    expect(renderCompare({ task: previewTask({ status: "running", nodeName: "5090" }) })).toContain("Generating clips on 5090.");
    expect(renderCompare({ task: previewTask({ status: "running" }) })).toContain("Cancel preview");
    expect(renderCompare({ task: previewTask({ status: "queued", waitReason: "playback" }) })).toContain("Waiting for playback to finish.");
    const unavailable = renderCompare({
      task: previewTask({ status: "failed", error: "ISO sources cannot generate preview clips in this release." }),
      sample: "p10",
    });
    expect(unavailable).toContain("ISO sources cannot generate preview clips");
    expect(unavailable).toContain("Retry preview");
    expect(unavailable).toContain("Keep");
    expect(unavailable).toContain("Discard");
    const failed = renderCompare({
      task: previewTask({ status: "failed", error: "ffmpeg exited 1" }),
      sample: "p50",
    });
    expect(failed).toContain("ffmpeg exited 1");
    expect(failed).toContain("Retry preview");
  });

  it("renders ready clips and the actual interval", () => {
    const html = renderCompare({
      task: previewTask({
        status: "ready",
        interval: { startMs: 360_000, durationMs: 15_000 },
        transform: {
          scale: "1280×720",
          audio: "AAC stereo (downmixed for browser playback)",
          color: "SDR",
          warnings: [],
        },
      }),
    });
    expect(html).toContain("Actual clip 6:00–6:15 (15s).");
    expect(html).toContain("/api/review/rev-1/previews/prv-1/clips/original");
    expect(html).toContain("/api/review/rev-1/previews/prv-1/clips/finished");
    expect(html).toContain("Polisharr scaled the picture to 1280×720.");
    expect(html).toContain("Playing audio");
    expect(html).toContain("Finished copy");
  });

  it("uses A/B labels on a narrow layout and keeps one audible side named", () => {
    const html = renderCompare({ layout: "ab", viewSide: "finished", audible: "finished" });
    expect(html).toContain("Show original");
    expect(html).toContain("Show finished copy");
    expect(html).toContain("Hear original");
    expect(html).toContain("Hear finished copy");
    expect(html).toContain("aria-pressed=\"true\"");
  });

  it("keeps Keep and Discard available on a waiting card after a preview failure", () => {
    const html = renderCompare({
      item: reviewRow({ status: "waiting", cancellable: true }),
      task: previewTask({ status: "failed", error: "No encode node can generate H.264 preview clips." }),
      sample: "p85",
    });
    expect(html).toContain("Retry preview");
    expect(html).toContain("Cancel wait");
    expect(html).toContain("Discard");
    expect(html).toContain("Waiting…");
  });
});
