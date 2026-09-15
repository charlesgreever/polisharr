import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_DIR_NAME,
  PREVIEW_FINISHED_FILE,
  PREVIEW_ORIGINAL_FILE,
  PREVIEW_PUBLISHED_MARKER,
  WORK_DIR_GUARD,
  cleanReviewLeftovers,
  previewPairDir,
} from "./optimize.ts";
import {
  PREVIEW_CLIP_TOO_SHORT,
  PREVIEW_DV_UNAVAILABLE,
  PREVIEW_HDR10PLUS_UNAVAILABLE,
  PREVIEW_HDR_UNAVAILABLE,
  PREVIEW_INVALID_START,
  PREVIEW_NO_SOFTWARE_ENCODE,
  PREVIEW_PAIR_RESERVE_BYTES,
  assertHardwareVideoEncoder,
  buildClipArgs,
  clipsMatchInterval,
  defaultPreviewAudio,
  matchedPreviewSize,
  normalizePreviewInterval,
  ownedPreviewPath,
  parseByteRange,
  parsePreviewMedia,
  parseProbedClip,
  previewCacheKey,
  previewColorDecision,
  publishPreviewPair,
  publishedPairValidSync,
  renderPreviewPair,
  resolvePreviewAudioIndex,
} from "./preview-render.ts";
import { PREVIEW_PROTOCOL_VERSION, PREVIEW_SDR_1080P_PROFILE } from "./cluster.ts";

describe("preview interval normalization", () => {
  it("clamps presets so a full clip fits on short media", () => {
    expect(normalizePreviewInterval({ preset: "start" }, 10_000)).toEqual({ ok: true, startMs: 0, durationMs: 10_000 });
    expect(normalizePreviewInterval({ preset: "end" }, 20_000)).toEqual({ ok: true, startMs: 5_000, durationMs: 15_000 });
    expect(normalizePreviewInterval({ preset: "middle" }, 20_000)).toEqual({ ok: true, startMs: 2_500, durationMs: 15_000 });
  });

  it("rejects timestamps past the common duration", () => {
    expect(normalizePreviewInterval({ startMs: 20_000 }, 20_000)).toMatchObject({ ok: false, error: PREVIEW_INVALID_START });
    expect(normalizePreviewInterval({ startMs: 19_500, durationMs: 15_000 }, 20_000)).toMatchObject({
      ok: false,
      error: PREVIEW_CLIP_TOO_SHORT,
    });
  });
});

describe("preview scale and color", () => {
  it("picks the smaller 1080p-capped size and never upscales", () => {
    const fourK = matchedPreviewSize(
      { width: 3840, height: 2160, sarNum: 1, sarDen: 1 },
      { width: 1920, height: 1080, sarNum: 1, sarDen: 1 },
    );
    expect(fourK.original).toEqual({ width: 1920, height: 1080 });
    expect(fourK.finished).toEqual({ width: 1920, height: 1080 });
    const hd = matchedPreviewSize(
      { width: 1280, height: 720, sarNum: 1, sarDen: 1 },
      { width: 1920, height: 1080, sarNum: 1, sarDen: 1 },
    );
    expect(hd.original).toEqual({ width: 1280, height: 720 });
    expect(hd.finished).toEqual({ width: 1280, height: 720 });
  });

  it("reports differing display aspect ratios instead of stretching", () => {
    const size = matchedPreviewSize(
      { width: 720, height: 480, sarNum: 8, sarDen: 9 },
      { width: 1920, height: 1080, sarNum: 1, sarDen: 1 },
    );
    expect(size.sarMismatch).toBe(true);
    expect(size.original.width / size.original.height).toBeCloseTo(4 / 3, 1);
    expect(size.finished.width / size.finished.height).toBeCloseTo(16 / 9, 1);
    expect(size.label).toContain("×");
  });

  it("converts matching HDR10 pairs and still blocks mixed HDR, HDR10+, and Dolby Vision", () => {
    expect(previewColorDecision({ hdr: "hdr10" }, { hdr: "hdr10" })).toEqual({ ok: true, color: "hdr10-to-sdr" });
    expect(previewColorDecision({ hdr: "hdr10" }, { hdr: "none" })).toEqual({ ok: false, error: PREVIEW_HDR_UNAVAILABLE });
    expect(previewColorDecision({ hdr: "hdr10plus" }, { hdr: "none" })).toEqual({ ok: false, error: PREVIEW_HDR10PLUS_UNAVAILABLE });
    expect(previewColorDecision({ hdr: "dolby_vision" }, { hdr: "none" })).toEqual({ ok: false, error: PREVIEW_DV_UNAVAILABLE });
    expect(previewColorDecision({ hdr: "none" }, { hdr: "none" })).toEqual({ ok: true, color: "sdr" });
  });
});

