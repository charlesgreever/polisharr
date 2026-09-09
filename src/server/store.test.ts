import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.ts";

describe("store schema migration", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  it("adds a missing jobs.position column on an existing database", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-schema-"));
    const path = join(dir, "polisharr.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        suggestion_id TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        warning TEXT,
        run_now INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO jobs (id, item_id, suggestion_id, status, phase, progress, error, warning, run_now, plan, created_at) VALUES (?, ?, NULL, 'queued', 'queued', 0, NULL, NULL, 0, '{}', 1)",
      )
      .run("job-1", "item-1");
    legacy.close();

    const store = new Store(path);
    stores.push(store);
    const jobs = store.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe("job-1");
  });

  it("defaults an existing settings row to sidecar write mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-settings-"));
    const path = join(dir, "polisharr.db");
    const store = new Store(path);
    stores.push(store);
    store.saveSettings({
      ...store.getSettings(),
      preferredLanguage: "eng",
      languageConfirmed: true,
      reviewPath: "/review",
    });
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.getSettings().writeMode).toBe("sidecar");
    reopened.saveSettings({ ...reopened.getSettings(), writeMode: "direct" });
    const again = new Store(path);
    stores.push(again);
    expect(again.getSettings().writeMode).toBe("direct");
  });

  it("persists this machine as a cluster node across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-nodes-"));
    const path = join(dir, "polisharr.db");
    const store = new Store(path);
    stores.push(store);
    const id = store.localNodeId();
    store.upsertNode({
      id,
      name: "homeserver",
      role: "standalone",
      lastSeen: 1,
      hardware: { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null },
      concurrency: 2,
      enabled: true,
      version: "0.0.0",
      currentJobId: null,
    });
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.localNodeId()).toBe(id);
    expect(reopened.listNodes()).toEqual([
      {
        id,
        name: "homeserver",
        role: "standalone",
        lastSeen: 1,
        hardware: { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null },
        concurrency: 2,
        enabled: true,
        version: "0.0.0",
        currentJobId: null,
      },
    ]);
  });

  it("fills missing automatic suggestion defaults from older settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-suggestion-settings-"));
    const path = join(dir, "polisharr.db");
    const store = new Store(path);
    stores.push(store);
    store.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?)")
      .run(JSON.stringify({ suggestionDefaults: { addStereo: false } }));

    expect(store.getSettings().suggestionDefaults).toEqual({
      removeNonPreferredSubtitles: true,
      removeNonPreferredAudio: true,
      addStereo: false,
      transcodeToSizeCap: true,
      transcodeBelowHevc: false,
      convertMp4ToMkv: false,
      convertIsoToMkv: false,
      searchPreferredLanguage: false,
      queueNewImports: false,
    });
  });

  it("falls back to defaults when the persisted Settings JSON is corrupt", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "opt-corrupt-settings-")), "polisharr.db"));
    stores.push(store);
    store.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?)").run("{broken");
    expect(store.getSettings()).toMatchObject({ writeMode: "sidecar", concurrency: 1, videoTarget: "hevc" });
  });

  it("defaults profile auto-assign on for existing installs and persists an opt-out", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-profile-settings-"));
    const path = join(dir, "polisharr.db");
    const store = new Store(path);
    stores.push(store);
    expect(store.getSettings().profileAutoAssign).toBe(true);
    store.saveSettings({ ...store.getSettings(), profileAutoAssign: false });

    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.getSettings().profileAutoAssign).toBe(false);
  });

  it("persists a custom executable plan, write mode, and promote error", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-job-plan-"));
    const path = join(dir, "polisharr.db");
    const store = new Store(path);
    stores.push(store);
    store.insertJob({
      id: "job-custom",
      itemId: "item-1",
      suggestionId: null,
      status: "queued",
      phase: "queued",
      progress: 0,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 1,
      writeMode: "direct",
      promoteError: null,
      plan: {
        origin: "custom",
        video: { kind: "copy" },
        audio: [{ op: "keep", index: 1 }],
        subtitles: [{ op: "remove", index: 2 }],
        container: "mkv",
        writeMode: "direct",
        warning: null,
        reasons: ["Drop Spanish subtitles."],
        estimatedOutputBytes: null,
        category: "movie1080p",
      },
    });
    store.updateJob("job-custom", { promoteError: "Radarr rejected the profile assign." });
    const loaded = store.getJob("job-custom");
    expect(loaded?.suggestionId).toBeNull();
    expect(loaded?.writeMode).toBe("direct");
    expect(loaded?.promoteError).toBe("Radarr rejected the profile assign.");
    expect((loaded?.plan as { origin?: string }).origin).toBe("custom");
  });

  it("lists running and waiting jobs before finished jobs on the first Queue page", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "opt-queue-order-")), "polisharr.db"));
    stores.push(store);
    const plan = {
      origin: "bulk" as const,
      video: { kind: "copy" as const },
      audio: [],
      subtitles: [],
      container: "mkv" as const,
      writeMode: "sidecar" as const,
      warning: null,
      reasons: [],
      estimatedOutputBytes: null,
      category: "movie1080p" as const,
    };
    const row = (id: string, status: "succeeded" | "running" | "queued", position: number) => ({
      id,
      itemId: id,
      suggestionId: null,
      status,
      phase: status === "running" ? "transcoding" as const : status === "queued" ? "queued" as const : "idle" as const,
      progress: status === "running" ? 0.4 : 0,
      error: null,
      warning: null,
      runNow: false,
      position,
      createdAt: position,
      writeMode: "sidecar" as const,
      plan,
    });
    for (let index = 1; index <= 55; index += 1) {
      store.insertJob(row(`job-done-${index}`, "succeeded", index));
    }
    store.insertJob(row("job-run", "running", 56));
    store.insertJob(row("job-wait", "queued", 57));

    const first = store.jobPage(0, 50);
    expect(first.items[0]?.id).toBe("job-run");
    expect(first.items[1]?.id).toBe("job-wait");
    expect(first.items[2]?.id).toBe("job-done-1");
    expect(first.finishedCount).toBe(55);
    expect(first.total).toBe(57);
    expect(store.listJobs()[0]?.id).toBe("job-done-1");
  });

  it("counts running jobs in queueActive so a processing file is not hidden", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "opt-work-")), "polisharr.db"));
    stores.push(store);
    const plan = {
      origin: "bulk" as const,
      video: { kind: "copy" as const },
      audio: [],
      subtitles: [],
      container: "mkv" as const,
      writeMode: "sidecar" as const,
      warning: null,
      reasons: [],
      estimatedOutputBytes: null,
      category: "movie1080p" as const,
    };
    store.insertJob({
      id: "job-wait", itemId: "item-1", suggestionId: null, status: "queued", phase: "queued",
      progress: 0, error: null, warning: null, runNow: false, createdAt: 1, writeMode: "sidecar", plan,
    });
    store.insertJob({
      id: "job-run", itemId: "item-2", suggestionId: null, status: "running", phase: "transcoding",
      progress: 0.4, error: null, warning: null, runNow: false, createdAt: 2, writeMode: "sidecar", plan,
    });
    expect(store.workSummary()).toMatchObject({ queued: 1, queueActive: 2 });
  });

  it("returns interrupted running jobs to the queue after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-recovery-"));
    const store = new Store(join(dir, "polisharr.db"));
    stores.push(store);
    store.insertJob({
      id: "job-running", itemId: "item-1", suggestionId: null, status: "running", phase: "transcoding",
      progress: 0.5, error: null, warning: null, runNow: false, createdAt: 1,
      plan: { id: "suggestion", itemId: "item-1", actions: [], reasons: [], warning: null, category: "movie1080p",
        estimatedSavingsBytes: null, now: { codec: null, quality: null, sizeBytes: null, sizePerHourGb: null },
        after: { codec: null, quality: null, sizeBytes: null, sizePerHourGb: null }, dismissed: false,
        keepAudio: [], stripAudio: [], keepSubs: [], stripSubs: [] },
    });

    expect(store.recoverInterruptedJobs()).toBe(1);
    expect(store.getJob("job-running")).toMatchObject({
      status: "queued", phase: "queued", progress: 0, error: "Recovered after Polisharr restarted.",
    });
  });

  it("lets only one claim win and returns an expired lease to the same node", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-lease-"));
    const store = new Store(join(dir, "polisharr.db"));
    stores.push(store);
    store.upsertNode({
      id: "worker-1",
      name: "5090",
      role: "worker",
      lastSeen: 1_000,
      hardware: { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null },
      concurrency: 1,
      enabled: true,
      version: "1",
      currentJobId: null,
    });
    store.insertJob({
      id: "job-1",
      itemId: "item-1",
      suggestionId: null,
      status: "queued",
      phase: "queued",
      progress: 0,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 1,
      writeMode: "sidecar",
      assignedNodeId: "worker-1",
      plan: { origin: "bulk", video: { kind: "copy" }, audio: [], subtitles: [], container: "mkv", writeMode: "sidecar", warning: null, reasons: [], estimatedOutputBytes: null, category: "movie1080p" },
    });
    const first = store.claimQueuedJobs("worker-1", 1, 1_000, 30_000);
    const second = store.claimQueuedJobs("worker-1", 1, 1_000, 30_000);
    const other = store.claimQueuedJobs("worker-2", 1, 1_000, 30_000);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(other).toHaveLength(0);
    expect(store.getJob("job-1")).toMatchObject({ status: "running", assignedNodeId: "worker-1", nodeId: "worker-1" });
    expect(store.expireLeases(1_000 + 30_000 + 1)).toBe(1);
    expect(store.getJob("job-1")).toMatchObject({
      status: "queued",
      assignedNodeId: "worker-1",
      nodeId: null,
    });
    expect(store.claimQueuedJobs("worker-1", 1, 50_000, 30_000)).toHaveLength(1);
    expect(store.recoverInterruptedJobs(50_000, "homeserver")).toBe(0);
    expect(store.getJob("job-1")?.status).toBe("running");
    store.updateJob("job-1", { status: "cancelled" });
    expect(store.cancelledIdsForNode("worker-1")).toEqual(["job-1"]);
  });

  it("records first seen and file-changed times so auto-queue can ignore old library leftovers", async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "opt-seen-")), "polisharr.db"));
    stores.push(store);
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: null,
      enabled: true,
    });
    const itemId = `${instanceId}:movie:1`;
    const base = {
      id: itemId,
      instanceId,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie" as const,
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/mnt/nas/Film.mkv",
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [] as string[],
      posterRemoteUrl: null,
      sizeExempt: false,
    };
    store.upsertItem(base);
    const created = store.getItem(itemId);
    expect(created?.firstSeenAt).toBeGreaterThan(0);
    expect(created?.fileChangedAt).toBe(created?.firstSeenAt);
    store.upsertItem({ ...base, title: "Film 2" });
    expect(store.getItem(itemId)?.firstSeenAt).toBe(created?.firstSeenAt);
    expect(store.getItem(itemId)?.fileChangedAt).toBe(created?.fileChangedAt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.upsertItem({ ...base, path: "/mnt/nas/Film-upgrade.mkv", sizeBytes: 9 });
    const upgraded = store.getItem(itemId);
    expect(upgraded?.firstSeenAt).toBe(created?.firstSeenAt);
    expect(upgraded?.fileChangedAt).toBeGreaterThan(created?.fileChangedAt ?? 0);
  });

  it("remembers the kept size so an Arr upgrade can still look like a new file", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "opt-kept-size-")), "polisharr.db"));
    stores.push(store);
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: null,
      enabled: true,
    });
    const itemId = `${instanceId}:movie:1`;
    const base = {
      id: itemId,
      instanceId,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie" as const,
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/mnt/nas/Film.mkv",
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [] as string[],
      posterRemoteUrl: null,
      sizeExempt: false,
    };
    store.upsertItem(base);
    expect(store.getItem(itemId)?.keptSizeBytes).toBe(0);
    store.updateItemFile(itemId, "/mnt/nas/Film.mkv", 4);
    store.markKeptSize(itemId, 4);
    expect(store.getItem(itemId)).toMatchObject({ sizeBytes: 4, keptSizeBytes: 4 });
    store.upsertItem({ ...base, path: "/mnt/nas/Film-upgrade.mkv", sizeBytes: 9 });
    expect(store.getItem(itemId)).toMatchObject({ sizeBytes: 9, keptSizeBytes: 4 });
  });

  it("does not mark a title unreadable from a file error on an old path", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-stale-error-"));
    const store = new Store(join(dir, "polisharr.db"));
    stores.push(store);
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: null,
      enabled: true,
    });
    const itemId = `${instanceId}:movie:438`;
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
      path: "/mnt/nas/Cars 3 [FGT].iso",
      sizeBytes: 40_000_000_000,
      quality: "BR-DISK",
      resolution: "2160",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    store.setFileError("/mnt/nas/Cars 3 [CODEFLiX].iso", itemId, "ffprobe failed.");
    expect(store.librarySnapshot(itemId)?.error).toBeNull();
    expect(store.listErrors().some((row) => row.path.includes("CODEFLiX"))).toBe(false);
    expect(store.workSummary().errors).toBe(0);
    store.setFileError("/mnt/nas/Cars 3 [FGT].iso", itemId, "This path is not readable inside the container.");
    expect(store.librarySnapshot(itemId)?.error).toMatch(/not readable/);
    expect(store.workSummary().errors).toBe(1);
    store.clearFileErrorsForItem(itemId);
    expect(store.librarySnapshot(itemId)?.error).toBeNull();
  });

  it("drops a folder ffprobe error after the title path becomes the media file", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-folder-error-"));
    const store = new Store(join(dir, "polisharr.db"));
    stores.push(store);
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: null,
      enabled: true,
    });
    const itemId = `${instanceId}:movie:241`;
    const folder = "/mnt/nas/Movies/John Wick Chapter 3 - Parabellum (2019)";
    const file = `${folder}/John Wick Chapter 3.mkv`;
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
    store.setFileError(folder, itemId, "Command failed: ffprobe -v quiet -print_format json -show_format -show_streams " + folder);
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
      path: file,
      sizeBytes: 74_279_424_501,
      quality: "Bluray-2160p",
      resolution: "2160",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    expect(store.listErrors()).toEqual([]);
    expect(store.errorPage(0, 20).items).toEqual([]);
    expect(store.workSummary().errors).toBe(0);
  });

  it("counts healthy movies and open suggestions for the Movies header", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-movie-health-"));
    const store = new Store(join(dir, "polisharr.db"));
    stores.push(store);
    const instanceId = store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: null,
      enabled: true,
    });
    const movie = (id: string, arrId: number, path: string) =>
      store.upsertItem({
        id,
        instanceId,
        arrId,
        arrSeriesId: null,
        arrEpisodeFileId: null,
        type: "movie",
        title: id,
        showTitle: null,
        season: null,
        episode: null,
        episodeTitle: null,
        path,
        sizeBytes: 1,
        quality: "HD",
        resolution: "1080",
        profile: "HD",
        tags: [],
        posterRemoteUrl: null,
        sizeExempt: false,
      });
    movie("healthy", 1, "/movies/healthy.mkv");
    movie("suggested", 2, "/movies/suggested.mkv");
    movie("unread", 3, "/movies/unread.mkv");
    movie("unreadable", 4, "/movies/unreadable.mkv");
    const inspection = {
      sourceSig: "p|1",
      sourceMethod: "ffprobe" as const,
      listingState: "complete" as const,
      durationSec: 3600,
      isoPlaylist: null,
      sizeBytes: 1,
      sizePerHourGb: 1,
      videoCodec: "hevc",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none" as const,
      audio: [],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    };
    store.saveInspection("healthy", { ...inspection, sourceSig: "/movies/healthy.mkv|1" });
    store.saveInspection("suggested", { ...inspection, sourceSig: "/movies/suggested.mkv|1" });
    store.saveInspection("unreadable", { ...inspection, sourceSig: "/movies/unreadable.mkv|1" });
    store.saveSuggestion("suggested", {
      id: "sug-1",
      itemId: "suggested",
      actions: ["transcode"],
      reasons: ["Over the size cap."],
      warning: null,
      category: "movie1080p",
      estimatedSavingsBytes: 1,
      now: { codec: "h264", quality: "HD", sizeBytes: 1, sizePerHourGb: 1 },
      after: { codec: "hevc", quality: "HD", sizeBytes: 1, sizePerHourGb: 1 },
      dismissed: false,
      keepAudio: [],
      stripAudio: [],
      keepSubs: [],
      stripSubs: [],
    });
    store.setFileError("/movies/unreadable.mkv", "unreadable", "Path is unreadable.");
    expect(store.movieHealth()).toEqual({ total: 4, healthyCount: 1, suggestionCount: 1 });
  });

  it("stores a movie encode target and a series encode target that new lookups inherit", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "opt-codec-target-")), "polisharr.db"));
    stores.push(store);
    const radarr = store.upsertInstance({ kind: "radarr", name: "Radarr", url: "http://radarr", secret: null, enabled: true });
    const sonarr = store.upsertInstance({ kind: "sonarr", name: "Sonarr", url: "http://sonarr", secret: null, enabled: true });
    const movieId = `${radarr}:movie:1`;
    store.upsertItem({
      id: movieId,
      instanceId: radarr,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/movies/film.mkv",
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    expect(store.videoTargetForItem(store.getItem(movieId)!)).toBeNull();
    store.setItemVideoTarget(movieId, "av1");
    expect(store.getItem(movieId)?.videoTarget).toBe("av1");
    store.upsertItem({
      id: movieId,
      instanceId: radarr,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/movies/film.mkv",
      sizeBytes: 9,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    expect(store.getItem(movieId)?.videoTarget).toBe("av1");
    store.setItemVideoTarget(movieId, null);
    expect(store.getItem(movieId)?.videoTarget).toBeNull();

    const episodeId = `${sonarr}:episode:10`;
    store.upsertItem({
      id: episodeId,
      instanceId: sonarr,
      arrId: 10,
      arrSeriesId: 42,
      arrEpisodeFileId: 10,
      type: "episode",
      title: "Pilot",
      showTitle: "Show",
      season: 1,
      episode: 1,
      episodeTitle: "Pilot",
      path: "/tv/show.mkv",
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    expect(store.videoTargetForItem(store.getItem(episodeId)!)).toBeNull();
    store.setSeriesVideoTarget(sonarr, 42, "hevc");
    expect(store.getSeriesVideoTarget(sonarr, 42)).toBe("hevc");
    expect(store.videoTargetForItem(store.getItem(episodeId)!)).toBe("hevc");
    expect(store.seriesPage(0, 10).rows[0]?.videoTarget).toBe("hevc");
    store.setSeriesAudioMix(sonarr, 42, "stereo");
    store.setSeriesVideoTarget(sonarr, 42, null);
    expect(store.videoTargetForItem(store.getItem(episodeId)!)).toBeNull();
    expect(store.audioMixForItem(store.getItem(episodeId)!)).toBe("stereo");
    expect(store.seriesPage(0, 10).rows[0]?.audioMix).toBe("stereo");
    store.setSeriesAudioMix(sonarr, 42, null);
    expect(store.audioMixForItem(store.getItem(episodeId)!)).toBeNull();
  });
});
