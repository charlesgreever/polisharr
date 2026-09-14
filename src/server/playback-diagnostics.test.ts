import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlaybackDiagnostics,
  describeAfterKeep,
  isPlaybackProblem,
  parsePlaybackListQuery,
  playbackDiagnosticId,
  recommendPlaybackRepair,
  revisionsMatch,
} from "./playback-diagnostics.ts";
import { Store } from "./store.ts";
import { AFTER_KEEP_NOT_YET, AFTER_KEEP_OBSERVED, DEFAULT_SETTINGS, type InspectionReport, type LibraryItem, type PlaybackOccurrence, type Suggestion } from "./types.ts";

const NOW = Date.UTC(2026, 8, 14);
const DAY = 24 * 60 * 60 * 1000;
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

function store(): Store {
  const created = new Store(join(mkdtempSync(join(tmpdir(), "opt-diag-")), "polisharr.db"));
  stores.push(created);
  return created;
}

function report(over: Partial<InspectionReport> = {}): InspectionReport {
  return {
    sourceSig: "/mnt/nas/movies/film-1080.mkv|1",
    sourceMethod: "ffprobe",
    listingState: "complete",
    durationSec: 3600,
    sizeBytes: 8_000_000_000,
    sizePerHourGb: 8,
    videoCodec: "hevc",
    width: 1920,
    height: 1080,
    bitDepth: 10,
    hdr: "none",
    audio: [{ index: 1, language: "eng", channels: 8, codec: "truehd", title: "Atmos", untagged: false, commentary: false }],
    subtitles: [{ index: 2, language: "eng", codec: "pgs", title: "", untagged: false, forced: false, sdh: false }],
    hasChapters: false,
    hasAttachments: false,
    ...over,
  };
}

function occurrence(over: Partial<PlaybackOccurrence> = {}): PlaybackOccurrence {
  return {
    id: over.id ?? "occ-1",
    connectionId: "jf",
    deviceId: "living-room",
    deviceLabel: "Living Room TV",
    sessionId: over.sessionId ?? "sess-1",
    itemId: "jf-item",
    mediaSourceId: "src-1080",
    itemName: "The Film",
    playMethod: "Transcode",
    mediaType: "Video",
    isPaused: false,
    reasons: ["Jellyfin converted the audio on Living Room TV."],
    rawReasons: ["AudioCodecNotSupported"],
    reasonFamily: "audio",
    selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
    match: "matched",
    libraryItemIds: ["film-1080"],
    path: "/mnt/nas/movies/film-1080.mkv",
    revision: {
      canonicalPath: "/mnt/nas/movies/film-1080.mkv",
      sizeBytes: 8_000_000_000,
      mtimeMs: NOW - 1000,
      fileId: "1:2",
    },
    startedAt: NOW - 60_000,
    lastSeenAt: NOW,
    endedAt: null,
    gap: false,
    ...over,
  };
}

function movie(): Omit<LibraryItem, "hasPoster" | "instanceName"> {
  return {
    id: "film-1080",
    instanceId: "radarr",
    arrId: 1,
    arrSeriesId: null,
    arrEpisodeFileId: null,
    type: "movie",
    title: "The Film",
    showTitle: null,
    season: null,
    episode: null,
    episodeTitle: null,
    path: "/mnt/nas/movies/film-1080.mkv",
    sizeBytes: 8_000_000_000,
    quality: "Bluray-1080p",
    resolution: "1080",
    profile: "HD",
    tags: [],
    posterRemoteUrl: null,
    sizeExempt: false,
  };
}

function suggestion(): Suggestion {
  return {
    id: "sug-1",
    itemId: "film-1080",
    actions: ["transcode"],
    reasons: ["Over the size cap."],
    warning: null,
    category: "movie1080p",
    estimatedSavingsBytes: 1,
    now: { codec: "hevc", quality: "Bluray-1080p", sizeBytes: 8, sizePerHourGb: 8 },
    after: { codec: "hevc", quality: "Bluray-1080p", sizeBytes: 4, sizePerHourGb: 4 },
    dismissed: false,
    keepAudio: [1],
    stripAudio: [],
    keepSubs: [2],
    stripSubs: [],
  };
}