describe("preview audio indexes", () => {
  it("uses stream indexes, not display-list positions", () => {
    const original = [
      { index: 2, language: "eng", channels: 6, codec: "ac3", default: true },
      { index: 4, language: "eng", channels: 2, codec: "aac", default: false },
    ];
    const sidecar = [
      { index: 1, language: "eng", channels: 6, codec: "ac3", default: false },
      { index: 3, language: "eng", channels: 2, codec: "aac", default: true },
    ];
    expect(defaultPreviewAudio(original, sidecar)).toEqual({ originalAudioIndex: 2, sidecarAudioIndex: 1 });
    expect(resolvePreviewAudioIndex(original, 4, 2)).toBe(4);
    expect(resolvePreviewAudioIndex(original, 0, 2)).toBeNull();
  });

  it("pairs original surround with added stereo", () => {
    const original = [{ index: 1, language: "eng", channels: 8, codec: "truehd", default: true }];
    const sidecar = [
      { index: 1, language: "eng", channels: 8, codec: "truehd", default: true },
      { index: 2, language: "eng", channels: 2, codec: "aac", default: false },
    ];
    expect(defaultPreviewAudio(original, sidecar)).toEqual({ originalAudioIndex: 1, sidecarAudioIndex: 2 });
  });
});

describe("preview ffmpeg commands", () => {
  it("builds a finite argument array with accurate seek, timestamp reset, and AAC stereo", () => {
    const args = buildClipArgs({
      sourcePath: "/media/movie.mkv",
      destPath: "/review/.previews/p/original.mp4",
      encoder: "h264_nvenc",
      startMs: 12_500,
      durationMs: 15_000,
      videoIndex: 0,
      audioIndex: 2,
      width: 1280,
      height: 720,
    });
    expect(args.includes("/bin/sh")).toBe(false);
    expect(args.join(" ")).not.toMatch(/libx264|libx265/);
    expect(args).toContain("-accurate_seek");
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("-avoid_negative_ts");
    expect(args).toContain("make_zero");
    expect(args).toContain("-start_at_zero");
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-ac", "2"]));
    expect(args).toEqual(expect.arrayContaining(["-map", "0:0", "-map", "0:2"]));
    expect(args).toContain("scale_cuda=w=1280:h=720:format=nv12,hwdownload,format=nv12");
    expect(args.at(-1)).toBe("/review/.previews/p/original.mp4");
    expect(() => assertHardwareVideoEncoder([...args.slice(0, -1), "libx264", "out.mp4"])).toThrow(PREVIEW_NO_SOFTWARE_ENCODE);
  });

  it("applies the same CUDA BT.2390 tonemap on HDR10 clips before scale", () => {
    const args = buildClipArgs({
      sourcePath: "/media/hdr.mkv",
      destPath: "/review/.previews/p/original.mp4",
      encoder: "h264_nvenc",
      startMs: 0,
      durationMs: 15_000,
      videoIndex: 0,
      audioIndex: 1,
      width: 1920,
      height: 800,
      tonemap: true,
    });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("tonemap_cuda=tonemap=bt2390");
    expect(vf).toContain("scale_cuda=w=1920:h=800:format=nv12");
    expect(args.join(" ")).not.toMatch(/libx264/);
  });
});

