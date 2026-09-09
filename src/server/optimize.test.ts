import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  audioAacArgs,
  encodeArgs,
  ffmpegOptimizer,
  isTextSubtitleCodec,
  subtitleEncodeArgs,
  formatToolError,
  isoCopyMaps,
  isoDemuxArgs,
  isoInputAttempts,
  isoRemuxArgs,
  isoRemuxIsShort,
  muxArgs,
  muxPlanArgs,
  nvencBitrate,
  optimizeSteps,
  toolLocaleEnv,
  parseFfmpegProgress,
  parseMkvmergeProgress,
  planFromSuggestion,
  scaleProgress,
  assertReviewCapacity,
  shouldSkipSizeEncode,
} from "./optimize.ts";
import { videoBitrateForTarget } from "./size-budget.ts";
import type { OptimizeRequest } from "./optimize.ts";
import type { InspectionReport, Suggestion } from "./types.ts";

const suggestion: Suggestion = {
  id: "s1",
  itemId: "m1",
  actions: ["tracks", "add_stereo"],
  reasons: [],
  warning: null,
  category: "movie4kHdr",
  estimatedSavingsBytes: null,
  now: { codec: "hevc", quality: "Bluray-2160p", sizeBytes: 1, sizePerHourGb: 8 },
  after: { codec: "hevc", quality: null, sizeBytes: null, sizePerHourGb: null },
  dismissed: false,
  keepAudio: [1, 2],
  stripAudio: [],
  keepSubs: [3, 4],
  stripSubs: [],
};

const source =
  "/mnt/nas/Kids Movies/Big Hero 6 (2014)/Big Hero 6 (2014) {imdb-tt2245084}[Bluray-2160p][HDR][10bit][HEVC][TrueHD Atmos 7.1].mkv";