describe("playback diagnostic decisions", () => {
  it("treats Direct Play as an observation, not a problem", () => {
    expect(isPlaybackProblem(occurrence({ playMethod: "DirectPlay", rawReasons: [], reasonFamily: null }))).toBe(false);
    expect(isPlaybackProblem(occurrence())).toBe(true);
  });

  it("drafts add-stereo for surround audio conversion without a preferred-language stereo track", () => {
    const rec = recommendPlaybackRepair({
      family: "audio",
      rawReasons: ["AudioCodecNotSupported"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
      match: "matched",
      path: "/mnt/nas/movies/film-1080.mkv",
      report: report(),
      preferredLanguage: "eng",
      suggestion: null,
      excluded: false,
    });
    expect(rec.kind).toBe("add_stereo");
    expect(rec.canRepair).toBe(true);
    expect(rec.draft).toEqual({
      video: { mode: "copy" },
      audio: [{ index: 1, action: "add_downmix", channels: 2 }],
    });
    expect(rec.explanation).toContain("keeps the original mix");
    expect(rec.explanation).not.toContain("will fix every device");
  });

  it("guides the owner to an existing stereo track instead of duplicating it", () => {
    const rec = recommendPlaybackRepair({
      family: "audio",
      rawReasons: ["AudioCodecNotSupported"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
      match: "matched",
      path: "/mnt/nas/movies/film-1080.mkv",
      report: report({
        audio: [
          { index: 1, language: "eng", channels: 8, codec: "truehd", title: "Atmos", untagged: false, commentary: false },
          { index: 2, language: "eng", channels: 2, codec: "aac", title: "Stereo", untagged: false, commentary: false },
        ],
      }),
      preferredLanguage: "eng",
      suggestion: null,
      excluded: false,
    });
    expect(rec.kind).toBe("try_existing_stereo");
    expect(rec.canRepair).toBe(false);
    expect(rec.draft).toBeNull();
    expect(rec.explanation).toContain("English stereo aac");
  });

  it("never removes subtitle tracks or picks HEVC/AV1 for video conversion", () => {
    const subtitle = recommendPlaybackRepair({
      family: "subtitle",
      rawReasons: ["SubtitleCodecNotSupported"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: 2 },
      match: "matched",
      path: "/mnt/nas/movies/film-1080.mkv",
      report: report(),
      preferredLanguage: "eng",
      suggestion: null,
      excluded: false,
    });
    expect(subtitle.kind).toBe("subtitle_guidance");
    expect(subtitle.draft?.subtitles ?? []).toEqual([]);
    expect(subtitle.explanation).toContain("will not remove");

    const video = recommendPlaybackRepair({
      family: "video",
      rawReasons: ["VideoCodecNotSupported"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
      match: "matched",
      path: "/mnt/nas/movies/film-1080.mkv",
      report: report(),
      preferredLanguage: "eng",
      suggestion: null,
      excluded: false,
    });
    expect(video.kind).toBe("video_constraint");
    expect(video.draft).toEqual({ video: { mode: "copy" } });
    expect(video.draft).not.toEqual(expect.objectContaining({ video: expect.objectContaining({ codec: "hevc" }) }));
    expect(video.canRepair).toBe(false);
    expect(video.explanation).toContain("will not pick HEVC or AV1");
  });

  it("links an existing size suggestion for bitrate limits and does not invent a target", () => {
    const rec = recommendPlaybackRepair({
      family: "bitrate",
      rawReasons: ["ContainerBitrateExceedsLimit"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
      match: "matched",
      path: "/mnt/nas/movies/film-1080.mkv",
      report: report(),
      preferredLanguage: "eng",
      suggestion: suggestion(),
      excluded: false,
    });
    expect(rec.kind).toBe("bitrate_suggestion");
    expect(rec.suggestionId).toBe("sug-1");
    expect(rec.draft?.video).toEqual({ mode: "copy" });
    expect(rec.explanation).toContain("will not invent a bitrate target");
  });

  it("explains container conversion without treating remux as a universal fix", () => {
    const rec = recommendPlaybackRepair({
      family: "container",
      rawReasons: ["ContainerNotSupported"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
      match: "matched",
      path: "/mnt/nas/movies/film-1080.mkv",
      report: report(),
      preferredLanguage: "eng",
      suggestion: null,
      excluded: false,
    });
    expect(rec.kind).toBe("container_guidance");
    expect(rec.explanation).toContain("not a universal playback fix");
  });

  it("does not recommend a repair for unknown reasons or unmatched files", () => {
    expect(recommendPlaybackRepair({
      family: "unknown",
      rawReasons: ["FutureReasonX"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
      match: "matched",
      path: "/mnt/nas/movies/film-1080.mkv",
      report: report(),
      preferredLanguage: "eng",
      suggestion: null,
      excluded: false,
    }).kind).toBe("none");
    expect(recommendPlaybackRepair({
      family: "audio",
      rawReasons: ["AudioCodecNotSupported"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
      match: "unmatched",
      path: "/mnt/nas/elsewhere.mkv",
      report: report(),
      preferredLanguage: "eng",
      suggestion: null,
      excluded: false,
    }).canRepair).toBe(false);
  });

  it("names Direct Play after Keep only when device and context match", () => {
    const before = occurrence({ lastSeenAt: NOW - 10_000 });
    const keptAt = NOW - 5_000;
    expect(describeAfterKeep({ keptAt, deviceId: "living-room", before, later: [] }).sentence).toBe(AFTER_KEEP_NOT_YET);
    expect(describeAfterKeep({
      keptAt,
      deviceId: "living-room",
      before,
      later: [occurrence({
        id: "after",
        playMethod: "DirectPlay",
        rawReasons: [],
        reasonFamily: null,
        lastSeenAt: NOW,
      })],
    }).sentence).toBe(AFTER_KEEP_OBSERVED);
    expect(describeAfterKeep({
      keptAt,
      deviceId: "living-room",
      before,
      later: [occurrence({
        id: "after",
        playMethod: "DirectPlay",
        selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: 2 },
        lastSeenAt: NOW,
      })],
    }).status).toBe("context_changed");
    expect(describeAfterKeep({ keptAt: null, deviceId: "living-room", before, later: [] }).status).toBe("none");
  });

  it("parses composed list filters and rejects invalid windows", () => {
    expect(parsePlaybackListQuery({ days: "30", client: "Living", reasonFamily: "audio", title: "Film" }, { days: 7 })).toEqual({
      ok: true,
      value: expect.objectContaining({ days: 30, client: "Living", reasonFamily: "audio", title: "Film" }),
    });
    expect(parsePlaybackListQuery({ days: "14" }, { days: 7 })).toEqual({
      ok: false,
      error: "The date window must be 7 or 30 days.",
    });
  });

  it("ranks by viewing occurrences, dismisses a revision, and rejects stale evidence", async () => {
    const db = store();
    db.upsertInstance({ id: "radarr", kind: "radarr", name: "Radarr", url: "http://radarr", enabled: true });
    db.upsertInstance({ id: "jf", kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin", enabled: true });
    db.upsertItem(movie());
    db.saveInspection("film-1080", report());
    const revision = {
      canonicalPath: "/mnt/nas/movies/film-1080.mkv",
      sizeBytes: 8_000_000_000,
      mtimeMs: NOW - 1000,
      fileId: "1:2",
    };
    db.savePlaybackOccurrence(occurrence({ id: "a1", sessionId: "s1", lastSeenAt: NOW - 3 * DAY, revision }));
    db.savePlaybackOccurrence(occurrence({ id: "a2", sessionId: "s2", lastSeenAt: NOW - DAY, revision }));
    db.savePlaybackOccurrence(occurrence({ id: "a3", sessionId: "s3", lastSeenAt: NOW - 3_000, revision }));
    db.savePlaybackOccurrence(occurrence({
      id: "b1",
      sessionId: "other",
      deviceId: "bedroom",
      deviceLabel: "Bedroom TV",
      lastSeenAt: NOW,
      revision,
    }));
    db.savePlaybackOccurrence(occurrence({
      id: "old",
      sessionId: "old",
      lastSeenAt: NOW - 8 * DAY,
      revision,
    }));
    const diagnostics = createPlaybackDiagnostics({
      store: db,
      clock: () => NOW,
      statFile: async () => revision,
    });
    const listed = diagnostics.listDiagnostics({ offset: 0, limit: 50, days: 7 });
    expect(listed.windowDays).toBe(7);
    expect(listed.items.map((row) => row.deviceId)).toEqual(["living-room", "bedroom"]);
    expect(listed.items[0]?.occurrenceCount).toBe(3);
    expect(listed.items[1]?.occurrenceCount).toBe(1);
    expect(listed.total).toBe(2);

    const living = listed.items[0]!;
    expect(living.id).toBe(playbackDiagnosticId({
      connectionId: "jf",
      deviceId: "living-room",
      reasonFamily: "audio",
      match: "matched",
      libraryItemIds: ["film-1080"],
      revision,
      path: "/mnt/nas/movies/film-1080.mkv",
      jellyfinItemId: "jf-item",
    }));
    expect(diagnostics.dismiss(living.id)).toEqual({ ok: true });
    expect(diagnostics.listDiagnostics({ offset: 0, limit: 50, days: 7 }).items.map((row) => row.deviceId)).toEqual(["bedroom"]);

    db.savePlaybackOccurrence(occurrence({
      id: "new-rev",
      sessionId: "new-rev",
      lastSeenAt: NOW,
      revision: { ...revision, sizeBytes: 9_000_000_000, fileId: "1:9" },
    }));
    const afterNewFile = diagnostics.listDiagnostics({ offset: 0, limit: 50, days: 7 });
    expect(afterNewFile.items.some((row) => row.deviceId === "living-room" && row.revision?.sizeBytes === 9_000_000_000)).toBe(true);

    const stale = createPlaybackDiagnostics({
      store: db,
      clock: () => NOW,
      statFile: async () => ({ ...revision, sizeBytes: 1, fileId: "changed" }),
    });
    const draft = await stale.repairDraft(afterNewFile.items.find((row) => row.revision?.sizeBytes === 9_000_000_000)!.id);
    expect(draft).toMatchObject({ status: 409 });
  });

  it("returns an add-stereo draft without creating a job", async () => {
    const db = store();
    db.upsertInstance({ id: "radarr", kind: "radarr", name: "Radarr", url: "http://radarr", enabled: true });
    db.upsertInstance({ id: "jf", kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin", enabled: true });
    db.upsertItem(movie());
    db.saveInspection("film-1080", report());
    const revision = occurrence().revision;
    db.savePlaybackOccurrence(occurrence({ revision }));
    const diagnostics = createPlaybackDiagnostics({
      store: db,
      clock: () => NOW,
      statFile: async () => revision,
    });
    const id = diagnostics.listDiagnostics({ offset: 0, limit: 10, days: 7 }).items[0]!.id;
    const result = await diagnostics.repairDraft(id);
    expect(result).toMatchObject({
      ok: true,
      repair: {
        itemId: "film-1080",
        href: "/movies/film-1080",
        kind: "add_stereo",
        draft: { video: { mode: "copy" }, audio: [{ index: 1, action: "add_downmix", channels: 2 }] },
      },
    });
    expect(db.listJobs()).toEqual([]);
  });
});

describe("revision comparison", () => {
  it("requires path, size, mtime, and file id to match", () => {
    const left = { canonicalPath: "/a", sizeBytes: 1, mtimeMs: 2, fileId: "3" };
    expect(revisionsMatch(left, { ...left })).toBe(true);
    expect(revisionsMatch(left, { ...left, sizeBytes: 9 })).toBe(false);
    expect(revisionsMatch(left, null)).toBe(false);
  });
});

describe("list query defaults", () => {
  it("defaults diagnostics to seven days and observations callers can pass thirty", () => {
    expect(parsePlaybackListQuery({}, { days: 7 }).ok && parsePlaybackListQuery({}, { days: 7 }).ok
      ? (parsePlaybackListQuery({}, { days: 7 }) as { value: { days: number } }).value.days
      : null).toBe(7);
    expect((parsePlaybackListQuery({}, { days: 30 }) as { ok: true; value: { days: number } }).value.days).toBe(30);
    expect((parsePlaybackListQuery({ limit: "500" }, { days: 7 }) as { ok: true; value: { limit: number } }).value.limit).toBe(100);
    expect(DEFAULT_SETTINGS.suggestionDefaults.queueNewImports).toBe(false);
  });
});