describe("preview pair publication", () => {
  it("publishes both clips together and cleans a one-sided failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-preview-pub-"));
    const pair = previewPairDir(dir, "prv-1");
    mkdirSync(pair, { recursive: true });
    writeFileSync(join(pair, WORK_DIR_GUARD), "");
    writeFileSync(join(pair, `.partial-${PREVIEW_ORIGINAL_FILE}`), "orig");
    writeFileSync(join(pair, `.partial-${PREVIEW_FINISHED_FILE}`), "fin");
    expect(await publishPreviewPair(pair)).toBe(true);
    expect(publishedPairValidSync(pair)).toBe(true);
    expect(existsSync(join(pair, WORK_DIR_GUARD))).toBe(false);
    expect(existsSync(join(pair, PREVIEW_PUBLISHED_MARKER))).toBe(true);

    const partial = previewPairDir(dir, "prv-2");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, `.partial-${PREVIEW_ORIGINAL_FILE}`), "only-one");
    expect(await publishPreviewPair(partial)).toBe(false);
    expect(existsSync(join(partial, PREVIEW_ORIGINAL_FILE))).toBe(false);

    await cleanReviewLeftovers(dir);
    expect(existsSync(join(dir, PREVIEW_DIR_NAME, "prv-1", PREVIEW_ORIGINAL_FILE))).toBe(true);
    expect(existsSync(partial)).toBe(false);
  });

  it("refuses a symlink that escapes the preview root", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-preview-own-"));
    const root = join(dir, PREVIEW_DIR_NAME);
    const pair = join(root, "prv-1");
    mkdirSync(pair, { recursive: true });
    const outside = join(dir, "secret.mp4");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(pair, PREVIEW_ORIGINAL_FILE));
    expect(ownedPreviewPath(root, join(pair, PREVIEW_ORIGINAL_FILE))).toBeNull();
    writeFileSync(join(pair, PREVIEW_FINISHED_FILE), "ok");
    expect(ownedPreviewPath(root, join(pair, PREVIEW_FINISHED_FILE))).toBe(join(pair, PREVIEW_FINISHED_FILE));
  });
});

describe("preview probes and cache keys", () => {
  it("requires matching presentation starts within 250 ms", () => {
    const clip = { durationMs: 15_000, startMs: 0, hasH264: true, hasAac: true, audioChannels: 2 };
    expect(clipsMatchInterval(clip, { ...clip, startMs: 200 }, 15_000)).toBe(true);
    expect(clipsMatchInterval(clip, { ...clip, startMs: 400 }, 15_000)).toBe(false);
    expect(clipsMatchInterval(clip, { ...clip, hasAac: false }, 15_000)).toBe(false);
  });

  it("changes the cache key when audio or source revision changes", () => {
    const base = {
      reviewId: "rev-1",
      sourceRevision: "a:1:1:1",
      sidecarRevision: "b:1:1:1",
      startMs: 0,
      durationMs: 15_000,
      originalAudioIndex: 1,
      sidecarAudioIndex: 1,
    };
    expect(previewCacheKey(base)).toBe(previewCacheKey({ ...base }));
    expect(previewCacheKey(base)).not.toBe(previewCacheKey({ ...base, originalAudioIndex: 2 }));
    expect(previewCacheKey(base)).not.toBe(previewCacheKey({ ...base, sourceRevision: "a:2:2:2" }));
  });

  it("parses SAR from ffprobe and byte ranges", () => {
    const media = parsePreviewMedia("/a.mkv", 10, {
      format: { duration: "60" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "hevc", width: 720, height: 480, sample_aspect_ratio: "8:9" },
        { index: 1, codec_type: "audio", codec_name: "ac3", channels: 6, tags: { language: "eng" } },
      ],
    });
    expect(media.sarNum).toBe(8);
    expect(media.sarDen).toBe(9);
    expect(parseProbedClip({
      format: { duration: "15.0", start_time: "0.01" },
      streams: [
        { codec_type: "video", codec_name: "h264", duration: "15" },
        { codec_type: "audio", codec_name: "aac", channels: 2 },
      ],
    })).toMatchObject({ hasH264: true, hasAac: true, startMs: 10 });
    expect(parseByteRange("bytes=0-10", 100)).toEqual({ ok: true, start: 0, end: 10 });
    expect(parseByteRange("bytes=50-", 100)).toEqual({ ok: true, start: 50, end: 99 });
    expect(parseByteRange("bytes=200-300", 100).ok).toBe(false);
  });
});

