import { describe, expect, it } from "vitest";
import { suggestionTrackComparison } from "./tracks.ts";
import type { InspectionReport, Suggestion } from "./types.ts";

const report: InspectionReport = {
  sourceSig: "p|1",
  sourceMethod: "ffprobe",
  listingState: "complete",
  durationSec: 1369,
  sizeBytes: 1_000_000_000,
  sizePerHourGb: 2.4,
  videoCodec: "hevc",
  width: 1920,
  height: 1080,
  bitDepth: 8,
  hdr: "none",
  audio: [{ index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false }],
  subtitles: [],
  hasChapters: false,
  hasAttachments: false,
};

function suggestion(patch: Partial<Suggestion> = {}): Suggestion {
  return {
    id: "s1",
    itemId: "e1",
    actions: ["add_stereo"],
    reasons: [],
    warning: null,
    category: "tv1080p",
    estimatedSavingsBytes: null,
    now: { codec: "hevc", quality: "HD", sizeBytes: 1, sizePerHourGb: 2.4 },
    after: { codec: "hevc", quality: null, sizeBytes: null, sizePerHourGb: null },
    dismissed: false,
    keepAudio: [1],
    stripAudio: [],
    keepSubs: [],
    stripSubs: [],
    ...patch,
  };
}

describe("suggestion track comparison", () => {
  it("shows added stereo when the original mix stays", () => {
    expect(suggestionTrackComparison(report, suggestion()).afterTracks).toEqual([
      "Audio: eng ac3 5.1",
      "Audio: AAC 2.0 (added)",
    ]);
  });

  it("shows replaced stereo when surround is dropped", () => {
    expect(suggestionTrackComparison(report, suggestion({
      actions: ["tracks", "add_stereo"],
      keepAudio: [],
      stripAudio: [1],
      stereoSource: 1,
    })).afterTracks).toEqual(["Audio: AAC 2.0 (replaced)"]);
  });

  it("does not keep included stereo on a Prefer stereo replacement", () => {
    const withStereo: InspectionReport = {
      ...report,
      audio: [
        { index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
        { index: 2, language: "eng", channels: 2, codec: "aac", title: "Commentary", untagged: false, commentary: true },
      ],
    };
    expect(suggestionTrackComparison(withStereo, suggestion({
      actions: ["tracks", "add_stereo"],
      keepAudio: [],
      stripAudio: [1, 2],
      stereoSource: 1,
    })).afterTracks).toEqual(["Audio: AAC 2.0 (replaced)"]);
  });
});
