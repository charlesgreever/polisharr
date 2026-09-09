import { describe, expect, it } from "vitest";
import {
  featureDurationSec,
  isIsoPath,
  isMediaFilePath,
  isoInspectionLooksStale,
  isoListingLooksUsable,
  longestBlurayPlaylist,
  normalizeInspection,
  normalizeLang,
  parseFfprobe,
  parseFfmpegListing,
  parseListedDuration,
  pickPlayableVideo,
  trackEditingAvailable,
  unlistedIsoReport,
} from "./inspect.ts";
import { isoFailedFfmpeg, isoListedFfmpeg, mkv4kHdrFfprobe, mkvNormalFfprobe } from "./fixtures/index.ts";

describe("parseFfprobe", () => {
  it("records the playable video stream instead of cover art", () => {
    const report = parseFfprobe("movie.mkv", 1, {
      format: { duration: "10" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "mjpeg", width: 600, height: 900, disposition: { attached_pic: 1 } },
        { index: 1, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 },
      ],
    });
    expect(report.videoIndex).toBe(1);
    expect(report.videoCodec).toBe("hevc");
  });
  it("ignores cover art when choosing 4K size", () => {
    const report = parseFfprobe("/media/Avatar.mkv", 16_000_000_000, {
      format: { duration: "5900" },
      streams: [
        { codec_type: "video", codec_name: "mjpeg", width: 600, height: 900, disposition: { attached_pic: 1 } },
        { codec_type: "video", codec_name: "hevc", coded_width: 3840, coded_height: 2160, pix_fmt: "yuv420p10le", tags: { HDR: "Dolby Vision" } },
        { codec_type: "audio", codec_name: "eac3", channels: 8, tags: { language: "eng" }, index: 2 },
      ],
    });
    expect(report.width).toBe(3840);
    expect(report.height).toBe(2160);
    expect(report.bitDepth).toBe(10);
    expect(report.hdr).toBe("dolby_vision");
    expect(report.sizePerHourGb).toBeGreaterThan(8);
  });

  it("treats muxer language any as untagged", () => {
    expect(normalizeLang("any")).toBe("und");
    expect(normalizeLang("ANY")).toBe("und");
    const report = parseFfprobe("/mnt/nas/Kids TV/episode.mkv", 400_000_000, {
      format: { duration: "1400" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1280, height: 720, index: 0 },
        { codec_type: "audio", codec_name: "ac3", channels: 2, tags: { language: "any", title: "Stereo" }, index: 1 },
      ],
    });
    expect(report.audio[0]).toMatchObject({ language: "und", untagged: true, channels: 2, codec: "ac3" });
    const stored = normalizeInspection({
      audio: [{ index: 1, language: "any", channels: 2, codec: "ac3", title: "Stereo", untagged: false, commentary: false }],
      subtitles: [],
    });
    expect(stored.audio[0]).toMatchObject({ language: "und", untagged: true });
  });

  it("uses coded size when display size is missing", () => {
    const video = pickPlayableVideo([
      { codec_type: "video", codec_name: "h264", coded_width: 1920, coded_height: 1080 },
    ]);
    expect(video?.coded_width).toBe(1920);
  });

  it("loads the normal MKV fixture into a public inspection report", () => {
    const report = parseFfprobe("/mnt/nas/Example.mkv", 18_500_000_000, mkvNormalFfprobe);
    expect(report.videoCodec).toBe("hevc");
    expect(report.width).toBe(1920);
    expect(report.height).toBe(1080);
    expect(report.bitDepth).toBe(10);
    expect(report.audio).toHaveLength(4);
    expect(report.subtitles).toHaveLength(3);
    expect(report.hasChapters).toBe(true);
    expect(report.hasAttachments).toBe(true);
  });

  it("loads the 4K HDR fixture without using cover art for size", () => {
    const report = parseFfprobe("/mnt/nas/Avatar.mkv", 28_000_000_000, mkv4kHdrFfprobe);
    expect(report.width).toBe(3840);
    expect(report.height).toBe(2160);
    expect(report.bitDepth).toBe(10);
    expect(report.hdr).toBe("dolby_vision");
    expect(report.audio[0]?.channels).toBe(8);
  });

  it("keeps recorded ISO listings for later ffmpeg parsing", () => {
    expect(isoListedFfmpeg).toMatch(/Stream #0:0.*Video: mpeg2video/i);
    expect(isoListedFfmpeg).toMatch(/Audio: ac3/);
    expect(isoListedFfmpeg).toMatch(/Subtitle: hdmv_pgs_subtitle/);
    expect(isoFailedFfmpeg).toMatch(/Invalid data found when processing input/);
    expect(isoFailedFfmpeg).not.toMatch(/Stream #0:/);
  });

  it("classifies ISO paths without treating them as ffprobe failures", () => {
    expect(isIsoPath("/mnt/nas/disc.iso")).toBe(true);
    expect(isIsoPath("/mnt/nas/DISC.ISO")).toBe(true);
    expect(isIsoPath("/mnt/nas/movie.mkv")).toBe(false);
    expect(isMediaFilePath("/mnt/nas/Movies/John Wick Chapter 3 - Parabellum (2019)")).toBe(false);
    expect(isMediaFilePath("/mnt/nas/Movies/Rogue One A Star Wars Story (2016)/Rogue One.mkv")).toBe(true);
    const failed = unlistedIsoReport("/mnt/nas/Broken.iso", 8_000_000_000);
    expect(failed.sourceMethod).toBe("iso_ffmpeg");
    expect(failed.listingState).toBe("iso_unlisted");
    expect(trackEditingAvailable(failed)).toBe(false);
    const mkv = parseFfprobe("/mnt/nas/Example.mkv", 18_500_000_000, mkvNormalFfprobe);
    expect(mkv.sourceMethod).toBe("ffprobe");
    expect(mkv.listingState).toBe("complete");
    expect(trackEditingAvailable(mkv)).toBe(true);
  });

  it("parses a listed ISO fixture into the public inspection report shape", () => {
    const report = parseFfmpegListing("/mnt/nas/discs/Example.iso", 19_000_000_000, isoListedFfmpeg);
    expect(report.sourceMethod).toBe("iso_ffmpeg");
    expect(report.listingState).toBe("complete");
    expect(report.videoCodec).toBe("mpeg2video");
    expect(report.width).toBe(1920);
    expect(report.height).toBe(1080);
    expect(report.audio).toHaveLength(3);
    expect(report.audio[0]?.channels).toBe(6);
    expect(report.audio[1]?.channels).toBe(8);
    expect(report.subtitles).toHaveLength(3);
    expect(report.durationSec).toBeGreaterThan(6000);
    expect(trackEditingAvailable(report)).toBe(true);
  });

  it("returns a distinct failed listing instead of invented streams", () => {
    const report = parseFfmpegListing("/mnt/nas/discs/Broken.iso", 8_000_000_000, isoFailedFfmpeg);
    expect(report.sourceMethod).toBe("iso_ffmpeg");
    expect(report.listingState).toBe("iso_unlisted");
    expect(trackEditingAvailable(report)).toBe(false);
  });

  it("picks the longest usable Blu-ray playlist and skips 0-channel dummy audio", () => {
    const listing = [
      "[bluray @ 0x1] 12 usable playlists:",
      "[bluray @ 0x1] playlist 00000.mpls (2:26:16)",
      "[bluray @ 0x1] playlist 00010.mpls (2:24:56)",
      "[bluray @ 0x1] playlist 00011.mpls (0:11:08)",
      "Input #0, mpegts, from 'bluray:/mnt/nas/Catching Fire.iso':",
      "  Duration: 02:26:16.39, start: 4199.000000, bitrate: 74062 kb/s",
      "  Stream #0:0[0x1011]: Video: hevc (Main 10), yuv420p10le, 3840x2160",
      "  Stream #0:1[0x1100](eng): Audio: truehd, 48000 Hz, 7.1",
      "  Stream #0:2[0x1101](eng): Audio: ac3, 48000 Hz, 5.1(side)",
      "  Stream #0:10[0x1fff]: Audio: ac3, 0 channels",
    ].join("\n");
    expect(parseListedDuration(listing)).toBeCloseTo(8776.39, 1);
    expect(longestBlurayPlaylist(listing)).toEqual({ id: 0, durationSec: 2 * 3600 + 26 * 60 + 16 });
    const report = parseFfmpegListing("/mnt/nas/Catching Fire.iso", 40_000_000_000, listing);
    expect(report.isoPlaylist).toBe(0);
    expect(report.durationSec).toBeGreaterThan(8700);
    expect(report.audio.some((t) => t.index === 10 && t.channels === 0)).toBe(true);
    expect(report.audio.find((t) => t.index === 1)?.channels).toBe(8);
  });

  it("rejects an audio-only ISO listing and ignores a multi-day Duration line", () => {
    const listing = [
      "Input #0, mpegts, from 'file.iso':",
      "  Duration: 2996:25:16.45, start: 0.000000, bitrate: 192 kb/s",
      "  Stream #0:0[0x80](und): Audio: ac3, 48000 Hz, stereo, fltp, 192 kb/s",
    ].join("\n");
    expect(isoListingLooksUsable(listing)).toBe(false);
    expect(featureDurationSec(parseListedDuration(listing), 0)).toBe(0);
    const withPlaylist = `${listing}\n[bluray @ 0x1] playlist 00008.mpls (1:42:11)`;
    expect(parseFfmpegListing("/mnt/nas/Cars 3.iso", 40_000_000_000, withPlaylist).durationSec).toBeCloseTo(1 * 3600 + 42 * 60 + 11, 0);
  });

  it("treats an ISO that was probed as a raw AC3 file as a stale listing", () => {
    const path = "/mnt/nas/Kids Movies/Cars 3 (2017)/Cars 3 (2017)[BR-DISK].iso";
    const dummy = parseFfprobe(path, 43_148_705_792, {
      format: { duration: "10787176.448" },
      streams: [{ codec_type: "audio", codec_name: "ac3", channels: 2, index: 0 }],
    });
    expect(dummy.sourceMethod).toBe("ffprobe");
    expect(isoInspectionLooksStale(dummy, path)).toBe(true);
    expect(isoInspectionLooksStale(undefined, path)).toBe(true);
    const listed = parseFfmpegListing(path, 43_148_705_792, [
      "[bluray @ 0x1] playlist 00805.mpls (1:42:25)",
      "  Stream #0:0: Video: h264, 1920x1080",
      "  Stream #0:1(eng): Audio: dts, 48000 Hz, 7.1",
    ].join("\n"));
    expect(listed.sourceMethod).toBe("iso_ffmpeg");
    expect(listed.isoPlaylist).toBe(805);
    expect(isoInspectionLooksStale(listed, path)).toBe(false);
    expect(isoInspectionLooksStale(listed, "/mnt/nas/Cars 3.mkv")).toBe(false);
  });

  it("reads playlist languages from stream parens and bluray lang lines", () => {
    const parens = parseFfmpegListing("/mnt/nas/Cars 3.iso", 40_000_000_000, [
      "[bluray @ 0x1] playlist 00805.mpls (1:42:25)",
      "  Stream #0:0: Video: h264, 1920x1080",
      "  Stream #0:1(eng): Audio: dts, 48000 Hz, 7.1",
      "  Stream #0:2(spa): Subtitle: hdmv_pgs_subtitle",
    ].join("\n"));
    expect(parens.audio[0]?.language).toBe("eng");
    expect(parens.subtitles[0]?.language).toBe("spa");
    const fromLangLines = parseFfmpegListing("/mnt/nas/Cars 3.iso", 40_000_000_000, [
      "[bluray @ 0x1] playlist 00805.mpls (1:42:25)",
      "[bluray @ 0x1] stream 1: Audio lang=eng",
      "[bluray @ 0x1] stream 2: Subtitle language: spa",
      "  Stream #0:0: Video: h264, 1920x1080",
      "  Stream #0:1: Audio: dts, 48000 Hz, 7.1",
      "  Stream #0:2: Subtitle: hdmv_pgs_subtitle",
    ].join("\n"));
    expect(fromLangLines.audio[0]?.language).toBe("eng");
    expect(fromLangLines.audio[0]?.untagged).toBe(false);
    expect(fromLangLines.subtitles[0]?.language).toBe("spa");
    const unknown = parseFfmpegListing("/mnt/nas/Cars 3.iso", 40_000_000_000, [
      "  Stream #0:0: Video: h264, 1920x1080",
      "  Stream #0:1: Audio: dts, 48000 Hz, 7.1",
    ].join("\n"));
    expect(unknown.audio[0]?.language).toBe("und");
    expect(unknown.audio[0]?.untagged).toBe(true);
  });
});