describe("preview renderer", () => {
  it("renders both sides sequentially and does not publish a one-sided success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-preview-run-"));
    const cacheDir = previewPairDir(dir, "prv-1");
    const calls: string[][] = [];
    let ffmpegCalls = 0;
    const result = await renderPreviewPair({
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      encoder: "h264_nvenc",
      task: {
        kind: "preview",
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        id: "prv-1",
        leaseToken: "tok",
        leaseUntil: 2_000,
        reviewId: "rev-1",
        sourcePath: join(dir, "orig.mkv"),
        sidecarPath: join(dir, "fin.mkv"),
        request: { startMs: 0, durationMs: 15_000, originalAudioIndex: 1, sidecarAudioIndex: 1 },
        profileId: PREVIEW_SDR_1080P_PROFILE,
        nodeId: "worker-1",
        cacheDir,
        render: {
          cacheDir,
          startMs: 0,
          durationMs: 15_000,
          originalVideoIndex: 0,
          sidecarVideoIndex: 0,
          originalAudioIndex: 1,
          sidecarAudioIndex: 1,
          originalWidth: 1280,
          originalHeight: 720,
          finishedWidth: 1280,
          finishedHeight: 720,
        },
      },
      control: { isCancelled: () => false, onProgress: () => undefined, registerChild: () => undefined },
      runFile: async (bin, args) => {
        calls.push([bin, ...args]);
        if (bin === "ffmpeg") {
          ffmpegCalls += 1;
          if (ffmpegCalls === 2) throw new Error("second clip failed");
          const dest = args.at(-1);
          if (dest) writeFileSync(dest, "clip");
          return { stdout: "out_time_us=15000000\n", stderr: "" };
        }
        return {
          stdout: JSON.stringify({
            format: { duration: "15", start_time: "0" },
            streams: [
              { codec_type: "video", codec_name: "h264" },
              { codec_type: "audio", codec_name: "aac", channels: 2 },
            ],
          }),
          stderr: "",
        };
      },
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(cacheDir, PREVIEW_ORIGINAL_FILE))).toBe(false);
    expect(existsSync(join(cacheDir, PREVIEW_PUBLISHED_MARKER))).toBe(false);
    expect(calls.some((row) => row[0] === "ffmpeg" && row.includes("libx264"))).toBe(false);
  });

  it("kills the encode when the pair size cap is exceeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-preview-cap-"));
    const cacheDir = previewPairDir(dir, "prv-cap");
    let killed = false;
    const result = await renderPreviewPair({
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      encoder: null,
      task: {
        kind: "preview",
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        id: "prv-cap",
        leaseToken: "tok",
        leaseUntil: 2_000,
        reviewId: "rev-1",
        sourcePath: join(dir, "orig.mkv"),
        sidecarPath: join(dir, "fin.mkv"),
        request: { startMs: 0, durationMs: 15_000, originalAudioIndex: 1, sidecarAudioIndex: 1 },
        profileId: PREVIEW_SDR_1080P_PROFILE,
        nodeId: "worker-1",
        cacheDir,
        render: {
          cacheDir,
          startMs: 0,
          durationMs: 15_000,
          originalVideoIndex: 0,
          sidecarVideoIndex: 0,
          originalAudioIndex: 1,
          sidecarAudioIndex: 1,
          originalWidth: 1280,
          originalHeight: 720,
          finishedWidth: 1280,
          finishedHeight: 720,
        },
      },
      control: {
        isCancelled: () => false,
        onProgress: () => undefined,
        registerChild: (child) => {
          child.kill = () => {
            killed = true;
            return true;
          };
        },
      },
    });
    expect(result).toMatchObject({ ok: false, error: PREVIEW_NO_SOFTWARE_ENCODE });
    expect(killed).toBe(false);
    expect(PREVIEW_PAIR_RESERVE_BYTES).toBe(128 * 1024 * 1024);
  });
});
