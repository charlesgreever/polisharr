import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInspectionRunner } from "./inspection-runner.ts";
import { Store } from "./store.ts";

describe("inspection runner", () => {
  it("records a file error when the bytes end before the inspected duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-truncated-"));
    const store = new Store(join(dir, "polisharr.db"));
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "packed",
      enabled: true,
    });
    const itemId = `${instanceId}:movie:396`;
    const path = join(dir, "crystal-skull.mkv");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "short");
    store.upsertItem({
      id: itemId,
      instanceId,
      arrId: 396,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Indiana Jones and the Kingdom of the Crystal Skull",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path,
      sizeBytes: 3_261_071_360,
      quality: "Remux-1080p",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    const ends: string[] = [];
    const runner = createInspectionRunner({
      store,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      readable: async () => true,
      probe: async () => ({
        format: { duration: "16984.729", bit_rate: "1536001" },
        streams: [
          { index: 0, codec_type: "video", codec_name: "hevc", width: 1920, height: 800, tags: { "DURATION-eng": "02:06:01.679000000", "NUMBER_OF_BYTES-eng": "10863736220" } },
          { index: 1, codec_type: "audio", codec_name: "dts", channels: 6, bit_rate: "1536000", tags: { "DURATION-eng": "02:06:01.718000000", "NUMBER_OF_BYTES-eng": "1426329000" } },
        ],
      }),
      probeEnd: async (file) => {
        ends.push(file);
        return 2896.894;
      },
      recomputeSuggestion: () => undefined,
    });

    const result = await runner.inspectOne(itemId);

    expect(result.ok).toBe(true);
    expect(result.report?.durationSec).toBeCloseTo(2 * 3600 + 6 * 60 + 1.718, 2);
    expect(ends).toEqual([path]);
    expect(store.listErrors()).toEqual([
      expect.objectContaining({
        itemId,
        path,
        reason: "The source file ends at 48 minutes. Polisharr's inspection says this title is 126 minutes. Polisharr did not offer this short copy for review.",
      }),
    ]);
    store.close();
  });

  it("reinspects the promoted path before reporting success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-reinspect-"));
    const store = new Store(join(dir, "polisharr.db"));
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "packed",
      enabled: true,
    });
    const itemId = `${instanceId}:movie:10`;
    const oldPath = join(dir, "movie.iso");
    const promotedPath = join(dir, "movie.mkv");
    store.upsertItem({
      id: itemId,
      instanceId,
      arrId: 10,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: oldPath,
      sizeBytes: 9,
      quality: "Bluray-1080p",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    store.updateItemFile(itemId, promotedPath, 4);
    const probed: string[] = [];
    const runner = createInspectionRunner({
      store,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      readable: async () => true,
      probe: async (path) => {
        probed.push(path);
        return {
          format: { duration: "3600" },
          streams: [{ codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 }],
        };
      },
      recomputeSuggestion: () => undefined,
    });

    const result = await runner.reinspectChangedItem(itemId, oldPath);

    expect(result.ok).toBe(true);
    expect(result.report?.sourceSig).toBe(`${promotedPath}|4`);
    expect(probed).toEqual([promotedPath]);
    store.close();
  });

  it("turns an unexpected readability failure into a visible reinspection warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-reinspect-error-"));
    const store = new Store(join(dir, "polisharr.db"));
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "packed",
      enabled: true,
    });
    const itemId = `${instanceId}:movie:10`;
    const promotedPath = join(dir, "movie.mkv");
    store.upsertItem({
      id: itemId,
      instanceId,
      arrId: 10,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: promotedPath,
      sizeBytes: 4,
      quality: "Bluray-1080p",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    const runner = createInspectionRunner({
      store,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      readable: async () => {
        throw new Error("The mount disappeared.");
      },
      recomputeSuggestion: () => undefined,
    });

    const result = await runner.reinspectChangedItem(itemId, promotedPath);

    expect(result).toEqual({ ok: false, warning: "The mount disappeared." });
    expect(store.listErrors()).toEqual([
      expect.objectContaining({ itemId, path: promotedPath, reason: "The mount disappeared." }),
    ]);
    store.close();
  });

  it("relists an ISO that still has a dummy ffprobe AC3 report at the same path and size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-iso-stale-"));
    const store = new Store(join(dir, "polisharr.db"));
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "packed",
      enabled: true,
    });
    const itemId = `${instanceId}:movie:438`;
    const path = join(dir, "Cars 3 (2017)[BR-DISK].iso");
    store.upsertItem({
      id: itemId,
      instanceId,
      arrId: 438,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Cars 3",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path,
      sizeBytes: 43,
      quality: "Bluray-1080p",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    store.saveInspection(itemId, {
      sourceSig: `${path}|43`,
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 10_787_176.448,
      isoPlaylist: null,
      sizeBytes: 43,
      sizePerHourGb: 0.01,
      videoCodec: "unknown",
      width: 0,
      height: 0,
      bitDepth: 8,
      hdr: "none",
      audio: [{ index: 0, language: "und", channels: 2, codec: "ac3", title: "", untagged: true, commentary: false }],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    });
    let listed = 0;
    const runner = createInspectionRunner({
      store,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      readable: async () => true,
      probe: async () => {
        throw new Error("ffprobe must not run on an ISO.");
      },
      listIso: async () => {
        listed += 1;
        return [
          "[bluray @ 0x1] playlist 00805.mpls (1:42:25)",
          "  Stream #0:0: Video: h264, 1920x1080",
          "  Stream #0:1(eng): Audio: dts, 48000 Hz, 7.1",
        ].join("\n");
      },
      recomputeSuggestion: () => undefined,
    });

    expect(runner.leftoverCount()).toBe(1);
    await runner.inspectPending();
    expect(listed).toBe(1);
    const report = store.getInspection(itemId);
    expect(report?.sourceMethod).toBe("iso_ffmpeg");
    expect(report?.isoPlaylist).toBe(805);
    expect(report?.width).toBe(1920);
    expect(report?.audio[0]?.codec).toBe("dts");
    expect(runner.leftoverCount()).toBe(0);
    store.close();
  });

  it("does not put a missing path or a failed ISO listing on Errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-inspect-missing-"));
    const store = new Store(join(dir, "polisharr.db"));
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "packed",
      enabled: true,
    });
    const missingId = `${instanceId}:movie:1`;
    const isoId = `${instanceId}:movie:2`;
    store.upsertItem({
      id: missingId,
      instanceId,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Moana",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: join(dir, "Moana (2026)"),
      sizeBytes: 0,
      quality: "",
      resolution: "",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    store.upsertItem({
      id: isoId,
      instanceId,
      arrId: 2,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Cars 3",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: join(dir, "Cars 3.iso"),
      sizeBytes: 40,
      quality: "Bluray-1080p",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    writeFileSync(join(dir, "Cars 3.iso"), "iso");
    const runner = createInspectionRunner({
      store,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      probe: async () => {
        throw new Error("ffprobe must not run on a missing file.");
      },
      listIso: async () => {
        throw new Error("ffmpeg could not list streams on this disc image.");
      },
      recomputeSuggestion: () => undefined,
    });

    await runner.inspectPending();
    expect(store.listErrors()).toEqual([]);
    expect(store.getInspection(isoId)?.listingState).toBe("iso_unlisted");
    store.close();
  });

  it("does not ffprobe a movie folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-inspect-dir-"));
    const store = new Store(join(dir, "polisharr.db"));
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "packed",
      enabled: true,
    });
    const folder = join(dir, "John Wick Chapter 3 - Parabellum (2019)");
    mkdirSync(folder);
    const itemId = `${instanceId}:movie:241`;
    store.upsertItem({
      id: itemId,
      instanceId,
      arrId: 241,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "John Wick: Chapter 3 - Parabellum",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: folder,
      sizeBytes: 0,
      quality: "",
      resolution: "",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    let probed = 0;
    const runner = createInspectionRunner({
      store,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      probe: async () => {
        probed += 1;
        throw new Error("ffprobe must not run on a folder.");
      },
      recomputeSuggestion: () => undefined,
    });

    await runner.inspectPending();
    expect(probed).toBe(0);
    expect(store.listErrors()).toEqual([]);
    expect(runner.leftoverCount()).toBe(0);
    store.close();
  });

  it("probes a shared episode file once and copies the report to the sibling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-shared-inspect-"));
    const store = new Store(join(dir, "polisharr.db"));
    const instanceId = store.upsertInstance({
      kind: "sonarr",
      name: "TV",
      url: "http://sonarr",
      secret: null,
      enabled: true,
    });
    const path = join(dir, "Paw Patrol - S08E35-E36.mkv");
    writeFileSync(path, "MEDIA");
    const e35 = `${instanceId}:episode:35`;
    const e36 = `${instanceId}:episode:36`;
    for (const [id, episode] of [[e35, 35], [e36, 36]] as const) {
      store.upsertItem({
        id,
        instanceId,
        arrId: episode,
        arrSeriesId: 8,
        arrEpisodeFileId: 99,
        type: "episode",
        title: "Paw Patrol",
        showTitle: "Paw Patrol",
        season: 8,
        episode,
        episodeTitle: "Rescue Knights",
        path,
        sizeBytes: 5,
        quality: "WEBDL-1080p",
        resolution: "1080",
        profile: "HD",
        tags: [],
        posterRemoteUrl: null,
        sizeExempt: false,
      });
    }
    let probed = 0;
    const runner = createInspectionRunner({
      store,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      readable: async () => true,
      probe: async () => {
        probed += 1;
        return {
          format: { duration: "1200" },
          streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }],
        };
      },
      recomputeSuggestion: () => undefined,
    });

    await runner.inspectPending();
    expect(probed).toBe(1);
    expect(store.getInspection(e35)?.sourceSig).toBe(`${path}|5`);
    expect(store.getInspection(e36)?.sourceSig).toBe(`${path}|5`);
    expect(runner.leftoverCount()).toBe(0);
    store.close();
  });
});
