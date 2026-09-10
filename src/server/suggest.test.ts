import { describe, expect, it } from "vitest";
import { buildSuggestion, sizeCategory } from "./suggest.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import type { InspectionReport, LibraryItem } from "./types.ts";

const movie: LibraryItem = {
  id: "m1",
  instanceId: "radarr",
  instanceName: "Radarr 4K",
  arrId: 1,
  arrSeriesId: null,
  arrEpisodeFileId: null,
  type: "movie",
  title: "Avatar",
  showTitle: null,
  season: null,
  episode: null,
  episodeTitle: null,
  path: "/mnt/nas/Avatar.mkv",
  sizeBytes: 16_000_000_000,
  quality: "WEBDL-2160p",
  resolution: "2160",
  profile: "Ultra-HD",
  tags: [],
  posterRemoteUrl: null,
  hasPoster: false,
  sizeExempt: false,
};

function report(over: Partial<InspectionReport> = {}): InspectionReport {
  return {
    sourceSig: "p|1",
    sourceMethod: "ffprobe",
    listingState: "complete",
    durationSec: 5900,
    sizeBytes: 16_000_000_000,
    sizePerHourGb: 9.8,
    videoCodec: "h264",
    width: 3840,
    height: 2160,
    bitDepth: 10,
    hdr: "dolby_vision",
    audio: [
      { index: 1, language: "eng", channels: 8, codec: "eac3", title: "Atmos", untagged: false, commentary: false },
      { index: 2, language: "spa", channels: 2, codec: "aac", title: "", untagged: false, commentary: false },
    ],
    subtitles: [{ index: 3, language: "spa", codec: "srt", title: "", untagged: false, forced: false, sdh: false }],
    hasChapters: true,
    hasAttachments: false,
    ...over,
  };
}