describe("mkvmerge arguments", () => {
  it("keeps a parenthesized source path as one operand and applies track options to that file", () => {
    const args = muxArgs(
      source,
      "/mnt/nas/review-path/.work/out.mkv",
      { ...suggestion, keepAudio: [1], stripAudio: [2], keepSubs: [3], stripSubs: [4] },
      "/tmp/stereo.aac",
    );
    expect(args).toContain(source);
    expect(args.filter((part) => part.includes("Big Hero 6")).length).toBe(1);
    const sourceAt = args.indexOf(source);
    const audioAt = args.indexOf("--audio-tracks");
    const subsAt = args.indexOf("--subtitle-tracks");
    const stereoAt = args.indexOf("/tmp/stereo.aac");
    expect(audioAt).toBeGreaterThan(-1);
    expect(audioAt).toBeLessThan(sourceAt);
    expect(subsAt).toBeLessThan(sourceAt);
    expect(stereoAt).toBeGreaterThan(sourceAt);
    expect(args.join(" ")).not.toContain("mkvmerge -o");
  });

  it("writes a pending soundtrack language onto the source file during a copy remux", () => {
    const plan = planFromSuggestion({ ...suggestion, actions: ["tracks"], keepAudio: [1], stripAudio: [2], keepSubs: [3, 4], stripSubs: [] });
    plan.audio = [{ op: "keep", index: 1, language: "eng" }, { op: "remove", index: 2 }];
    const args = muxPlanArgs(source, "/tmp/out.mkv", plan);
    const langAt = args.indexOf("--language");
    const sourceAt = args.indexOf(source);
    expect(args[langAt + 1]).toBe("1:eng");
    expect(langAt).toBeGreaterThan(-1);
    expect(langAt).toBeLessThan(sourceAt);
  });

  it("tags a downmix extra with the source audio language", () => {
    const plan = planFromSuggestion({ ...suggestion, actions: ["add_stereo"], keepAudio: [1], stripAudio: [] });
    const args = muxPlanArgs(source, "/tmp/out.mkv", plan, [{ path: "/tmp/stereo.aac", language: "eng" }]);
    const langAt = args.indexOf("--language");
    const stereoAt = args.indexOf("/tmp/stereo.aac");
    expect(args[langAt + 1]).toBe("0:eng");
    expect(langAt).toBeGreaterThan(args.indexOf(source));
    expect(langAt).toBeLessThan(stereoAt);
  });

  it("replaces the only surround track with stereo instead of keeping the original mix", () => {
    const plan = planFromSuggestion({
      ...suggestion,
      actions: ["tracks", "add_stereo"],
      keepAudio: [],
      stripAudio: [1],
      stereoSource: 1,
    });
    expect(plan.audio).toEqual([{ op: "replace_downmix", index: 1, channels: 2 }]);
    const args = muxPlanArgs(source, "/tmp/out.mkv", plan, [{ path: "/tmp/stereo.aac", language: "eng" }]);
    expect(args).toContain("--no-audio");
    expect(args).not.toContain("--audio-tracks");
    expect(args.indexOf("--no-audio")).toBeLessThan(args.indexOf(source));
    expect(args.indexOf("/tmp/stereo.aac")).toBeGreaterThan(args.indexOf(source));
  });

  it("does not expose an unquoted command line when a tool fails", () => {
    const message = formatToolError("mkvmerge", {
      message: `Command failed: mkvmerge -o out.mkv ${source}`,
      stderr: "Error: The file could not be opened.",
    });
    expect(message).toContain("mkvmerge failed");
    expect(message).toContain("The file could not be opened.");
    expect(message).not.toContain("Command failed:");
  });

  it("keeps a useful mkvmerge error written to standard output", () => {
    const output = {
      stderr: "",
      stdout: "Error: The source file type is unsupported.\n",
    };

    const message = formatToolError("mkvmerge", output);

    expect(message).toBe("mkvmerge failed. Error: The source file type is unsupported.");
  });

  it("runs mkvmerge with a UTF-8 locale so JSON identify is not truncated", async () => {
    expect(toolLocaleEnv()).toMatchObject({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
    const dir = await mkdtemp(join(tmpdir(), "polisharr-mkvmerge-locale-"));
    try {
      const sourcePath = join(dir, "episode.mkv");
      const reviewDir = join(dir, "review");
      const mkvmerge = join(dir, "mkvmerge.cjs");
      const ffprobe = join(dir, "ffprobe.cjs");
      const ffmpeg = join(dir, "ffmpeg.cjs");
      await writeFile(sourcePath, "source");
      await writeFile(ffmpeg, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.argv.at(-1), 'stereo');",
      ].join("\n"));
      await writeFile(mkvmerge, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const utf8 = /UTF-8/i.test(process.env.LC_ALL || process.env.LANG || '');",
        "const args = process.argv.slice(2);",
        "if (args.includes('-J')) {",
        "  if (!utf8) { process.stdout.write('{\"tracks\":[{\"id\":0,\"type\":\"video\",\"properties\":{\"title\":\"'); process.exit(0); }",
        "  process.stdout.write(JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio' }, { id: 2, type: 'subtitles' }] }));",
        "  process.exit(0);",
        "}",
        "if (!utf8) process.exit(2);",
        "fs.writeFileSync(args[args.indexOf('-o') + 1], 'muxed');",
        "process.stdout.write('Progress: 100%\\n');",
      ].join("\n"));
      await writeFile(ffprobe, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const muxed = fs.readFileSync(process.argv.at(-1), 'utf8') === 'muxed';",
        "process.stdout.write(JSON.stringify({",
        "  format: { duration: '120' },",
        "  streams: [",
        "    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, bits_per_raw_sample: '8' },",
        "    { index: 1, codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng' } },",
        "    ...(muxed ? [{ index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } }] : []),",
        "    { index: muxed ? 3 : 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }",
        "  ]",
        "}));",
      ].join("\n"));
      await Promise.all([chmod(mkvmerge, 0o755), chmod(ffprobe, 0o755), chmod(ffmpeg, 0o755)]);
      const optimizer = ffmpegOptimizer({ capacity: async () => 10 * 1024 ** 3 });
      const result = await optimizer({
        sourcePath,
        reviewDir,
        plan: planFromSuggestion({
          ...suggestion,
          actions: ["tracks", "add_stereo"],
          keepAudio: [1],
          stripAudio: [],
          keepSubs: [2],
          stripSubs: [],
        }),
        report: {
          sourceSig: "episode.mkv|13",
          sourceMethod: "ffprobe",
          listingState: "complete",
          durationSec: 120,
          sizeBytes: 13,
          sizePerHourGb: 0.001,
          videoCodec: "hevc",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [{ index: 1, language: "eng", channels: 6, codec: "eac3", title: "", untagged: false, commentary: false }],
          subtitles: [{ index: 2, language: "eng", codec: "subrip", title: "烧烤", untagged: false, forced: false, sdh: false }],
          hasChapters: false,
          hasAttachments: false,
        },
        target: "hevc",
        backend: "none",
        ffmpeg,
        ffprobe,
        mkvmerge,
        conservative: false,
      });
      expect(result.sidecarPath.endsWith(".mkv")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the selected MP4 caption when ffprobe and mkvmerge track IDs differ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polisharr-mkvmerge-warning-"));
    try {
      const sourcePath = join(dir, "episode.mp4");
      const reviewDir = join(dir, "review");
      const mkvmerge = join(dir, "mkvmerge.cjs");
      const ffprobe = join(dir, "ffprobe.cjs");
      const ffmpeg = join(dir, "ffmpeg.cjs");
      await writeFile(sourcePath, "source with captions");
      await writeFile(ffmpeg, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.argv.at(-1), 'captions');",
      ].join("\n"));
      await writeFile(mkvmerge, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args.includes('-J')) {",
        "  process.stdout.write(JSON.stringify({ tracks: [",
        "    { id: 0, type: 'video' },",
        "    { id: 1, type: 'audio' },",
        "    { id: 2, type: 'subtitles' },",
        "    { id: 3, type: 'subtitles' }",
        "  ] }));",
        "} else {",
        "  const selected = args.includes('--subtitle-tracks') ? args[args.indexOf('--subtitle-tracks') + 1] : null;",
        "  const keptCaptions = selected === null || selected.split(',').includes('2');",
        "  fs.writeFileSync(args[args.indexOf('-o') + 1], keptCaptions ? 'captions' : 'no captions');",
        "  process.stdout.write(keptCaptions",
        "    ? 'Warning: The MP4 timestamps required normalization.\\nProgress: 100%\\n'",
        "    : 'Warning: A subtitle track ID was requested but not found.\\nProgress: 100%\\n');",
        "  process.exitCode = 1;",
        "}",
      ].join("\n"));
      await writeFile(ffprobe, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const captions = fs.readFileSync(process.argv.at(-1), 'utf8') === 'captions';",
        "process.stdout.write(JSON.stringify({",
        "  format: { duration: '120' },",
        "  streams: [",
        "    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, bits_per_raw_sample: '8' },",
        "    ...(captions ? [{ index: 1, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }] : [])",
        "  ]",
        "}));",
      ].join("\n"));
      await Promise.all([chmod(mkvmerge, 0o755), chmod(ffprobe, 0o755), chmod(ffmpeg, 0o755)]);

      const optimizer = ffmpegOptimizer({ capacity: async () => 10 * 1024 ** 3 });
      const remux = planFromSuggestion({
        ...suggestion,
        actions: ["remux"],
        keepAudio: [],
        stripAudio: [],
        keepSubs: [4],
        stripSubs: [5],
      });
      const result = await optimizer({
        sourcePath,
        reviewDir,
        plan: remux,
        report: {
          sourceSig: "episode.mp4|13",
          sourceMethod: "ffprobe",
          listingState: "complete",
          durationSec: 120,
          sizeBytes: 13,
          sizePerHourGb: 0.001,
          videoCodec: "h264",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [],
          subtitles: [
            { index: 4, language: "eng", codec: "mov_text", title: "English", untagged: false, forced: false, sdh: false },
            { index: 5, language: "spa", codec: "mov_text", title: "Spanish", untagged: false, forced: false, sdh: false },
          ],
          hasChapters: false,
          hasAttachments: false,
        },
        target: "hevc",
        backend: "none",
        ffmpeg,
        ffprobe,
        mkvmerge,
        conservative: false,
      });

      expect(result.sidecarPath).toBe(join(reviewDir, "episode.mkv"));
      expect(result.output.durationSec).toBe(120);
      expect(result.output.subtitles).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("converts a kept MP4 timed-text track to SubRip before HEVC encode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polisharr-sub-convert-"));
    try {
      const sourcePath = join(dir, "otter.mp4");
      const reviewDir = join(dir, "review");
      const mkvmerge = join(dir, "mkvmerge.cjs");
      const ffprobe = join(dir, "ffprobe.cjs");
      const ffmpeg = join(dir, "ffmpeg.cjs");
      await writeFile(sourcePath, "mp4");
      await writeFile(ffmpeg, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const dest = args.at(-1);",
        "if (dest.endsWith('.srt')) { fs.writeFileSync(dest, 'converted-captions'); process.exit(0); }",
        "if (!args.includes('srt') && !args.includes('copy')) process.exit(2);",
        "const input = args[args.indexOf('-i') + 1];",
        "fs.writeFileSync(dest, 'encoded:' + fs.readFileSync(input, 'utf8'));",
      ].join("\n"));
      await writeFile(mkvmerge, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args.includes('-J')) {",
        "  process.stdout.write(JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio' }, { id: 2, type: 'subtitles' }] }));",
        "  process.exit(0);",
        "}",
        "const dest = args[args.indexOf('-o') + 1];",
        "const hasSrt = args.some((arg) => arg.endsWith('.srt'));",
        "fs.writeFileSync(dest, hasSrt ? 'muxed-captions' : 'muxed-none');",
      ].join("\n"));
      await writeFile(ffprobe, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const body = fs.readFileSync(process.argv.at(-1), 'utf8');",
        "const captions = body.includes('captions');",
        "process.stdout.write(JSON.stringify({",
        "  format: { duration: '1422' },",
        "  streams: [",
        "    { index: 0, codec_type: 'video', codec_name: body.startsWith('encoded') ? 'hevc' : 'h264', width: 1920, height: 1080, bits_per_raw_sample: '8' },",
        "    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } },",
        "    ...(captions ? [{ index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }] : [])",
        "  ]",
        "}));",
      ].join("\n"));
      await Promise.all([chmod(mkvmerge, 0o755), chmod(ffprobe, 0o755), chmod(ffmpeg, 0o755)]);
      const optimizer = ffmpegOptimizer({ capacity: async () => 10 * 1024 ** 3 });
      const plan = planFromSuggestion({
        ...suggestion,
        actions: ["remux", "transcode"],
        keepAudio: [1],
        stripAudio: [],
        keepSubs: [2],
        stripSubs: [],
        now: { codec: "h264", quality: "WEBDL-1080p", sizeBytes: 1_300_000_000, sizePerHourGb: 3.13 },
        after: { codec: "hevc", quality: null, sizeBytes: 424_000_000, sizePerHourGb: 1 },
      });
      const result = await optimizer({
        sourcePath,
        reviewDir,
        plan,
        report: {
          sourceSig: "otter.mp4|1",
          sourceMethod: "ffprobe",
          listingState: "complete",
          durationSec: 1422,
          sizeBytes: 1_300_000_000,
          sizePerHourGb: 3.13,
          videoCodec: "h264",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [{ index: 1, language: "eng", channels: 2, codec: "aac", title: "", untagged: false, commentary: false }],
          subtitles: [{ index: 2, language: "eng", codec: "mov_text", title: "", untagged: false, forced: false, sdh: false }],
          hasChapters: false,
          hasAttachments: false,
        },
        target: "hevc",
        backend: "cuda",
        ffmpeg,
        ffprobe,
        mkvmerge,
        conservative: false,
      });
      expect(result.output.subtitles).toHaveLength(1);
      expect(result.output.subtitles[0]?.codec).toBe("subrip");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes --no-subtitles when every subtitle is removed", () => {
    const plan = planFromSuggestion({ ...suggestion, keepSubs: [], stripSubs: [3, 4] });
    expect(muxPlanArgs(source, "/tmp/out.mkv", plan)).toContain("--no-subtitles");
  });

  it("skips the ffmpeg version banner and keeps the encoder error", () => {
    const message = formatToolError("ffmpeg", {
      stderr: [
        "ffmpeg version 5.1.9-0+deb12u1 Copyright (c) 2000-2026 the FFmpeg developers",
        "built with gcc 12 (Debian 12.2.0-14)",
        "configuration: --enable-gpl",
        "libavutil      57. 28.100 / 57. 28.100",
        "Cannot load libnvidia-encode.so.1",
        "Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height",
      ].join("\n"),
    });
    expect(message).toContain("ffmpeg failed");
    expect(message).not.toMatch(/ffmpeg version 5\.1\.9/);
    expect(message).toMatch(/libnvidia-encode|opening encoder/i);
  });
});

