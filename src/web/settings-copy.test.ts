import { describe, expect, it } from "vitest";
import { SIZE_CAP_GRID, hardwareBackendLabel, sizeCapLabel, transcodeBelowTargetLabel } from "./settings-copy";

describe("settings copy", () => {
  it("names size caps in everyday words", () => {
    expect(sizeCapLabel("movie1080p")).toBe("Movie 1080p");
    expect(sizeCapLabel("movie4kSdr")).toBe("Movie 4K SDR");
    expect(sizeCapLabel("movie4kHdr")).toBe("Movie 4K HDR");
    expect(sizeCapLabel("tv1080p")).toBe("TV 1080p");
    expect(sizeCapLabel("tv4k")).toBe("TV 4K SDR");
    expect(sizeCapLabel("tv4kHdr")).toBe("TV 4K HDR");
    expect(SIZE_CAP_GRID.flatMap((column) => column.cells.map((cell) => cell.key))).toEqual([
      "movie1080p", "movie4kSdr", "movie4kHdr", "tv1080p", "tv4k", "tv4kHdr",
    ]);
  });

  it("names the below-target checkbox after the current Encode Target", () => {
    expect(transcodeBelowTargetLabel("hevc")).toBe("Transcode video below Target Encode (HEVC)");
    expect(transcodeBelowTargetLabel("av1")).toBe("Transcode video below Target Encode (AV1)");
  });

  it("names encode APIs the same way Review does", () => {
    expect(hardwareBackendLabel("cuda")).toBe("CUDA");
    expect(hardwareBackendLabel("vaapi")).toBe("VAAPI");
    expect(hardwareBackendLabel("videotoolbox")).toBe("VideoToolbox");
    expect(hardwareBackendLabel("none")).toBe("none");
  });
});