describe("suggestion engine", () => {
  it("keeps a usable soundtrack when preferred-language pruning matches nothing", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({
        audio: [
          { index: 1, language: "spa", channels: 2, codec: "aac", title: "", untagged: false, commentary: false },
          { index: 2, language: "fra", channels: 2, codec: "aac", title: "", untagged: false, commentary: false },
        ],
        subtitles: [],
      }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.keepAudio).toEqual([1]);
    expect(suggestion?.stripAudio).toEqual([2]);
  });
  it("does not transcode a file that is only a little over the size cap", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({
        sizePerHourGb: 8.2,
        videoCodec: "hevc",
        audio: [{ index: 1, language: "eng", channels: 6, codec: "eac3", title: "", untagged: false, commentary: false }],
        subtitles: [{ index: 2, language: "eng", codec: "srt", title: "", untagged: false, forced: false, sdh: false }],
        hdr: "hdr10",
      }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.actions ?? []).not.toContain("transcode");
  });

  it("scores a 2160p HDR movie against the 4K HDR cap", () => {
    expect(sizeCategory(movie, report())).toBe("movie4kHdr");
    const suggestion = buildSuggestion({
      item: movie,
      report: report(),
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.after.sizePerHourGb).toBe(8);
    expect(suggestion?.reasons.some((r) => r.includes("8.00"))).toBe(true);
    expect(suggestion?.warning).toMatch(/Dolby Vision/);
  });

  it("scores a 2160p HDR episode against the TV 4K HDR cap, not the SDR TV 4K cap", () => {
    const episode: LibraryItem = {
      ...movie,
      id: "e1",
      instanceId: "sonarr",
      instanceName: "Sonarr",
      type: "episode",
      title: "Driftmark",
      showTitle: "House of the Dragon",
      season: 1,
      episode: 7,
      quality: "Bluray-2160p",
    };
    expect(sizeCategory(episode, report({ hdr: "hdr10", sizePerHourGb: 5 }))).toBe("tv4kHdr");
    expect(sizeCategory(episode, report({ hdr: "none", sizePerHourGb: 5, bitDepth: 8 }))).toBe("tv4k");
    const hdr = buildSuggestion({
      item: episode,
      report: report({ hdr: "hdr10", videoCodec: "hevc", sizePerHourGb: 9, audio: [
        { index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false },
      ], subtitles: [] }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(hdr?.category).toBe("tv4kHdr");
    expect(hdr?.after.sizePerHourGb).toBe(6);
  });

  it("does not transcode Dolby Vision Profile 5 because the picture would look yellow", () => {
    const episode: LibraryItem = {
      ...movie,
      id: "e1",
      type: "episode",
      title: "A Son for a Son",
      showTitle: "House of the Dragon",
    };
    const suggestion = buildSuggestion({
      item: episode,
      report: report({
        hdr: "dolby_vision",
        doviProfile: 5,
        doviCompatId: 0,
        videoCodec: "hevc",
        sizePerHourGb: 9,
        audio: [{ index: 1, language: "eng", channels: 6, codec: "eac3", title: "", untagged: false, commentary: false }],
        subtitles: [],
      }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "av1",
      av1Available: true,
    });
    expect(suggestion?.actions ?? []).not.toContain("transcode");
    expect(suggestion?.actions ?? []).toContain("search_release");
    expect(suggestion?.warning ?? "").toMatch(/Profile 5/);
    expect(suggestion?.warning ?? "").toMatch(/yellow/);
    expect(suggestion?.reasons.some((reason) => /Profile 8|HDR10/.test(reason))).toBe(true);
  });

  it("marks a transcode when no hardware encoder is available", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({ hdr: "none" }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
      hardwareAvailable: false,
    });

    expect(suggestion?.warning).toMatch(/Hardware encode is unavailable/);
  });

  it("keeps preferred tracks and suggests stereo for Atmos", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "hevc" }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.actions).toContain("tracks");
    expect(suggestion?.actions).toContain("add_stereo");
    expect(suggestion?.actions).not.toContain("transcode");
    expect(suggestion?.keepAudio).toEqual([1]);
    expect(suggestion?.after.sizePerHourGb).toBeNull();
  });

  it("suggests stereo for 5.1 when the series prefers stereo, and skips Atmos when it prefers surround", () => {
    const fivePointOne = report({
      sizePerHourGb: 1,
      videoCodec: "hevc",
      audio: [{ index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false }],
      subtitles: [],
    });
    const house = buildSuggestion({
      item: movie,
      report: fivePointOne,
      settings: DEFAULT_SETTINGS,
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const kids = buildSuggestion({
      item: movie,
      report: fivePointOne,
      settings: DEFAULT_SETTINGS,
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
      audioMix: "stereo",
    });
    const surround = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "hevc" }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
      audioMix: "surround",
    });
    expect(house?.actions ?? []).not.toContain("add_stereo");
    expect(kids?.actions).toEqual(["tracks", "add_stereo"]);
    expect(kids?.keepAudio).toEqual([]);
    expect(kids?.stripAudio).toEqual([1]);
    expect(kids?.stereoSource).toBe(1);
    expect(kids?.reasons.some((reason) => /Replace surround/i.test(reason))).toBe(true);
    expect(surround?.actions ?? []).not.toContain("add_stereo");
  });

  it("drops surround and keeps existing stereo when the series prefers stereo", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({
        sizePerHourGb: 1,
        videoCodec: "hevc",
        audio: [
          { index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
          { index: 2, language: "eng", channels: 2, codec: "aac", title: "", untagged: false, commentary: false },
        ],
        subtitles: [],
      }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
      audioMix: "stereo",
    });
    expect(suggestion?.actions).toEqual(["tracks"]);
    expect(suggestion?.keepAudio).toEqual([2]);
    expect(suggestion?.stripAudio).toEqual([1]);
    expect(suggestion?.actions).not.toContain("add_stereo");
    expect(suggestion?.reasons.some((reason) => /Drop surround/i.test(reason))).toBe(true);
  });

  it("keeps non-preferred audio when automatic audio cleanup is disabled", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "hevc" }),
      settings: {
        ...DEFAULT_SETTINGS,
        suggestionDefaults: {
          ...DEFAULT_SETTINGS.suggestionDefaults,
          removeNonPreferredAudio: false,
        },
      },
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.keepAudio).toEqual([1, 2]);
    expect(suggestion?.stripAudio).toEqual([]);
    expect(suggestion?.stripSubs).toEqual([3]);
    expect(suggestion?.reasons.some((reason) => /audio/i.test(reason))).toBe(false);
  });

  it("disables every automatic operation without disabling manual overrides", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      suggestionDefaults: {
        removeNonPreferredSubtitles: false,
        removeNonPreferredAudio: false,
        addStereo: false,
        transcodeToSizeCap: false,
        transcodeBelowHevc: false,
        convertMp4ToMkv: false,
        convertIsoToMkv: false,
        searchPreferredLanguage: false,
        queueNewImports: false,
      },
    };
    const automatic = buildSuggestion({
      item: movie,
      report: report(),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const forcedStereo = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "hevc" }),
      settings,
      sizeExempt: false,
      excluded: false,
      forceStereo: true,
      videoTarget: "hevc",
      av1Available: false,
    });
    const forcedTranscode = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1 }),
      settings,
      sizeExempt: false,
      excluded: false,
      forceTranscode: true,
      videoTarget: "hevc",
      av1Available: false,
    });

    expect(automatic).toBeNull();
    expect(forcedStereo?.actions).toEqual(["add_stereo"]);
    expect(forcedTranscode?.actions).toEqual(["transcode"]);
  });

  it("adds an opt-in remux to MP4 suggestions and preserves MKV and disabled behavior", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      suggestionDefaults: {
        ...DEFAULT_SETTINGS.suggestionDefaults,
        removeNonPreferredSubtitles: false,
        removeNonPreferredAudio: false,
        addStereo: false,
        convertMp4ToMkv: true,
      },
    };
    const underCap = report({ sizePerHourGb: 1, videoCodec: "hevc", audio: [], subtitles: [], hdr: "none" });
    const overCap = report({ audio: [], subtitles: [], hdr: "none" });
    const remuxOnlyMp4 = buildSuggestion({
      item: { ...movie, path: "/mnt/nas/Avatar.MP4" },
      report: underCap,
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const underCapMkv = buildSuggestion({
      item: movie,
      report: underCap,
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const remuxThenTranscode = buildSuggestion({
      item: { ...movie, path: "/mnt/nas/Avatar.mp4" },
      report: overCap,
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const mkvTranscode = buildSuggestion({
      item: movie,
      report: overCap,
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const disabledMp4 = buildSuggestion({
      item: { ...movie, path: "/mnt/nas/Avatar.mp4" },
      report: overCap,
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });

    expect(remuxOnlyMp4?.actions).toEqual(["remux"]);
    expect(remuxOnlyMp4?.reasons).toEqual(["Convert the MP4 container to MKV before any video encode."]);
    expect(underCapMkv).toBeNull();
    expect(remuxThenTranscode?.actions).toEqual(["transcode", "remux"]);
    expect(mkvTranscode?.actions).toEqual(["transcode"]);
    expect(disabledMp4?.actions).toEqual(["transcode"]);
  });

  it("does not suggest HEVC for AV1 sources", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({ videoCodec: "av1", sizePerHourGb: 20 }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.actions ?? []).not.toContain("transcode");
  });

  it("applies bulk size and track rules to a listed ISO report", () => {
    const iso = {
      ...movie,
      path: "/mnt/nas/discs/Example.iso",
      quality: "Bluray-1080p",
      resolution: "1080",
    };
    const listed = report({
      sourceMethod: "iso_ffmpeg",
      listingState: "complete",
      videoCodec: "mpeg2video",
      width: 1920,
      height: 1080,
      sizePerHourGb: 8,
      hdr: "none",
      bitDepth: 8,
    });
    const suggestion = buildSuggestion({
      item: iso,
      report: listed,
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.actions).toContain("transcode");
    expect(suggestion?.actions).toContain("tracks");
    expect(suggestion?.actions).toContain("add_stereo");
  });

  it("does not invent bulk work for an unlisted ISO", () => {
    const suggestion = buildSuggestion({
      item: { ...movie, path: "/mnt/nas/discs/Broken.iso" },
      report: report({ sourceMethod: "iso_ffmpeg", listingState: "iso_unlisted", videoCodec: "unknown", audio: [], subtitles: [], sizePerHourGb: 0, width: 0, height: 0 }),
      settings: DEFAULT_SETTINGS,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion).toBeNull();
  });

  it("adds an opt-in remux for ISO disc images including an unlisted disc", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      suggestionDefaults: {
        ...DEFAULT_SETTINGS.suggestionDefaults,
        removeNonPreferredSubtitles: false,
        removeNonPreferredAudio: false,
        addStereo: false,
        transcodeToSizeCap: false,
        convertIsoToMkv: true,
      },
    };
    const listed = buildSuggestion({
      item: { ...movie, path: "/mnt/nas/discs/Cars 3.ISO" },
      report: report({
        sourceMethod: "iso_ffmpeg",
        listingState: "complete",
        videoCodec: "h264",
        sizePerHourGb: 1,
        audio: [],
        subtitles: [],
        hdr: "none",
      }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const unlisted = buildSuggestion({
      item: { ...movie, path: "/mnt/nas/discs/Broken.iso" },
      report: report({
        sourceMethod: "iso_ffmpeg",
        listingState: "iso_unlisted",
        videoCodec: "unknown",
        audio: [],
        subtitles: [],
        sizePerHourGb: 0,
        width: 0,
        height: 0,
      }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(listed?.actions).toEqual(["remux"]);
    expect(listed?.reasons.some((reason) => /disc image/i.test(reason))).toBe(true);
    expect(unlisted?.actions).toEqual(["remux"]);
  });

  it("offers a preferred-language search instead of stripping the only soundtrack", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      suggestionDefaults: {
        ...DEFAULT_SETTINGS.suggestionDefaults,
        transcodeToSizeCap: false,
        addStereo: false,
        searchPreferredLanguage: true,
      },
    };
    const suggestion = buildSuggestion({
      item: movie,
      report: report({
        sizePerHourGb: 1,
        videoCodec: "hevc",
        hdr: "none",
        audio: [{ index: 1, language: "deu", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false }],
        subtitles: [],
      }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.actions).toEqual(["search_language"]);
    expect(suggestion?.keepAudio).toEqual([1]);
    expect(suggestion?.reasons.some((reason) => /preferred language/i.test(reason))).toBe(true);
  });

  it("suggests HEVC for under-cap video below HEVC when that operation is on", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      suggestionDefaults: {
        ...DEFAULT_SETTINGS.suggestionDefaults,
        transcodeToSizeCap: false,
        transcodeBelowHevc: true,
        removeNonPreferredSubtitles: false,
        removeNonPreferredAudio: false,
        addStereo: false,
      },
    };
    const h264 = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "h264", hdr: "none", audio: [], subtitles: [] }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const mpeg2 = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "mpeg2video", hdr: "none", audio: [], subtitles: [] }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const hevc = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "hevc", hdr: "none", audio: [], subtitles: [] }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    const exempt = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "h264", hdr: "none", audio: [], subtitles: [] }),
      settings,
      sizeExempt: true,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(h264?.actions).toEqual(["transcode"]);
    expect(h264?.reasons.some((reason) => reason.includes("H.264") && reason.includes("HEVC"))).toBe(true);
    expect(h264?.after.sizePerHourGb).toBe(1);
    expect(mpeg2?.reasons.some((reason) => reason.includes("MPEG-2"))).toBe(true);
    expect(hevc).toBeNull();
    expect(exempt).toBeNull();
  });

  it("suggests AV1 for under-cap HEVC when Encode Target is AV1 and below-target is on", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      videoTarget: "av1" as const,
      suggestionDefaults: {
        ...DEFAULT_SETTINGS.suggestionDefaults,
        transcodeToSizeCap: false,
        transcodeBelowHevc: true,
        removeNonPreferredSubtitles: false,
        removeNonPreferredAudio: false,
        addStereo: false,
      },
    };
    const hevc = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "hevc", hdr: "none", audio: [], subtitles: [] }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "av1",
      av1Available: true,
    });
    const av1 = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "av1", hdr: "none", audio: [], subtitles: [] }),
      settings,
      sizeExempt: false,
      excluded: false,
      videoTarget: "av1",
      av1Available: true,
    });
    const exempt = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "hevc", hdr: "none", audio: [], subtitles: [] }),
      settings,
      sizeExempt: true,
      excluded: false,
      videoTarget: "av1",
      av1Available: true,
    });
    expect(hevc?.actions).toEqual(["transcode"]);
    expect(hevc?.after.codec).toBe("AV1");
    expect(hevc?.reasons.some((reason) => reason.includes("HEVC") && reason.includes("AV1"))).toBe(true);
    expect(av1).toBeNull();
    expect(exempt).toBeNull();
  });

  it("uses AV1 as the bulk target when Settings and hardware allow it", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({ sizePerHourGb: 1, videoCodec: "h264", hdr: "none", audio: [], subtitles: [] }),
      settings: {
        ...DEFAULT_SETTINGS,
        videoTarget: "av1",
        suggestionDefaults: {
          ...DEFAULT_SETTINGS.suggestionDefaults,
          transcodeToSizeCap: false,
          transcodeBelowHevc: true,
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: false,
        },
      },
      sizeExempt: false,
      excluded: false,
      videoTarget: "av1",
      av1Available: true,
    });
    expect(suggestion?.after.codec).toBe("AV1");
    expect(suggestion?.reasons.some((reason) => reason.includes("AV1"))).toBe(true);
  });

  it("keeps a single transcode when size-cap and below-HEVC both apply", () => {
    const suggestion = buildSuggestion({
      item: movie,
      report: report({ videoCodec: "h264", hdr: "none", audio: [], subtitles: [] }),
      settings: {
        ...DEFAULT_SETTINGS,
        suggestionDefaults: {
          ...DEFAULT_SETTINGS.suggestionDefaults,
          transcodeBelowHevc: true,
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: false,
        },
      },
      sizeExempt: false,
      excluded: false,
      videoTarget: "hevc",
      av1Available: false,
    });
    expect(suggestion?.actions).toEqual(["transcode"]);
    expect(suggestion?.reasons.some((reason) => /size cap/i.test(reason))).toBe(true);
    expect(suggestion?.reasons.some((reason) => reason.includes("H.264"))).toBe(true);
    expect(suggestion?.after.sizePerHourGb).toBe(6);
  });

  describe("size after planned track cleanup", () => {
    const bluray1080p: LibraryItem = {
      ...movie,
      quality: "Bluray-1080p",
      resolution: "1080",
      path: "/mnt/nas/Movies/Example (1997)/Example.mkv",
    };

    function extraLanguageAudio(startIndex: number, count: number): InspectionReport["audio"] {
      const langs = ["spa", "fra", "deu", "ita", "jpn", "rus", "pol", "hun"];
      return Array.from({ length: count }, (_, i) => ({
        index: startIndex + i,
        language: langs[i % langs.length]!,
        channels: 6,
        codec: "ac3",
        title: "",
        untagged: false,
        commentary: false,
      }));
    }

    it("does not transcode HEVC that is over the cap only because of extra languages", () => {
      const suggestion = buildSuggestion({
        item: bluray1080p,
        report: report({
          durationSec: 3600,
          sizeBytes: Math.round(3.5 * 1024 ** 3),
          sizePerHourGb: 3.5,
          videoCodec: "hevc",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [
            { index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
            ...extraLanguageAudio(2, 8),
          ],
          subtitles: [
            { index: 10, language: "eng", codec: "subrip", title: "", untagged: false, forced: false, sdh: false },
            { index: 11, language: "spa", codec: "hdmv_pgs_subtitle", title: "", untagged: false, forced: false, sdh: false },
          ],
        }),
        settings: DEFAULT_SETTINGS,
        sizeExempt: false,
        excluded: false,
        videoTarget: "hevc",
        av1Available: false,
      });
      expect(suggestion?.actions).toEqual(["tracks"]);
      expect(suggestion?.actions ?? []).not.toContain("transcode");
      expect(suggestion?.after.sizeBytes).toBeNull();
      expect(suggestion?.after.sizePerHourGb).toBeNull();
    });

    it("transcodes when the file is still over the cap after extra languages drop", () => {
      const suggestion = buildSuggestion({
        item: bluray1080p,
        report: report({
          durationSec: 3600,
          sizeBytes: Math.round(16 * 1024 ** 3),
          sizePerHourGb: 16,
          videoCodec: "hevc",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [
            { index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
            { index: 2, language: "spa", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
          ],
          subtitles: [{ index: 3, language: "spa", codec: "subrip", title: "", untagged: false, forced: false, sdh: false }],
        }),
        settings: DEFAULT_SETTINGS,
        sizeExempt: false,
        excluded: false,
        videoTarget: "hevc",
        av1Available: false,
      });
      expect(suggestion?.actions).toEqual(["transcode", "tracks"]);
      expect(suggestion?.reasons.some((reason) => /after dropping extra languages/i.test(reason))).toBe(true);
      expect(suggestion?.reasons.some((reason) => reason.includes("2.50"))).toBe(true);
      expect(suggestion?.after.sizePerHourGb).toBe(2.5);
      expect(suggestion?.mustEncode).toBe(false);
    });

    it("skips a size transcode when kept TrueHD already fills the 1080p cap", () => {
      const suggestion = buildSuggestion({
        item: bluray1080p,
        report: report({
          durationSec: 7492.96,
          sizeBytes: 39_392_987_136,
          sizePerHourGb: 17.626583022551593,
          videoCodec: "hevc",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [
            { index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false },
            { index: 2, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
            { index: 3, language: "eng", channels: 2, codec: "ac3", title: "", untagged: false, commentary: false },
            ...extraLanguageAudio(4, 8),
          ],
          subtitles: [
            { index: 12, language: "eng", codec: "hdmv_pgs_subtitle", title: "", untagged: false, forced: false, sdh: false },
            { index: 13, language: "spa", codec: "hdmv_pgs_subtitle", title: "", untagged: false, forced: false, sdh: false },
          ],
        }),
        settings: DEFAULT_SETTINGS,
        sizeExempt: false,
        excluded: false,
        videoTarget: "hevc",
        av1Available: false,
      });
      expect(suggestion?.actions).toEqual(["tracks"]);
      expect(suggestion?.after.sizeBytes).toBeNull();
      expect(suggestion?.after.sizePerHourGb).toBeNull();
      expect(suggestion?.warning).toMatch(/soundtrack you keep already uses the 2\.50 GB\/hr size cap/i);
    });

    it("still transcodes H.264 when TrueHD fills the cap and the codec toggle is on", () => {
      const suggestion = buildSuggestion({
        item: bluray1080p,
        report: report({
          durationSec: 7492.96,
          sizeBytes: 39_392_987_136,
          sizePerHourGb: 17.626583022551593,
          videoCodec: "h264",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [
            { index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false },
            { index: 2, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
            { index: 3, language: "eng", channels: 2, codec: "ac3", title: "", untagged: false, commentary: false },
            ...extraLanguageAudio(4, 8),
          ],
          subtitles: [
            { index: 12, language: "eng", codec: "hdmv_pgs_subtitle", title: "", untagged: false, forced: false, sdh: false },
            { index: 13, language: "spa", codec: "hdmv_pgs_subtitle", title: "", untagged: false, forced: false, sdh: false },
          ],
        }),
        settings: {
          ...DEFAULT_SETTINGS,
          suggestionDefaults: {
            ...DEFAULT_SETTINGS.suggestionDefaults,
            transcodeBelowHevc: true,
          },
        },
        sizeExempt: false,
        excluded: false,
        videoTarget: "hevc",
        av1Available: false,
      });
      expect(suggestion?.actions).toContain("transcode");
      expect(suggestion?.actions).toContain("tracks");
      expect(suggestion?.mustEncode).toBe(true);
      expect(suggestion?.after.sizePerHourGb).not.toBe(2.5);
      expect(suggestion?.after.sizeBytes).toBeGreaterThan(2.5 * (7492.96 / 3600) * 1024 ** 3);
      expect(suggestion?.reasons.some((reason) => /size cap/i.test(reason))).toBe(false);
      expect(suggestion?.reasons.some((reason) => reason.includes("H.264"))).toBe(true);
      expect(suggestion?.warning).toMatch(/soundtrack you keep already uses the 2\.50 GB\/hr size cap/i);
    });

    it("forces a transcode on an audio-bound title with a raised target", () => {
      const suggestion = buildSuggestion({
        item: bluray1080p,
        report: report({
          durationSec: 7492.96,
          sizeBytes: 39_392_987_136,
          sizePerHourGb: 17.626583022551593,
          videoCodec: "hevc",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [
            { index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false },
            { index: 2, language: "eng", channels: 2, codec: "ac3", title: "", untagged: false, commentary: false },
          ],
          subtitles: [],
        }),
        settings: DEFAULT_SETTINGS,
        sizeExempt: false,
        excluded: false,
        forceTranscode: true,
        videoTarget: "hevc",
        av1Available: false,
      });
      expect(suggestion?.actions).toEqual(["transcode"]);
      expect(suggestion?.mustEncode).toBe(true);
      expect(suggestion?.after.sizePerHourGb).not.toBe(2.5);
      expect(suggestion?.reasons.some((reason) => /force/i.test(reason))).toBe(true);
    });
  });
});