describe("review capacity", () => {
  it("fails before work when the review volume cannot hold the planned output", async () => {
    await expect(assertReviewCapacity("/review", 2_000, async () => 1_000)).rejects.toThrow(/free space/i);
  });
});

describe("ffmpeg encode arguments", () => {
  it("hides the banner and uses a 10-bit NVENC profile", () => {
    const req = {
      sourcePath: source,
      reviewDir: "/tmp/review",
      suggestion,
      report: {
        sourceSig: "p|1",
        sourceMethod: "ffprobe",
        listingState: "complete",
        durationSec: 6000,
        sizeBytes: 20_000_000_000,
        sizePerHourGb: 12,
        videoCodec: "hevc",
        width: 3840,
        height: 2160,
        bitDepth: 10,
        hdr: "hdr10",
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      } satisfies InspectionReport,
      target: "hevc",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    } satisfies OptimizeRequest;
    const args = encodeArgs(source, "/tmp/out.mkv", req);
    expect(args.slice(0, 4)).toEqual(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    expect(args).toContain("-progress");
    expect(args).toContain("pipe:1");
    expect(args).toContain("hevc_nvenc");
    expect(args).toContain("main10");
    expect(args.indexOf("-hwaccel")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-hwaccel") + 1]).toBe("cuda");
    expect(args[args.indexOf("-hwaccel_output_format") + 1]).toBe("cuda");
    expect(args.join(" ")).toContain("scale_cuda=format=p010");
    expect(args).not.toContain("p010le");
    expect(args).not.toContain("yuv420p");
  });

  it("uses CBR so CUDA size-mode AV1 and HEVC share a hard bitrate cap", () => {
    const targetBytes = 5 * 1024 ** 3;
    const durationSec = 3600;
    const report: InspectionReport = {
      sourceSig: "p|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec,
      sizeBytes: 12_000_000_000,
      sizePerHourGb: 12,
      videoCodec: "hevc",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    };
    const base = {
      sourcePath: source,
      reviewDir: "/tmp/review",
      report,
      backend: "cuda" as const,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    };
    const hevc = encodeArgs(source, "/tmp/out.mkv", {
      ...base,
      target: "hevc",
      plan: {
        origin: "bulk",
        video: { kind: "size", codec: "hevc", targetBytes, downscale1080p: false, bitDepth: 8 },
        audio: [],
        subtitles: [],
        container: "mkv",
        writeMode: "sidecar",
        warning: null,
        reasons: [],
        estimatedOutputBytes: targetBytes,
        category: "movie1080p",
      },
    });
    const av1 = encodeArgs(source, "/tmp/out.mkv", {
      ...base,
      target: "av1",
      plan: {
        origin: "bulk",
        video: { kind: "size", codec: "av1", targetBytes, downscale1080p: false, bitDepth: 8 },
        audio: [],
        subtitles: [],
        container: "mkv",
        writeMode: "sidecar",
        warning: null,
        reasons: [],
        estimatedOutputBytes: targetBytes,
        category: "movie1080p",
      },
    });
    expect(hevc[hevc.indexOf("-rc") + 1]).toBe("cbr");
    expect(hevc[hevc.indexOf("-multipass") + 1]).toBe("qres");
    expect(hevc[hevc.indexOf("-rc-lookahead") + 1]).toBe("32");
    expect(hevc[hevc.indexOf("-bufsize") + 1]).toBe(String(Number(hevc[hevc.indexOf("-b:v") + 1]) * 2));
    expect(av1).toContain("av1_nvenc");
    expect(av1[av1.indexOf("-rc") + 1]).toBe("cbr");
    expect(Number(av1[av1.indexOf("-b:v") + 1])).toBe(Number(hevc[hevc.indexOf("-b:v") + 1]));
    expect(av1[av1.indexOf("-bufsize") + 1]).toBe(String(Number(av1[av1.indexOf("-b:v") + 1]) * 2));
  });

  it("gives size-mode AV1 more video bitrate when TrueHD size is measured, not guessed", () => {
    const targetBytes = 4_509_715_661;
    const durationSec = 4052.373;
    const baseReport: InspectionReport = {
      sourceSig: "p|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec,
      sizeBytes: 13_131_642_742,
      sizePerHourGb: 10.86,
      videoCodec: "hevc",
      width: 3840,
      height: 1920,
      bitDepth: 10,
      hdr: "hdr10",
      audio: [
        { index: 1, language: "eng", channels: 8, codec: "truehd", title: "TrueHD 7.1 Atmos", untagged: false, commentary: false },
        { index: 2, language: "eng", channels: 6, codec: "ac3", title: "AC-3 5.1", untagged: false, commentary: false, bitrateBps: 448_000 },
        { index: 3, language: "eng", channels: 2, codec: "aac", title: "", untagged: false, commentary: false },
      ],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    };
    const plan = {
      origin: "custom" as const,
      video: { kind: "size" as const, codec: "av1" as const, targetBytes, downscale1080p: false, bitDepth: 10 },
      audio: [],
      subtitles: [],
      container: "mkv" as const,
      writeMode: "direct" as const,
      warning: null,
      reasons: [],
      estimatedOutputBytes: targetBytes,
      category: "tv4k" as const,
    };
    const guessed = encodeArgs(source, "/tmp/out.mkv", {
      sourcePath: source,
      reviewDir: "/tmp/review",
      report: baseReport,
      plan,
      target: "av1",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    const measured = encodeArgs(source, "/tmp/out.mkv", {
      sourcePath: source,
      reviewDir: "/tmp/review",
      report: {
        ...baseReport,
        audio: [
          { ...baseReport.audio[0]!, sizeBytes: 1_421_238_866 },
          { ...baseReport.audio[1]!, sizeBytes: 226_931_712 },
          { ...baseReport.audio[2]!, sizeBytes: 82_478_280 },
        ],
      },
      plan,
      target: "av1",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    const guessedBps = Number(guessed[guessed.indexOf("-b:v") + 1]);
    const measuredBps = Number(measured[measured.indexOf("-b:v") + 1]);
    expect(guessedBps).toBeLessThan(4_000_000);
    expect(measuredBps).toBeGreaterThan(5_000_000);
    expect(measuredBps).toBeGreaterThan(guessedBps);
  });

  it("does not pass HEVC main10 when encoding 10-bit AV1", () => {
    const args = encodeArgs(source, "/tmp/out.mkv", {
      sourcePath: source,
      reviewDir: "/tmp/review",
      plan: {
        origin: "bulk",
        video: { kind: "size", codec: "av1", targetBytes: 5 * 1024 ** 3, downscale1080p: false, bitDepth: 10 },
        audio: [],
        subtitles: [],
        container: "mkv",
        writeMode: "sidecar",
        warning: null,
        reasons: [],
        estimatedOutputBytes: 5 * 1024 ** 3,
        category: "movie1080p",
      },
      report: {
        sourceSig: "p|1",
        sourceMethod: "ffprobe",
        listingState: "complete",
        durationSec: 3600,
        sizeBytes: 12_000_000_000,
        sizePerHourGb: 12,
        videoCodec: "hevc",
        width: 1920,
        height: 1080,
        bitDepth: 10,
        hdr: "none",
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "av1",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    expect(args).toContain("av1_nvenc");
    expect(args.join(" ")).toContain("scale_cuda=format=p010");
    expect(args).not.toContain("p010le");
    expect(args).not.toContain("main10");
  });

  it("uses quality controls instead of bitrate for quality mode", () => {
    const plan = planFromSuggestion(suggestion);
    const qualityReq = {
      sourcePath: source,
      reviewDir: "/tmp/review",
      suggestion,
      plan: {
        ...plan,
        video: { kind: "quality" as const, codec: "hevc" as const, quality: 22, downscale1080p: true, bitDepth: 10 },
      },
      report: {
        sourceSig: "p|1",
        sourceMethod: "ffprobe" as const,
        listingState: "complete" as const,
        durationSec: 6000,
        sizeBytes: 20_000_000_000,
        sizePerHourGb: 12,
        videoCodec: "hevc",
        width: 3840,
        height: 2160,
        bitDepth: 10,
        hdr: "hdr10" as const,
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "hevc" as const,
      backend: "cuda" as const,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    };
    const args = encodeArgs(source, "/tmp/out.mkv", qualityReq);
    expect(args).toContain("-cq");
    expect(args).not.toContain("-b:v");
    expect(args).toContain("scale_cuda=w=1920:h=1080:format=p010");
    expect(args).not.toContain("scale=1920:1080");
  });

  it("leaves decode on the CPU when NVDEC cannot handle the source codec", () => {
    const args = encodeArgs(source, "/tmp/out.mkv", {
      sourcePath: source,
      reviewDir: "/tmp/review",
      plan: {
        origin: "bulk",
        video: { kind: "size", codec: "hevc", targetBytes: 2 * 1024 ** 3, downscale1080p: true, bitDepth: 8 },
        audio: [],
        subtitles: [],
        container: "mkv",
        writeMode: "sidecar",
        warning: null,
        reasons: [],
        estimatedOutputBytes: 2 * 1024 ** 3,
        category: "movie1080p",
      },
      report: {
        sourceSig: "p|1",
        sourceMethod: "ffprobe",
        listingState: "complete",
        durationSec: 3600,
        sizeBytes: 4_000_000_000,
        sizePerHourGb: 4,
        videoCodec: "mpeg4",
        width: 1920,
        height: 1080,
        bitDepth: 8,
        hdr: "none",
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "hevc",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    expect(args).toContain("hevc_nvenc");
    expect(args).not.toContain("-hwaccel");
    expect(args).toContain("scale=1920:1080");
    expect(args).toContain("yuv420p");
    expect(args.join(" ")).not.toContain("scale_cuda");
  });

  it("does not aim a codec transcode larger than the source", () => {
    const plan = planFromSuggestion({
      ...suggestion,
      actions: ["transcode"],
      now: { codec: "h264", quality: "Bluray-1080p", sizeBytes: 4_000_000_000, sizePerHourGb: 2 },
      after: { codec: "hevc", quality: null, sizeBytes: null, sizePerHourGb: 2 },
    });
    expect(plan.video.kind).toBe("size");
    if (plan.video.kind === "size") expect(plan.video.targetBytes).toBe(4_000_000_000);
  });

  it("uses After bytes as the encode target and marks size-only encodes skippable", () => {
    const plan = planFromSuggestion({
      ...suggestion,
      actions: ["transcode"],
      mustEncode: false,
      now: { codec: "hevc", quality: "Bluray-1080p", sizeBytes: 16_000_000_000, sizePerHourGb: 8 },
      after: { codec: "hevc", quality: null, sizeBytes: 5_000_000_000, sizePerHourGb: 2.5 },
    });
    expect(plan.video.kind).toBe("size");
    if (plan.video.kind === "size") {
      expect(plan.video.targetBytes).toBe(5_000_000_000);
      expect(plan.video.mustEncode).toBe(false);
    }
  });

  it("builds a VAAPI encode graph instead of NVENC when that is the usable backend", () => {
    const plan = planFromSuggestion({ ...suggestion, actions: ["transcode"] });
    const args = encodeArgs(source, "/tmp/out.mkv", {
      sourcePath: source,
      reviewDir: "/tmp/review",
      suggestion,
      plan: {
        ...plan,
        video: { kind: "quality", codec: "hevc", quality: 22, downscale1080p: true, bitDepth: 8 },
      },
      report: {
        sourceSig: "p|1",
        sourceMethod: "ffprobe",
        listingState: "complete",
        durationSec: 6000,
        sizeBytes: 8_000_000_000,
        sizePerHourGb: 4,
        videoCodec: "h264",
        width: 3840,
        height: 2160,
        bitDepth: 8,
        hdr: "none",
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "hevc",
      backend: "vaapi",
      vaapiDevice: "/dev/dri/renderD128",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    expect(args).toContain("hevc_vaapi");
    expect(args).not.toContain("hevc_nvenc");
    expect(args.join(" ")).toContain("vaapi=va:/dev/dri/renderD128");
    expect(args.join(" ")).toContain("format=nv12,hwupload=extra_hw_frames=64,scale_vaapi=w=1920:h=1080");
    expect(args).toContain("-qp");
    expect(args).not.toContain("yuv420p");
    expect(args).not.toContain("p010le");
  });

  it("converts timed-text subtitles to SubRip instead of copying them", () => {
    const report: InspectionReport = {
      sourceSig: "p|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 120,
      sizeBytes: 1,
      sizePerHourGb: 1,
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [],
      subtitles: [
        { index: 2, language: "eng", codec: "mov_text", title: "", untagged: false, forced: false, sdh: false },
      ],
      hasChapters: false,
      hasAttachments: false,
    };
    expect(isTextSubtitleCodec("mov_text")).toBe(true);
    expect(subtitleEncodeArgs(report)).toEqual(["-c:s", "srt"]);
    expect(subtitleEncodeArgs({
      ...report,
      subtitles: [{ index: 2, language: "eng", codec: "hdmv_pgs_subtitle", title: "", untagged: false, forced: false, sdh: false }],
    })).toEqual(["-c:s", "copy"]);
    expect(subtitleEncodeArgs({
      ...report,
      subtitles: [
        { index: 2, language: "eng", codec: "mov_text", title: "", untagged: false, forced: false, sdh: false },
        { index: 3, language: "eng", codec: "hdmv_pgs_subtitle", title: "", untagged: false, forced: false, sdh: false },
      ],
    })).toEqual(["-c:s:0", "srt", "-c:s:1", "copy"]);
    const args = encodeArgs(source, "/tmp/out.mkv", {
      sourcePath: source,
      reviewDir: "/tmp/review",
      suggestion,
      report,
      target: "hevc",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    expect(args).toContain("srt");
    expect(args.join(" ")).not.toMatch(/-c:s copy/);
  });

  it("encodes only the first video stream so Blu-ray menu titles do not hit NVENC", () => {
    const plan = {
      ...planFromSuggestion({ ...suggestion, actions: ["transcode"] }),
      video: { kind: "size" as const, codec: "hevc" as const, targetBytes: 8 * 1024 ** 3, downscale1080p: false, bitDepth: 8 },
    };
    const args = encodeArgs(source, "/tmp/out.mkv", {
      sourcePath: source,
      reviewDir: "/tmp/review",
      suggestion,
      plan,
      report: {
        sourceSig: "p|1",
        sourceMethod: "iso_ffmpeg",
        listingState: "complete",
        durationSec: 8500,
        sizeBytes: 25_000_000_000,
        sizePerHourGb: 10,
        videoCodec: "h264",
        width: 1920,
        height: 1080,
        bitDepth: 8,
        hdr: "none",
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "hevc",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    expect(args).toContain("0:v:0");
    const maps = args.filter((part, i) => args[i - 1] === "-map");
    expect(maps).toContain("0:v:0");
    expect(maps.some((part) => part === "0" || part.startsWith("0:v:1"))).toBe(false);
  });

  it("picks NVENC bitrate from the target file size and the feature duration", () => {
    const targetBytes = 20 * 1024 ** 3;
    const durationSec = 8500;
    const args = encodeArgs("/tmp/hunger-games.mkv", "/tmp/out.mkv", {
      sourcePath: "/mnt/nas/Movies/The Hunger Games (2012)/The Hunger Games.iso",
      reviewDir: "/tmp/review",
      plan: {
        origin: "custom",
        video: { kind: "size", codec: "hevc", targetBytes, downscale1080p: false, bitDepth: 8 },
        audio: [],
        subtitles: [],
        container: "mkv",
        writeMode: "sidecar",
        warning: null,
        reasons: ["Target 20 GB"],
        estimatedOutputBytes: targetBytes,
        category: "movie1080p",
      },
      report: {
        sourceSig: "p|1",
        sourceMethod: "iso_ffmpeg",
        listingState: "complete",
        durationSec,
        sizeBytes: 40_000_000_000,
        sizePerHourGb: 16,
        videoCodec: "h264",
        width: 1920,
        height: 1080,
        bitDepth: 8,
        hdr: "none",
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "hevc",
      backend: "cuda",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    });
    const bitrate = Number(args[args.indexOf("-b:v") + 1]);
    const expected = videoBitrateForTarget({ targetBytes, durationSec, audioBitrateBps: 0 });
    expect(bitrate).toBe(expected);
    expect(args[args.indexOf("-maxrate") + 1]).toBe(String(expected));
    expect(args[args.indexOf("-bufsize") + 1]).toBe(String(expected * 2));
    expect(args[args.indexOf("-rc") + 1]).toBe("cbr");
    expect(bitrate).toBeGreaterThan(15_000_000);
    expect(bitrate).toBeLessThan(25_000_000);
  });

  it("rejects a 20 GB target when the remux is a 10-second title", () => {
    const req = {
      sourcePath: "/mnt/nas/Movies/The Hunger Games Catching Fire (2013)/Catching Fire.iso",
      reviewDir: "/tmp/review",
      plan: {
        origin: "custom" as const,
        video: { kind: "size" as const, codec: "hevc" as const, targetBytes: 20 * 1024 ** 3, downscale1080p: false, bitDepth: 8 },
        audio: [],
        subtitles: [],
        container: "mkv" as const,
        writeMode: "sidecar" as const,
        warning: null,
        reasons: ["Target 20 GB"],
        estimatedOutputBytes: 20 * 1024 ** 3,
        category: "movie1080p" as const,
      },
      report: {
        sourceSig: "p|1",
        sourceMethod: "iso_ffmpeg" as const,
        listingState: "complete" as const,
        durationSec: 10.01,
        sizeBytes: 40_000_000_000,
        sizePerHourGb: 0,
        videoCodec: "hevc",
        width: 3840,
        height: 2160,
        bitDepth: 10,
        hdr: "none" as const,
        audio: [],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "hevc" as const,
      backend: "cuda" as const,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    };
    expect(() => nvencBitrate(req, req.plan.video)).toThrow(
      /A 20\.0 GB target over 1 minutes needs \d+ Mbps, which the hardware encoder will reject/,
    );
  });

  it("does not invent a bitrate when duration is unknown", () => {
    expect(() =>
      encodeArgs("/tmp/hunger-games.mkv", "/tmp/out.mkv", {
        sourcePath: "/mnt/nas/Movies/The Hunger Games (2012)/The Hunger Games.iso",
        reviewDir: "/tmp/review",
        plan: {
          origin: "custom",
          video: { kind: "size", codec: "hevc", targetBytes: 20 * 1024 ** 3, downscale1080p: false, bitDepth: 8 },
          audio: [],
          subtitles: [],
          container: "mkv",
          writeMode: "sidecar",
          warning: null,
          reasons: ["Target 20 GB"],
          estimatedOutputBytes: 20 * 1024 ** 3,
          category: "movie1080p",
        },
        report: {
          sourceSig: "p|1",
          sourceMethod: "iso_ffmpeg",
          listingState: "complete",
          durationSec: 0,
          sizeBytes: 40_000_000_000,
          sizePerHourGb: 0,
          videoCodec: "h264",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [],
          subtitles: [],
          hasChapters: false,
          hasAttachments: false,
        },
        target: "hevc",
        backend: "cuda",
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        mkvmerge: "mkvmerge",
        conservative: false,
      }),
    ).toThrow(/duration/i);
  });
});

describe("tool progress", () => {
  it("reads encode time from ffmpeg progress lines", () => {
    expect(parseFfmpegProgress("frame=12\nout_time_ms=90000000\nprogress=continue\n")).toBe(90);
    expect(parseFfmpegProgress("out_time_us=15000000\n")).toBe(15);
    expect(parseFfmpegProgress("out_time=00:02:05.50\n")).toBeCloseTo(125.5, 1);
    expect(parseFfmpegProgress("out_time_ms=N/A\n")).toBeNull();
  });

  it("reads mkvmerge percent lines", () => {
    expect(parseMkvmergeProgress("Progress: 45%\n")).toBe(0.45);
    expect(parseMkvmergeProgress("Progress: 100%\n")).toBe(1);
  });

  it("maps a phase ratio onto the overall job bar", () => {
    expect(scaleProgress(0.5, 0.9, 0)).toBe(0.5);
    expect(scaleProgress(0.5, 0.9, 1)).toBe(0.9);
    expect(scaleProgress(0.5, 0.9, 0.5)).toBeCloseTo(0.7, 5);
  });
});

describe("ISO remux and custom audio arguments", () => {
  it("copies video for ISO remux and does not pick an encoder", () => {
    const plan = planFromSuggestion(suggestion);
    const args = isoRemuxArgs("/mnt/nas/discs/Example.iso", "/tmp/out.mkv", plan);
    expect(args).toContain("/mnt/nas/discs/Example.iso");
    expect(args).toContain("-c");
    expect(args).toContain("copy");
    expect(args.join(" ")).not.toMatch(/nvenc|vaapi/);
  });

  it("remuxes the longest Blu-ray playlist and drops dummy 0-channel audio", () => {
    const plan = planFromSuggestion(suggestion);
    const args = isoRemuxArgs(
      "/mnt/nas/Catching Fire.iso",
      "/tmp/out.mkv",
      plan,
      {
        sourceSig: "p|1",
        sourceMethod: "iso_ffmpeg",
        listingState: "complete",
        durationSec: 8776,
        isoPlaylist: 0,
        sizeBytes: 40_000_000_000,
        sizePerHourGb: 16,
        videoCodec: "hevc",
        width: 3840,
        height: 2160,
        bitDepth: 10,
        hdr: "none",
        audio: [
          { index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false },
          { index: 10, language: "und", channels: 0, codec: "ac3", title: "", untagged: true, commentary: false },
        ],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
    );
    expect(args).toContain("-playlist");
    expect(args[args.indexOf("-playlist") + 1]).toBe("0");
    expect(args).toContain("bluray:/mnt/nas/Catching Fire.iso");
    expect(args).toContain("-map");
    expect(args).toContain("0:v:0?");
    expect(args).toContain("0:1?");
    expect(args).toContain("-metadata:s:a:0");
    expect(args).toContain("language=eng");
    expect(args).not.toContain("-0:10");
    expect(args).toContain("-max_error_rate");
    expect(isoRemuxIsShort(8776, 10.01)).toBe(true);
    expect(isoRemuxIsShort(8776, 8700)).toBe(false);
    expect(isoRemuxIsShort(10_787_176.448, 6145)).toBe(false);
  });

  it("uses the bluray protocol for BR-DISK images", () => {
    const path =
      "/mnt/nas/Movies/The Hunger Games (2012)/The Hunger Games (2012) {imdb-tt1392170}[BR-DISK][bit][]-F13.iso";
    const args = isoDemuxArgs(path);
    expect(args).toEqual(["-i", `bluray:${path}`]);
    expect(args.join(" ")).not.toContain("-f bluray");
  });

  it("tries bluray protocol then playlists and never opens a BR-DISK as a raw file", () => {
    const path =
      "/mnt/nas/Movies/The Hunger Games (2012)/The Hunger Games (2012) {imdb-tt1392170}[BR-DISK][bit][]-F13.iso";
    const attempts = isoInputAttempts(path);
    expect(attempts[0]).toEqual(["-i", `bluray:${path}`]);
    expect(attempts.some((args) => args.includes("-playlist") && args.includes("0"))).toBe(true);
    expect(attempts.some((args) => args.includes("-playlist") && args.includes("1"))).toBe(true);
    expect(attempts.some((args) => args.length === 2 && args[0] === "-i" && args[1] === path)).toBe(false);
    expect(isoCopyMaps({
      sourceSig: "p|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 10_787_176,
      isoPlaylist: null,
      sizeBytes: 1,
      sizePerHourGb: 0,
      videoCodec: "unknown",
      width: 0,
      height: 0,
      bitDepth: 8,
      hdr: "none",
      audio: [{ index: 0, language: "und", channels: 2, codec: "ac3", title: "", untagged: true, commentary: false }],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    })).toEqual(["-map", "0:v:0?", "-map", "0:a:0?", "-map", "0:a?"]);
  });

  it("remuxes an ISO to Matroska before a video encode", () => {
    const plan = planFromSuggestion({ ...suggestion, actions: ["transcode"] });
    expect(optimizeSteps("/mnt/nas/Movies/Cars 3.iso", plan)).toEqual(["iso_remux", "encode"]);
    expect(optimizeSteps("/mnt/nas/Movies/Cars 3.mkv", plan)).toEqual(["encode"]);
  });

  it("remuxes an opted-in MP4 before encoding and leaves MKV and disabled plans unchanged", () => {
    const remuxThenEncode = planFromSuggestion({
      ...suggestion,
      actions: ["transcode", "remux", "tracks", "add_stereo"],
      keepAudio: [1],
      stripAudio: [2],
    });
    const encodeOnly = planFromSuggestion({ ...suggestion, actions: ["transcode"] });
    const remuxOnly = planFromSuggestion({ ...suggestion, actions: ["remux"] });

    expect(optimizeSteps("/mnt/nas/Shows/Curious George S04E14.mp4", remuxThenEncode)).toEqual(["mux", "encode"]);
    expect(muxPlanArgs("/mnt/nas/Shows/Curious George S04E14.mp4", "/tmp/remuxed.mkv", remuxThenEncode)).toContain("--audio-tracks");
    expect(optimizeSteps("/mnt/nas/Shows/Curious George S04E14.mkv", encodeOnly)).toEqual(["encode"]);
    expect(optimizeSteps("/mnt/nas/Shows/Curious George S04E14.mp4", encodeOnly)).toEqual(["encode"]);
    expect(optimizeSteps("/mnt/nas/Shows/Curious George S04E14.mp4", remuxOnly)).toEqual(["mux"]);
  });

  it("skips a size-only encode when the working file already meets the cap", () => {
    const plan = planFromSuggestion({
      ...suggestion,
      actions: ["transcode", "tracks"],
      mustEncode: false,
      now: { codec: "hevc", quality: "Bluray-1080p", sizeBytes: 16_000_000_000, sizePerHourGb: 8 },
      after: { codec: "hevc", quality: null, sizeBytes: 5_000_000_000, sizePerHourGb: 2.5 },
    });
    expect(shouldSkipSizeEncode(plan, {
      sourceSig: "p|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 7200,
      sizeBytes: 4_000_000_000,
      sizePerHourGb: 2,
      videoCodec: "hevc",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [{ index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false }],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    })).toBe(true);
  });

  it("skips a size-only encode when kept TrueHD fills the cap, and still encodes when the codec must change", () => {
    const durationSec = 7492.96;
    const working: InspectionReport = {
      sourceSig: "p|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec,
      sizeBytes: 30_000_000_000,
      sizePerHourGb: 14,
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [
        { index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false },
        { index: 2, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
        { index: 3, language: "eng", channels: 2, codec: "ac3", title: "", untagged: false, commentary: false },
      ],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    };
    const sizeOnly = planFromSuggestion({
      ...suggestion,
      actions: ["transcode", "tracks"],
      mustEncode: false,
      now: { codec: "hevc", quality: "BR-DISK", sizeBytes: 39_392_987_136, sizePerHourGb: 17.63 },
      after: { codec: "hevc", quality: null, sizeBytes: Math.round(2.5 * (durationSec / 3600) * 1024 ** 3), sizePerHourGb: 2.5 },
    });
    const mustEncode = planFromSuggestion({
      ...suggestion,
      actions: ["transcode", "tracks"],
      mustEncode: true,
      now: { codec: "h264", quality: "BR-DISK", sizeBytes: 39_392_987_136, sizePerHourGb: 17.63 },
      after: { codec: "hevc", quality: null, sizeBytes: Math.round(2.5 * (durationSec / 3600) * 1024 ** 3), sizePerHourGb: 2.5 },
    });
    expect(shouldSkipSizeEncode(sizeOnly, working)).toBe(true);
    expect(shouldSkipSizeEncode(mustEncode, working)).toBe(false);
  });

  it("muxes extra tracks and finishes without ffmpeg when a size-only encode no longer fits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polisharr-skip-encode-"));
    try {
      const sourcePath = join(dir, "batman.mkv");
      const reviewDir = join(dir, "review");
      const mkvmerge = join(dir, "mkvmerge.cjs");
      const ffprobe = join(dir, "ffprobe.cjs");
      const ffmpeg = join(dir, "ffmpeg.cjs");
      await writeFile(sourcePath, "source");
      await writeFile(ffmpeg, [
        "#!/usr/bin/env node",
        "process.stderr.write('should not encode');",
        "process.exit(2);",
      ].join("\n"));
      await writeFile(mkvmerge, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args.includes('-J')) {",
        "  process.stdout.write(JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio' }, { id: 2, type: 'audio' }] }));",
        "  process.exit(0);",
        "}",
        "fs.writeFileSync(args[args.indexOf('-o') + 1], 'muxed');",
        "process.stdout.write('Progress: 100%\\n');",
      ].join("\n"));
      await writeFile(ffprobe, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  format: { duration: '3600' },",
        "  streams: [",
        "    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, bits_per_raw_sample: '8' },",
        "    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng' } }",
        "  ]",
        "}));",
      ].join("\n"));
      await Promise.all([chmod(mkvmerge, 0o755), chmod(ffprobe, 0o755), chmod(ffmpeg, 0o755)]);
      const optimizer = ffmpegOptimizer({ capacity: async () => 10 * 1024 ** 3 });
      const result = await optimizer({
        sourcePath,
        reviewDir,
        plan: planFromSuggestion({
          ...suggestion,
          actions: ["transcode", "tracks"],
          mustEncode: false,
          keepAudio: [1],
          stripAudio: [2],
          keepSubs: [],
          stripSubs: [],
          now: { codec: "hevc", quality: "Bluray-1080p", sizeBytes: 8_000_000_000, sizePerHourGb: 8 },
          after: { codec: "hevc", quality: null, sizeBytes: 2_500_000_000, sizePerHourGb: 2.5 },
        }),
        report: {
          sourceSig: "batman.mkv|8",
          sourceMethod: "ffprobe",
          listingState: "complete",
          durationSec: 3600,
          sizeBytes: 8_000_000_000,
          sizePerHourGb: 8,
          videoCodec: "hevc",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [
            { index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
            { index: 2, language: "spa", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
          ],
          subtitles: [],
          hasChapters: false,
          hasAttachments: false,
        },
        target: "hevc",
        backend: "none",
        ffmpeg,
        ffprobe,
        mkvmerge,
        conservative: false,
      });
      expect(result.output.videoCodec).toBe("hevc");
      expect(result.output.audio).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("raises the size target so a required codec encode can run after TrueHD fills the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polisharr-raise-encode-"));
    try {
      const sourcePath = join(dir, "batman.mkv");
      const reviewDir = join(dir, "review");
      const mkvmerge = join(dir, "mkvmerge.cjs");
      const ffprobe = join(dir, "ffprobe.cjs");
      const ffmpeg = join(dir, "ffmpeg.cjs");
      await writeFile(sourcePath, "source");
      await writeFile(ffmpeg, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const dest = process.argv.at(-1);",
        "fs.writeFileSync(dest, 'encoded');",
      ].join("\n"));
      await writeFile(mkvmerge, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args.includes('-J')) {",
        "  process.stdout.write(JSON.stringify({ tracks: [{ id: 0, type: 'video' }, { id: 1, type: 'audio' }] }));",
        "  process.exit(0);",
        "}",
        "fs.writeFileSync(args[args.indexOf('-o') + 1], 'muxed');",
        "process.stdout.write('Progress: 100%\\n');",
      ].join("\n"));
      await writeFile(ffprobe, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const encoded = fs.readFileSync(process.argv.at(-1), 'utf8') === 'encoded';",
        "process.stdout.write(JSON.stringify({",
        "  format: { duration: '7492.96' },",
        "  streams: [",
        "    { index: 0, codec_type: 'video', codec_name: encoded ? 'hevc' : 'h264', width: 1920, height: 1080, bits_per_raw_sample: '8' },",
        "    { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8, tags: { language: 'eng' } }",
        "  ]",
        "}));",
      ].join("\n"));
      await Promise.all([chmod(mkvmerge, 0o755), chmod(ffprobe, 0o755), chmod(ffmpeg, 0o755)]);
      const optimizer = ffmpegOptimizer({ capacity: async () => 80 * 1024 ** 3 });
      const durationSec = 7492.96;
      const result = await optimizer({
        sourcePath,
        reviewDir,
        plan: planFromSuggestion({
          ...suggestion,
          actions: ["transcode", "tracks"],
          mustEncode: true,
          keepAudio: [1],
          stripAudio: [2],
          keepSubs: [],
          stripSubs: [],
          now: { codec: "h264", quality: "BR-DISK", sizeBytes: 39_392_987_136, sizePerHourGb: 17.63 },
          after: { codec: "hevc", quality: null, sizeBytes: Math.round(2.5 * (durationSec / 3600) * 1024 ** 3), sizePerHourGb: 2.5 },
        }),
        report: {
          sourceSig: "batman.mkv|1",
          sourceMethod: "ffprobe",
          listingState: "complete",
          durationSec,
          sizeBytes: 39_392_987_136,
          sizePerHourGb: 17.63,
          videoCodec: "h264",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [
            { index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false },
            { index: 2, language: "spa", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
          ],
          subtitles: [],
          hasChapters: false,
          hasAttachments: false,
        },
        target: "hevc",
        backend: "cuda",
        ffmpeg,
        ffprobe,
        mkvmerge,
        conservative: false,
      });
      expect(result.output.videoCodec).toBe("hevc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still refuses a custom size target that kept audio already fills", () => {
    const durationSec = 7492.96;
    const req = {
      sourcePath: "/tmp/in.mkv",
      reviewDir: "/tmp/review",
      plan: {
        origin: "custom" as const,
        video: {
          kind: "size" as const,
          codec: "hevc" as const,
          targetBytes: Math.round(1.0 * (durationSec / 3600) * 1024 ** 3),
          downscale1080p: false,
          bitDepth: 8,
        },
        audio: [{ op: "keep" as const, index: 1 }],
        subtitles: [],
        container: "mkv" as const,
        writeMode: "sidecar" as const,
        warning: null,
        reasons: ["Target 1.0 GB/hr"],
        estimatedOutputBytes: Math.round(1.0 * (durationSec / 3600) * 1024 ** 3),
        category: "movie1080p" as const,
      },
      report: {
        sourceSig: "p|1",
        sourceMethod: "ffprobe" as const,
        listingState: "complete" as const,
        durationSec,
        sizeBytes: 39_392_987_136,
        sizePerHourGb: 17.63,
        videoCodec: "h264",
        width: 1920,
        height: 1080,
        bitDepth: 8,
        hdr: "none" as const,
        audio: [{ index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false }],
        subtitles: [],
        hasChapters: false,
        hasAttachments: false,
      },
      target: "hevc" as const,
      backend: "cuda" as const,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      mkvmerge: "mkvmerge",
      conservative: false,
    };
    expect(() => nvencBitrate(req, req.plan.video)).toThrow(/Kept audio is about/);
  });

  it("builds AAC from a selected source stream", () => {
    const args = audioAacArgs("/in.mkv", "/out.aac", 1, 6, "160k");
    expect(args).toContain("0:1");
    expect(args).toContain("6");
    expect(args).toContain("aac");
    expect(args.join(" ")).not.toContain("language=");
  });

  it("writes the source language onto a downmix AAC stream", () => {
    const args = audioAacArgs("/in.mkv", "/out.aac", 1, 2, "160k", "eng");
    expect(args).toContain("-metadata:s:a:0");
    expect(args).toContain("language=eng");
  });
});
