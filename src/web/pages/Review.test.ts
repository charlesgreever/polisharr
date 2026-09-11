import { describe, expect, it } from "vitest";
import { frameFacts, keepAllConfirmCopy, keepStartedCopy } from "./Review.tsx";
import { formatEncodeDuration, reviewEncodeLine } from "../review-copy";

describe("Keep all copy", () => {
  it("names the file count and that library files will be replaced", () => {
    expect(keepAllConfirmCopy(3)).toBe("Keep all 3 files? This replaces each library file with its new copy.");
    expect(keepAllConfirmCopy(1)).toBe("Keep all 1 file? This replaces each library file with its new copy.");
  });

  it("names accepted and skipped Keep counts", () => {
    expect(keepStartedCopy(3, 0)).toBe("Keep started for 3.");
    expect(keepStartedCopy(2, 1)).toBe("Keep started for 2; skipped 1.");
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
