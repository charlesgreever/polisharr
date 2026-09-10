import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { isoListedFfmpeg } from "./fixtures/index.ts";
import type { HardwareInfo } from "./types.ts";

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "opt-"));
  const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
  let probeCalls = 0;
  const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null };
  const created = createApp({
    env,
    hardware: async () => hw,
    readable: async () => true,
    probe: async () => {
      probeCalls += 1;
      return {
        format: { duration: "3600" },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac", channels: 6, tags: { language: "eng" }, index: 1 },
          { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "spa" }, index: 2 },
        ],
      };
    },
    fetch: (async (url: string) => {
      if (String(url).includes("/movie")) {
        return new Response(
          JSON.stringify([
            {
              id: 10,
              title: "American Underdog",
              path: "/mnt/nas/movies/underdog.mkv",
              sizeOnDisk: 8_000_000_000,
              movieFile: { path: "/mnt/nas/movies/underdog.mkv", size: 8_000_000_000, quality: { quality: { name: "Bluray-1080p" } } },
              images: [{ coverType: "poster", url: "http://radarr/poster.jpg" }],
            },
          ]),
        );
      }
      if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    optimizer: async (req) => ({
      sidecarPath: join(dir, "sidecar.mkv"),
      output: {
        ...req.report,
        videoCodec: "hevc",
        sizeBytes: 3_000_000_000,
        sizePerHourGb: 3,
      },
    }),
  });
  return { app: created, store: created.store, dir, probeCalls: () => probeCalls };
}

describe("public HTTP behavior", () => {
  const apps: Array<{ store: { close: () => void }; app: { jobs: { stop: () => void }; workerLoop?: { stop: () => void } } }> = [];
  afterEach(() => {
    for (const a of apps) {
      a.app.jobs.stop();
      a.app.workerLoop?.stop();
      a.store.close();
    }
    apps.length = 0;
  });

  it("boots health without secrets", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const res = await ctx.app.app.request("/api/health");
    const body = await res.json() as { ok: boolean; service: string; version: string };
    expect(body).toEqual({ ok: true, service: "polisharr", version: body.version });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(body.version).toBe(pkg.version);
  });

  it("bounds library pages and loads episodes for one series", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    ctx.store.upsertInstance({ id: "radarr-a", kind: "radarr", name: "Radarr A", url: "http://radarr", enabled: true });
    ctx.store.upsertInstance({ id: "sonarr-a", kind: "sonarr", name: "Sonarr A", url: "http://sonarr", enabled: true });
    for (let id = 1; id <= 3; id += 1) {
      ctx.store.upsertItem({
        id: `movie-${id}`,
        instanceId: "radarr-a",
        arrId: id,
        arrSeriesId: null,
        arrEpisodeFileId: null,
        type: "movie",
        title: `Movie ${id}`,
        showTitle: null,
        season: null,
        episode: null,
        episodeTitle: null,
        path: `/movies/${id}.mkv`,
        sizeBytes: id * 1_000,
        quality: "Bluray-1080p",
        resolution: "1080",
        profile: "HD",
        tags: [],
        posterRemoteUrl: null,
        sizeExempt: false,
      });
    }
    ctx.store.saveInspection("movie-1", {
      sourceSig: "/movies/1.mkv|1000",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 3600,
      sizeBytes: 1_000,
      sizePerHourGb: 1,
      videoCodec: "hevc",
      width: 1920,
      height: 1080,
      bitDepth: 10,
      hdr: "none",
      audio: [{ index: 1, language: "eng", channels: 8, codec: "truehd", title: "", untagged: false, commentary: false }],
      subtitles: [{ index: 2, language: "eng", codec: "pgs", title: "English SDH Forced", untagged: false, forced: true, sdh: true }],
      hasChapters: false,
      hasAttachments: false,
    });
    ctx.store.saveSuggestion("movie-1", {
      id: "suggestion-1",
      itemId: "movie-1",
      actions: ["transcode", "tracks"],
      reasons: ["Video is over the size cap.", "Spanish tracks will be removed."],
      warning: null,
      category: "movie1080p",
      estimatedSavingsBytes: 500,
      now: { codec: "hevc", quality: "Bluray-1080p", sizeBytes: 1_000, sizePerHourGb: 1 },
      after: { codec: "hevc", quality: "Bluray-1080p", sizeBytes: 500, sizePerHourGb: 0.5 },
      dismissed: false,
      keepAudio: [1],
      stripAudio: [],
      keepSubs: [2],
      stripSubs: [],
    });
    ctx.store.setFileError("/movies/2.mkv", "movie-2", "Path is unreadable.");
    ctx.store.setFileError("/movies/2-alt.mkv", "movie-2", "A second read error for the same title.");
    for (const seriesId of [101, 202]) {
      for (let episode = 1; episode <= 2; episode += 1) {
        ctx.store.upsertItem({
          id: `episode-${seriesId}-${episode}`,
          instanceId: "sonarr-a",
          arrId: seriesId * 10 + episode,
          arrSeriesId: seriesId,
          arrEpisodeFileId: seriesId * 100 + episode,
          type: "episode",
          title: `Show ${seriesId}`,
          showTitle: `Show ${seriesId}`,
          season: 1,
          episode,
          episodeTitle: `Episode ${episode}`,
          path: `/shows/${seriesId}/${episode}.mkv`,
          sizeBytes: episode * 1_000,
          quality: "WEBDL-1080p",
          resolution: "1080",
          profile: "TV",
          tags: [],
          posterRemoteUrl: null,
          sizeExempt: false,
        });
      }
    }
    ctx.store.saveInspection("episode-101-1", {
      sourceSig: "/shows/101/1.mkv|1000",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 1800,
      sizeBytes: 1_000,
      sizePerHourGb: 2,
      videoCodec: "hevc",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    });
    ctx.store.saveInspection("episode-101-2", {
      sourceSig: "/shows/101/2.mkv|2000",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 1800,
      sizeBytes: 2_000,
      sizePerHourGb: 1,
      videoCodec: "hevc",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    });
    ctx.store.saveSuggestion("episode-101-1", {
      id: "suggestion-ep-1",
      itemId: "episode-101-1",
      actions: ["transcode"],
      reasons: ["Over the size cap."],
      warning: null,
      category: "tv1080p",
      estimatedSavingsBytes: 500,
      now: { codec: "hevc", quality: "WEBDL-1080p", sizeBytes: 1_000, sizePerHourGb: 2 },
      after: { codec: "hevc", quality: "WEBDL-1080p", sizeBytes: 500, sizePerHourGb: 1 },
      dismissed: false,
      keepAudio: [],
      stripAudio: [],
      keepSubs: [],
      stripSubs: [],
    });

    const movies = (await (await ctx.app.app.request("/api/library/movies?limit=2", { headers })).json()) as {
      items: Array<Record<string, unknown>>;
      nextOffset: number | null;
      total: number;
    };
    expect(movies).toMatchObject({ nextOffset: 2, total: 3, healthyCount: 0, suggestionCount: 1 });
    expect(movies.items).toHaveLength(2);
    expect(movies.items[0]).toMatchObject({
      mediaState: "inspected",
      videoLabel: "hevc · 1920x1080",
      audioLabels: ["eng truehd 7.1"],
      subtitleLabels: ["eng pgs Forced SDH"],
      reasons: ["Video is over the size cap.", "Spanish tracks will be removed."],
    });
    expect(movies.items[1]).toMatchObject({ mediaState: "unreadable", error: "Path is unreadable." });
    const movieContinuation = (await (
      await ctx.app.app.request("/api/library/movies?offset=2&limit=2", { headers })
    ).json()) as { items: Array<{ id: string }> };
    expect(movieContinuation.items.map((item) => item.id)).toEqual(["movie-3"]);

    const largestMovies = (await (
      await ctx.app.app.request("/api/library/movies?limit=2&sort=size", { headers })
    ).json()) as { items: Array<{ id: string }> };
    expect(largestMovies.items.map((item) => item.id)).toEqual(["movie-3", "movie-2"]);

    for (let id = 4; id <= 103; id += 1) {
      ctx.store.upsertItem({
        id: `movie-${id}`,
        instanceId: "radarr-a",
        arrId: id,
        arrSeriesId: null,
        arrEpisodeFileId: null,
        type: "movie",
        title: `Movie ${String(id).padStart(3, "0")}`,
        showTitle: null,
        season: null,
        episode: null,
        episodeTitle: null,
        path: `/movies/${id}.mkv`,
        sizeBytes: id * 1_000,
        quality: "Bluray-1080p",
        resolution: "1080",
        profile: "HD",
        tags: [],
        posterRemoteUrl: null,
        sizeExempt: false,
      });
    }
    const cappedMovies = (await (
      await ctx.app.app.request("/api/library/movies?limit=1000", { headers })
    ).json()) as { items: Array<{ id: string }>; nextOffset: number | null; total: number };
    expect(cappedMovies).toMatchObject({ nextOffset: 100, total: 103 });
    expect(cappedMovies.items).toHaveLength(100);

    const series = (await (await ctx.app.app.request("/api/library/series?limit=1", { headers })).json()) as {
      items: Array<{ instanceId: string; arrSeriesId: number; episodeCount: number; path?: string }>;
      nextOffset: number | null;
      total: number;
    };
    expect(series).toMatchObject({ nextOffset: 1, total: 2 });
    expect(series.items).toHaveLength(1);
    expect(series.items[0]).toMatchObject({
      instanceId: "sonarr-a",
      arrSeriesId: 101,
      episodeCount: 2,
      healthyCount: 1,
      suggestionCount: 1,
    });
    expect(series.items[0]).not.toHaveProperty("path");

    const episodes = (await (
      await ctx.app.app.request("/api/library/series/sonarr-a/101/episodes?limit=1", { headers })
    ).json()) as { items: Array<{ id: string }>; nextOffset: number | null; total: number };
    expect(episodes).toMatchObject({ nextOffset: 1, total: 2 });
    expect(episodes.items).toEqual([expect.objectContaining({ id: "episode-101-1" })]);

    const movieSuggestions = (await (
      await ctx.app.app.request("/api/suggestions?type=movie", { headers })
    ).json()) as { items: Array<{ now: { tracks: string[] }; after: { tracks: string[] } }>; total: number };
    expect(movieSuggestions.total).toBe(1);
    expect(movieSuggestions.items[0]).toMatchObject({ href: "/movies/movie-1" });
    expect(movieSuggestions.items[0]?.now.tracks).toEqual([
      "Audio: eng truehd 7.1",
      "Subtitle: eng pgs Forced SDH",
    ]);
    expect(movieSuggestions.items[0]?.after.tracks).toEqual([
      "Audio: eng truehd 7.1",
      "Subtitle: eng pgs Forced SDH",
    ]);
    const episodeSuggestions = (await (
      await ctx.app.app.request("/api/suggestions?type=episode", { headers })
    ).json()) as { items: Array<{ href?: string }>; total: number };
    expect(episodeSuggestions).toMatchObject({ total: 1, items: [{ href: "/series/episodes/episode-101-1" }] });

    ctx.store.setFileError("/shows/101/1.mkv", "episode-101-1", "Episode is unreadable.");
    ctx.store.setFileError("/orphan.mkv", null, "No library row.");
    const errors = (await (await ctx.app.app.request("/api/errors?limit=10", { headers })).json()) as {
      items: Array<{ path: string; href?: string; itemId: string | null }>;
    };
    expect(errors.items.find((row) => row.path === "/movies/2.mkv")).toMatchObject({
      itemId: "movie-2",
      href: "/movies/movie-2",
    });
    expect(errors.items.find((row) => row.path === "/shows/101/1.mkv")).toMatchObject({
      itemId: "episode-101-1",
      href: "/series/episodes/episode-101-1",
    });
    const orphan = errors.items.find((row) => row.path === "/orphan.mkv");
    expect(orphan).toMatchObject({ itemId: null });
    expect(orphan).not.toHaveProperty("href");
  });

  it("bounds every work-list response and exposes continuation metadata", async () => {
    const ctx = await setup();
    apps.push(ctx);
    ctx.app.jobs.stop();
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    ctx.store.upsertInstance({ id: "radarr-lists", kind: "radarr", name: "Radarr", url: "http://radarr", enabled: true });

    for (let index = 1; index <= 3; index += 1) {
      const itemId = `list-item-${index}`;
      ctx.store.upsertItem({
        id: itemId,
        instanceId: "radarr-lists",
        arrId: index,
        arrSeriesId: null,
        arrEpisodeFileId: null,
        type: "movie",
        title: `List Film ${index}`,
        showTitle: null,
        season: null,
        episode: null,
        episodeTitle: null,
        path: `/movies/list-${index}.mkv`,
        sizeBytes: index * 1_000,
        quality: "HD",
        resolution: "1080",
        profile: "HD",
        tags: [],
        posterRemoteUrl: null,
        sizeExempt: false,
      });
      ctx.store.saveSuggestion(itemId, {
        id: `list-suggestion-${index}`,
        itemId,
        actions: ["transcode"],
        reasons: ["Over the size cap."],
        warning: index === 1 ? "Hardware encode is unavailable. This transcode will fail until CUDA is available." : null,
        category: "movie1080p",
        estimatedSavingsBytes: 500,
        now: { codec: "h264", quality: "HD", sizeBytes: 1_000, sizePerHourGb: 1 },
        after: { codec: "hevc", quality: "HD", sizeBytes: 500, sizePerHourGb: 0.5 },
        dismissed: false,
        keepAudio: [],
        stripAudio: [],
        keepSubs: [],
        stripSubs: [],
      });
      ctx.store.insertJob({
        id: `list-job-${index}`,
        itemId,
        suggestionId: `list-suggestion-${index}`,
        status: "queued",
        phase: "queued",
        progress: 0,
        error: null,
        warning: null,
        runNow: false,
        position: index,
        plan: {},
        createdAt: index,
      });
      ctx.store.insertReview({
        id: `list-review-${index}`,
        jobId: `list-job-${index}`,
        itemId,
        displayTitle: "",
        status: "pending",
        flagged: false,
        flagReason: null,
        sourcePath: `/movies/list-${index}.mkv`,
        sidecarPath: `/review/list-${index}.mkv`,
        source: { codec: "h264", quality: "HD", sizeBytes: 1_000, sizePerHourGb: 1, durationSec: 1, tracks: "" },
        sidecar: { codec: "hevc", quality: "HD", sizeBytes: 500, sizePerHourGb: 0.5, durationSec: 1, tracks: "" },
        error: null,
      });
      ctx.store.setFileError(`/movies/list-${index}.mkv`, itemId, "Unreadable.");
      ctx.store.addHistory(itemId, "kept", 500, index);
    }

    for (const path of ["suggestions", "jobs", "review", "errors", "history"]) {
      const first = (await (await ctx.app.app.request(`/api/${path}?limit=2`, { headers })).json()) as {
        items: Array<{ id?: string; path?: string }>;
        nextOffset: number | null;
        total: number;
      };
      expect(first.items, path).toHaveLength(2);
      expect(first, path).toMatchObject({ nextOffset: 2, total: 3 });
      if (path === "review") expect(first).toMatchObject({ pendingCount: 3 });
      if (path === "jobs") expect(first).toMatchObject({ finishedCount: 0 });

      const second = (await (await ctx.app.app.request(`/api/${path}?offset=2&limit=2`, { headers })).json()) as {
        items: Array<{ id?: string; path?: string }>;
        nextOffset: number | null;
        total: number;
      };
      expect(second.items, path).toHaveLength(1);
      expect(second, path).toMatchObject({ nextOffset: null, total: 3 });
    }

    const queued = (await (await ctx.app.app.request("/api/jobs?limit=2", { headers })).json()) as {
      items: Array<{ id?: string; href?: string }>;
    };
    expect(queued.items[0]).toMatchObject({ href: "/movies/list-item-1" });
    ctx.store.insertJob({
      id: "orphan-job",
      itemId: "missing-item",
      suggestionId: null,
      status: "failed",
      phase: "idle",
      progress: 0,
      error: "gone",
      warning: null,
      runNow: false,
      position: 99,
      plan: {},
      createdAt: 99,
    });
    const withOrphan = (await (await ctx.app.app.request("/api/jobs?offset=3&limit=2", { headers })).json()) as {
      items: Array<{ id?: string; href?: string }>;
    };
    const orphanJob = withOrphan.items.find((row) => row.id === "orphan-job");
    expect(orphanJob).toBeTruthy();
    expect(orphanJob).not.toHaveProperty("href");

    const matching = (await (
      await ctx.app.app.request("/api/suggestions?q=Film%203&limit=2", { headers })
    ).json()) as { items: Array<{ displayTitle: string }>; nextOffset: number | null; total: number };
    expect(matching).toMatchObject({ nextOffset: null, total: 1 });
    expect(matching.items.map((item) => item.displayTitle)).toEqual(["List Film 3"]);
    const warnings = (await (
      await ctx.app.app.request("/api/suggestions?hardwareWarning=true", { headers })
    ).json()) as { items: Array<{ id: string }>; total: number };
    expect(warnings).toMatchObject({ total: 1, items: [{ id: "list-suggestion-1" }] });

    ctx.store.saveSettings({
      ...ctx.store.getSettings(), languageConfirmed: true, reviewPath: join(ctx.dir, "review"),
    });
    const filtered = await ctx.app.app.request("/api/suggestions/queue-filtered", {
      method: "POST",
      headers,
      body: JSON.stringify({ filters: { type: "movie" }, q: "List Film" }),
    });
    expect(await filtered.json()).toEqual({ queued: 0, skipped: 3 });
  });

  it("signs in from a browser form post and redirects home", async () => {
    const ctx = await setup();
    apps.push(ctx);
    await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const res = await ctx.app.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=ada&password=secret12",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/polisharr=/);
  });

  it("sends a failed browser login back to /login without a session cookie", async () => {
    const ctx = await setup();
    apps.push(ctx);
    await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const res = await ctx.app.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=ada&password=nope",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?error=1");
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/polisharr=/);
  });

  it("rejects a wrong login with one generic error", async () => {
    const ctx = await setup();
    apps.push(ctx);
    await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const res = await ctx.app.app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "ada", password: "nope" }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Username or password is wrong." });
  });

  it("gates optimize until language is confirmed and never echoes API keys", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const denied = await ctx.app.app.request("/api/queue", { method: "POST", headers, body: JSON.stringify({ itemId: "x" }) });
    expect(denied.status).toBe(403);

    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "super-secret-key", enabled: true }),
    });
    const listed = await ctx.app.app.request("/api/settings", { headers });
    const body = (await listed.json()) as { instances: Array<{ hasApiKey: boolean; apiKey?: string }>; writeMode?: string };
    expect(body.instances[0]?.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("super-secret-key");
    expect(body.writeMode ?? "sidecar").toBe("sidecar");

    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
    });
    const refresh = await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
    expect(refresh.status).toBe(200);
    const movies = await ctx.app.app.request("/api/library/movies", { headers });
    const list = (await movies.json()) as { items: Array<{ title: string; path: string; inspected: boolean }> };
    expect(list.items[0]?.title).toBe("American Underdog");
    expect(list.items[0]?.path).toBe("/mnt/nas/movies/underdog.mkv");
  });

  it("persists the global direct-write policy on a bulk queue job", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review"), writeMode: "direct" }),
    });
    await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
    await ctx.app.inspectPending();
    const suggestions = await ctx.app.app.request("/api/suggestions", { headers });
    const sug = (await suggestions.json()) as { items: Array<{ id: string }> };
    expect(sug.items.length).toBeGreaterThan(0);
    const queued = await ctx.app.app.request("/api/queue", { method: "POST", headers, body: JSON.stringify({ suggestionId: sug.items[0].id }) });
    expect(queued.status).toBe(200);
    const queuedBody = (await queued.json()) as { id: string };
    expect(ctx.store.getJob(queuedBody.id)).toMatchObject({
      writeMode: "direct",
      plan: { origin: "bulk", writeMode: "direct", writeModeLocked: false },
    });
    await vi.waitFor(() => expect(["failed", "succeeded"]).toContain(ctx.store.getJob(queuedBody.id)?.status));
  });

  it("returns running Queue jobs before finished jobs and reports finishedCount", async () => {
    const ctx = await setup();
    apps.push(ctx);
    ctx.app.jobs.stop();
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
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
    for (let index = 1; index <= 55; index += 1) {
      ctx.store.insertJob({
        id: `job-done-${index}`,
        itemId: `item-${index}`,
        suggestionId: null,
        status: "succeeded",
        phase: "idle",
        progress: 1,
        error: null,
        warning: null,
        runNow: false,
        position: index,
        createdAt: index,
        plan,
      });
    }
    ctx.store.insertJob({
      id: "job-run",
      itemId: "item-run",
      suggestionId: null,
      status: "running",
      phase: "transcoding",
      progress: 0.4,
      error: null,
      warning: null,
      runNow: false,
      position: 56,
      createdAt: 56,
      plan,
    });
    ctx.store.insertJob({
      id: "job-wait",
      itemId: "item-wait",
      suggestionId: null,
      status: "queued",
      phase: "queued",
      progress: 0,
      error: null,
      warning: null,
      runNow: false,
      position: 57,
      createdAt: 57,
      plan,
    });
    const page = (await (await ctx.app.app.request("/api/jobs?limit=50", { headers })).json()) as {
      items: Array<{ id: string }>;
      finishedCount: number;
      total: number;
    };
    expect(page.items[0]?.id).toBe("job-run");
    expect(page.items[1]?.id).toBe("job-wait");
    expect(page.finishedCount).toBe(55);
    expect(page.total).toBe(57);
  });

  it("cancels all active jobs and removes Queue rows without deleting History, Review, or media", async () => {
    const ctx = await setup();
    apps.push(ctx);
    ctx.app.jobs.stop();
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    ctx.store.upsertInstance({ id: "radarr-queue", kind: "radarr", name: "Radarr", url: "http://radarr", enabled: true });
    const mediaPath = join(ctx.dir, "queue-movie.mkv");
    writeFileSync(mediaPath, "ORIGINAL");
    ctx.store.upsertItem({
      id: "queue-item",
      instanceId: "radarr-queue",
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Queue Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: mediaPath,
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    const statuses = ["queued", "held", "paused", "running", "succeeded", "failed", "cancelled"] as const;
    for (const [position, status] of statuses.entries()) {
      ctx.store.insertJob({
        id: `job-${status}`,
        itemId: "queue-item",
        suggestionId: null,
        status,
        phase: status === "queued" || status === "held" || status === "paused" ? status : "idle",
        progress: 0,
        error: null,
        warning: null,
        runNow: false,
        position,
        plan: {},
        createdAt: position,
      });
    }
    ctx.store.addHistory("queue-item", "failed", 0, 1);
    ctx.store.insertReview({
      id: "review-1",
      jobId: "job-succeeded",
      itemId: "queue-item",
      displayTitle: "Queue Film",
      status: "pending",
      flagged: false,
      flagReason: null,
      sourcePath: mediaPath,
      sidecarPath: join(ctx.dir, "sidecar.mkv"),
      source: { codec: "h264", quality: "HD", sizeBytes: 8, sizePerHourGb: 1, durationSec: 1, tracks: "0 audio / 0 subtitles" },
      sidecar: { codec: "hevc", quality: "HD", sizeBytes: 4, sizePerHourGb: 0.5, durationSec: 1, tracks: "0 audio / 0 subtitles" },
      error: null,
    });

    expect((await ctx.app.app.request("/api/jobs/cancel-all", { method: "POST" })).status).toBe(401);
    expect((await ctx.app.app.request("/api/jobs/job-failed", { method: "DELETE" })).status).toBe(401);

    const cancelled = await ctx.app.app.request("/api/jobs/cancel-all", { method: "POST", headers });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true, cancelled: 4 });
    expect(ctx.store.listJobs().filter((job) => job.status === "cancelled")).toHaveLength(5);
    expect(readFileSync(mediaPath, "utf8")).toBe("ORIGINAL");

    ctx.store.insertJob({
      id: "job-active",
      itemId: "queue-item",
      suggestionId: null,
      status: "paused",
      phase: "paused",
      progress: 0,
      error: null,
      warning: null,
      runNow: false,
      position: 99,
      plan: {},
      createdAt: 99,
    });
    expect((await ctx.app.app.request("/api/jobs/job-active", { method: "DELETE", headers })).status).toBe(409);
    expect((await ctx.app.app.request("/api/jobs/job-failed", { method: "DELETE", headers })).status).toBe(200);
    const cleared = await ctx.app.app.request("/api/jobs/finished", { method: "DELETE", headers });
    expect(await cleared.json()).toEqual({ ok: true, removed: 6 });
    expect(ctx.store.listJobs().map((job) => job.id)).toEqual(["job-active"]);
    expect(ctx.store.getJob("job-succeeded")?.status).toBe("succeeded");
    expect(ctx.store.listHistory()).toHaveLength(5);
    expect(ctx.store.listReviews()).toHaveLength(1);
    expect(readFileSync(mediaPath, "utf8")).toBe("ORIGINAL");
  });

  it("finishes an ISO Keep with the promoted MKV inspected and integrations refreshed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-keep-"));
    const reviewDir = mkdtempSync(join(tmpdir(), "opt-review-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const isoPath = join(dir, "movie.iso");
    const sidecarPath = join(reviewDir, "movie-sidecar.mkv");
    writeFileSync(isoPath, "ORIGINAL-ISO");
    const calls: string[] = [];
    const probed: string[] = [];
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      listIso: async () => isoListedFfmpeg,
      probe: async (path) => {
        probed.push(path);
        return {
          format: { duration: "3600" },
          streams: [
            { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
            { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" }, index: 1 },
          ],
        };
      },
      optimizer: async (req) => {
        writeFileSync(sidecarPath, "PROMOTED-MKV");
        return {
          sidecarPath,
          output: { ...req.report, videoCodec: "hevc", sizeBytes: 12, sizePerHourGb: 0.01 },
        };
      },
      fetch: (async (url, init) => {
        const text = String(url);
        calls.push(`${init?.method ?? "GET"} ${text}`);
        if (text.endsWith("/api/v3/movie")) {
          return new Response(JSON.stringify([
            {
              id: 10,
              title: "Disc Film",
              path: isoPath,
              sizeOnDisk: 12,
              movieFile: { path: isoPath, size: 12, quality: { quality: { name: "Bluray-1080p" } } },
            },
          ]));
        }
        if (text.endsWith("/api/v3/qualityprofile")) {
          return new Response(JSON.stringify([
            {
              id: 1,
              name: "No Upgrades",
              upgradeAllowed: false,
              items: [{ allowed: true, quality: { name: "Bluray-1080p" } }],
            },
          ]));
        }
        if (text.endsWith("/api/v3/movie/10")) {
          return new Response(JSON.stringify({ id: 10, title: "Disc Film", monitored: true, movieFile: { quality: { quality: { name: "Bluray-1080p" } } } }));
        }
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin", token: "t", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: reviewDir }),
    });
    await created.app.request("/api/library/refresh", { method: "POST", headers });
    await created.inspectPending();
    const suggestions = (await (await created.app.request("/api/suggestions", { headers })).json()) as { items: Array<{ id: string; itemId: string }> };
    await created.app.request("/api/queue", {
      method: "POST",
      headers,
      body: JSON.stringify({ suggestionId: suggestions.items[0]?.id }),
    });
    await vi.waitFor(async () => {
      const review = (await (await created.app.request("/api/review", { headers })).json()) as { items: Array<{ id: string }> };
      expect(review.items).toHaveLength(1);
    });
    const review = (await (await created.app.request("/api/review", { headers })).json()) as { items: Array<{ id: string }> };
    const keep = await created.app.request(`/api/review/${review.items[0]?.id}/keep`, { method: "POST", headers });
    expect(keep.status).toBe(202);
    await vi.waitFor(async () => {
      const pending = (await (await created.app.request("/api/review", { headers })).json()) as { items: unknown[] };
      expect(pending.items).toHaveLength(0);
    });

    const title = (await (await created.app.request(`/api/library/items/${suggestions.items[0]?.itemId}`, { headers })).json()) as {
      item: { path: string; inspected: boolean; report?: { sourceMethod?: string; sourceSig?: string } };
    };
    expect(title.item.path).toBe(join(dir, "movie.mkv"));
    expect(title.item.inspected).toBe(true);
    expect(title.item.report?.sourceMethod).toBe("ffprobe");
    expect(title.item.report?.sourceSig).toBe(`${join(dir, "movie.mkv")}|12`);
    expect(probed).toEqual([join(dir, "movie.mkv")]);
    expect(calls.some((call) => call.includes("POST http://radarr/api/v3/command"))).toBe(true);
    expect(calls.some((call) => call.includes("POST http://jellyfin/Library/Refresh"))).toBe(true);
    expect(calls.some((call) => call.includes("qualityprofile"))).toBe(false);
  });

  it("does not auto-queue a Keep of an over-cap sidecar, and does auto-queue a later Arr upgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-keep-loop-"));
    const reviewDir = mkdtempSync(join(tmpdir(), "opt-keep-loop-review-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const sourcePath = join(dir, "avatar.mkv");
    const sidecarPath = join(reviewDir, "avatar-sidecar.mkv");
    const originalSize = 8_000_000_000;
    const keptSize = 4_000_000_000;
    const upgradeSize = 10_000_000_000;
    writeFileSync(sourcePath, "ORIGINAL");
    const movie = {
      id: 10,
      title: "Avatar",
      path: sourcePath,
      sizeOnDisk: originalSize,
      movieFile: { path: sourcePath, size: originalSize, quality: { quality: { name: "Bluray-1080p" } } },
    };
    const arrRefreshes: Array<{ sizeBytes: number; keptSizeBytes: number }> = [];
    let storeRef: { listItems: (type?: "movie") => Array<{ sizeBytes: number; keptSizeBytes?: number }> } | undefined;
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      probe: async () => ({
        format: { duration: "3600" },
        streams: [
          { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" }, index: 1 },
        ],
      }),
      optimizer: async (req) => {
        writeFileSync(sidecarPath, "PROMOTED");
        return {
          sidecarPath,
          output: { ...req.report, videoCodec: "hevc", sizeBytes: keptSize, sizePerHourGb: keptSize / 1024 ** 3 },
        };
      },
      fetch: (async (url, init) => {
        const text = String(url);
        if (text.includes("/api/v3/command") && (init?.method ?? "GET") === "POST") {
          const item = storeRef?.listItems("movie")[0];
          arrRefreshes.push({ sizeBytes: item?.sizeBytes ?? 0, keptSizeBytes: item?.keptSizeBytes ?? 0 });
          return new Response("{}", { status: 201 });
        }
        if (text.endsWith("/api/v3/movie")) return new Response(JSON.stringify([movie]));
        if (text.endsWith("/api/v3/movie/10")) return new Response(JSON.stringify(movie));
        if (text.includes("system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
        if (text.includes("/rootfolder")) return new Response("[]");
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    });
    storeRef = created.store;
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        languageConfirmed: true,
        preferredLanguage: "eng",
        reviewPath: reviewDir,
        profileAutoAssign: false,
        suggestionDefaults: { queueNewImports: true },
      }),
    });
    await created.app.request("/api/library/refresh", { method: "POST", headers });
    await created.inspectPending();
    await vi.waitFor(async () => {
      const review = (await (await created.app.request("/api/review", { headers })).json()) as { items: Array<{ id: string }> };
      expect(review.items).toHaveLength(1);
    });
    const review = (await (await created.app.request("/api/review", { headers })).json()) as { items: Array<{ id: string }> };
    const keep = await created.app.request(`/api/review/${review.items[0]?.id}/keep`, { method: "POST", headers });
    expect(keep.status).toBe(202);
    await vi.waitFor(async () => {
      const pending = (await (await created.app.request("/api/review", { headers })).json()) as { items: unknown[] };
      expect(pending.items).toHaveLength(0);
    });
    const jobsAfterKeep = (await (await created.app.request("/api/jobs", { headers })).json()) as { items: Array<{ status: string }> };
    expect(jobsAfterKeep.items.filter((job) => job.status === "queued" || job.status === "held" || job.status === "running")).toEqual([]);
    const history = (await (await created.app.request("/api/history", { headers })).json()) as { items: Array<{ outcome: string }> };
    expect(history.items.some((row) => row.outcome === "kept")).toBe(true);
    expect(arrRefreshes.at(-1)).toEqual({ sizeBytes: keptSize, keptSizeBytes: keptSize });

    movie.path = join(dir, "avatar-kept.mkv");
    movie.movieFile = { ...movie.movieFile, path: movie.path, size: keptSize };
    movie.sizeOnDisk = keptSize;
    const minted = (await (await created.app.request("/api/settings/webhook-token", { method: "POST", headers })).json()) as { token: string };
    const renamed = await created.app.request("/api/hooks/arr", {
      method: "POST",
      headers: { "X-Api-Key": minted.token },
      body: JSON.stringify({ eventType: "Download", movie: { id: 10 } }),
    });
    expect(renamed.status).toBe(200);
    await vi.waitFor(() => {
      expect(created.store.listItems("movie")[0]?.path).toBe(movie.path);
    });
    await created.inspectPending();
    const jobsAfterRename = (await (await created.app.request("/api/jobs", { headers })).json()) as { items: Array<{ status: string }> };
    expect(jobsAfterRename.items.filter((job) => job.status === "queued" || job.status === "held" || job.status === "running")).toEqual([]);

    movie.movieFile = { ...movie.movieFile, size: upgradeSize };
    movie.sizeOnDisk = upgradeSize;
    const upgraded = await created.app.request("/api/hooks/arr", {
      method: "POST",
      headers: { "X-Api-Key": minted.token },
      body: JSON.stringify({ eventType: "Download", movie: { id: 10 } }),
    });
    expect(upgraded.status).toBe(200);
    await vi.waitFor(() => {
      expect(created.store.listItems("movie")[0]?.sizeBytes).toBe(upgradeSize);
    });
    await created.inspectPending();
    await vi.waitFor(async () => {
      const jobs = (await (await created.app.request("/api/jobs", { headers })).json()) as { items: Array<{ status: string }> };
      expect(jobs.items.some((job) => job.status === "queued" || job.status === "held" || job.status === "running" || job.status === "succeeded")).toBe(true);
      const open = (await (await created.app.request("/api/review", { headers })).json()) as { items: unknown[] };
      const active = jobs.items.filter((job) => job.status === "queued" || job.status === "held" || job.status === "running");
      expect(active.length + open.items.length).toBeGreaterThan(0);
    });
  });

  it("rejects writing integrations without a session", async () => {
    const ctx = await setup();
    apps.push(ctx);
    await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const res = await ctx.app.app.request("/api/integrations", {
      method: "POST",
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "secret-key", enabled: true }),
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("secret-key");
    const listed = await ctx.app.app.request("/api/integrations");
    expect(listed.status).toBe(401);
  });

  it("rejects enqueue without a session after first-run is complete", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
    });
    const res = await ctx.app.app.request("/api/queue", { method: "POST", body: JSON.stringify({ itemId: "missing" }) });
    expect(res.status).toBe(401);
  });

  it("does not trust client address headers when proxy trust is disabled", async () => {
    const ctx = await setup();
    apps.push(ctx);
    await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    ctx.store.saveSettings({ ...ctx.store.getSettings(), localAuthBypass: true });

    const res = await ctx.app.app.request("/api/home", {
      headers: { "x-real-ip": "127.0.0.1", "x-forwarded-for": "127.0.0.1" },
    });

    expect(res.status).toBe(401);
    expect((await ctx.app.app.request("/api/work", {
      headers: { "x-real-ip": "127.0.0.1", "x-forwarded-for": "127.0.0.1" },
    })).status).toBe(401);
  });

  it("does not send an Arr API key to an external poster host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-poster-"));
    const requests: Array<{ url: string; key: string | null }> = [];
    const created = createApp({
      env: loadEnv({ CONFIG_DIR: dir, PORT: "7373" }),
      hardware: async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null }),
      fetch: (async (input, init) => {
        requests.push({ url: String(input), key: new Headers(init?.headers).get("X-Api-Key") });
        return new Response("poster", { headers: { "content-type": "image/jpeg" } });
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "secret", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]!.id;
    created.store.upsertItem({
      id: "poster-item", instanceId, arrId: 1, arrSeriesId: null, arrEpisodeFileId: null, type: "movie",
      title: "Film", showTitle: null, season: null, episode: null, episodeTitle: null,
      path: "/movies/film.mkv", sizeBytes: 1, quality: "HD", resolution: "1080", profile: "HD", tags: [],
      posterRemoteUrl: "https://cdn.example/poster.jpg", sizeExempt: false,
    });

    expect((await created.app.request("/api/library/poster-item/poster", { headers })).status).toBe(200);
    expect(requests.at(-1)).toEqual({ url: "https://cdn.example/poster.jpg", key: null });
  });

  it("rejects a review folder that is a sibling of a title inside an Arr root", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    ctx.store.replaceLibraryRoots("radarr-a", ["/mnt/nas/movies"]);

    const res = await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers: { cookie: cookie(setupRes) },
      body: JSON.stringify({ reviewPath: "/mnt/nas/movies/review" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects malformed Settings input without changing saved values", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const before = ctx.store.getSettings();

    const res = await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers: { cookie: cookie(setupRes) },
      body: JSON.stringify({ concurrency: "many", writeMode: "overwrite" }),
    });

    expect(res.status).toBe(400);
    expect(ctx.store.getSettings()).toEqual(before);
  });

  it("returns not found for missing suggestion and job mutations", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };

    expect((await ctx.app.app.request("/api/suggestions/missing/dismiss", { method: "POST", headers })).status).toBe(404);
    expect((await ctx.app.app.request("/api/jobs/missing/run-now", { method: "POST", headers })).status).toBe(404);
    ctx.store.insertJob({
      id: "finished", itemId: "missing", suggestionId: null, status: "succeeded", phase: "idle", progress: 1,
      error: null, warning: null, runNow: false, createdAt: 1, plan: {},
    });
    expect((await ctx.app.app.request("/api/jobs/finished/run-now", { method: "POST", headers })).status).toBe(409);
  });

  it("creates, lists, and removes suggestion exclusions", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    const added = await ctx.app.app.request("/api/exclusions", {
      method: "POST", headers, body: JSON.stringify({ kind: "path", value: "/archive" }),
    });
    const addedBody = (await added.json()) as { id: string };
    expect((await (await ctx.app.app.request("/api/exclusions", { headers })).json())).toMatchObject({
      exclusions: [{ id: addedBody.id, kind: "path", value: "/archive" }],
    });
    expect((await ctx.app.app.request(`/api/exclusions/${addedBody.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(await (await ctx.app.app.request("/api/exclusions", { headers })).json()).toEqual({ exclusions: [] });
  });

  it("rejects minting a widget key without a session", async () => {
    const ctx = await setup();
    apps.push(ctx);
    await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const res = await ctx.app.app.request("/api/settings/widget-key", { method: "POST" });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/[a-f0-9]{32}/);
  });

  it("mints a widget key once and exposes hasWidgetKey on settings", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const minted = (await (await ctx.app.app.request("/api/settings/widget-key", { method: "POST", headers })).json()) as { key: string };
    expect(minted.key).toMatch(/^[a-f0-9]{48}$/);
    const settings = (await (await ctx.app.app.request("/api/settings", { headers })).json()) as { hasWidgetKey: boolean; username: string };
    expect(settings).toMatchObject({ hasWidgetKey: true, username: "ada" });
    expect(JSON.stringify(settings)).not.toContain(minted.key);
  });

  it("returns a bounded job log for an authed operator", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    ctx.store.insertJob({
      id: "job-log",
      itemId: "movie-1",
      suggestionId: null,
      status: "failed",
      phase: "idle",
      progress: 0,
      error: "Hardware encode is unavailable.",
      warning: null,
      runNow: false,
      createdAt: 1,
      plan: {},
    });
    ctx.store.appendJobLog("job-log", "ffmpeg: nack\n");
    const logs = (await (await ctx.app.app.request("/api/jobs/job-log/logs", { headers })).json()) as { log: string };
    expect(logs.log).toContain("ffmpeg: nack");
    expect((await ctx.app.app.request("/api/jobs/job-log/logs")).status).toBe(401);
  });

  it("requires a widget key on a public address", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const res = await ctx.app.app.request("/api/widget", { headers: { "x-real-ip": "8.8.8.8" } });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("/mnt/nas");
  });

  it("lists ISO files with ffmpeg and never calls ffprobe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    let probeCalls = 0;
    let isoCalls = 0;
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      probe: async () => {
        probeCalls += 1;
        return { format: { duration: "3600" }, streams: [] };
      },
      listIso: async () => {
        isoCalls += 1;
        return isoListedFfmpeg;
      },
      fetch: (async () => new Response("[]")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    created.store.upsertItem({
      id: `${instanceId}:movie:iso`,
      instanceId,
      arrId: 99,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Disc",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/mnt/nas/discs/Example.ISO",
      sizeBytes: 19_000_000_000,
      quality: "Bluray-1080p",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    await created.inspectPending();
    expect(isoCalls).toBe(1);
    expect(probeCalls).toBe(0);
    const report = created.store.getInspection(`${instanceId}:movie:iso`);
    expect(report?.sourceMethod).toBe("iso_ffmpeg");
    expect(report?.listingState).toBe("complete");
    expect(created.store.listErrors()).toHaveLength(0);
  });

  it("returns profile previews and sends search to title pages", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
    });
    await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
    const settings = (await (await ctx.app.app.request("/api/settings", { headers })).json()) as { profilePreviews?: Array<{ name: string }>; writeMode?: string };
    expect(settings.writeMode).toBe("sidecar");
    expect(settings.profilePreviews?.[0]?.name).toMatch(/^Polisharr /);
    const search = (await (await ctx.app.app.request("/api/search?q=underdog", { headers })).json()) as { items: Array<{ href: string }> };
    expect(search.items[0]?.href).toMatch(/^\/movies\//);
  });

  it("recomputes automatic suggestions when their settings are disabled", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
    });
    await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
    await ctx.app.inspectPending();
    expect(((await (await ctx.app.app.request("/api/suggestions", { headers })).json()) as { items: unknown[] }).items).toHaveLength(1);
    const probesBeforeSave = ctx.probeCalls();

    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        suggestionDefaults: {
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: false,
          transcodeToSizeCap: false,
          convertMp4ToMkv: true,
        },
      }),
    });

    const settings = (await (await ctx.app.app.request("/api/settings", { headers })).json()) as {
      suggestionDefaults?: Record<string, boolean>;
    };
    const suggestions = (await (await ctx.app.app.request("/api/suggestions", { headers })).json()) as { items: unknown[] };
    expect(settings.suggestionDefaults).toEqual({
      removeNonPreferredSubtitles: false,
      removeNonPreferredAudio: false,
      addStereo: false,
      transcodeToSizeCap: false,
      transcodeBelowHevc: false,
      convertMp4ToMkv: true,
      convertIsoToMkv: false,
      searchPreferredLanguage: false,
      queueNewImports: false,
    });
    expect(suggestions.items).toHaveLength(0);
    expect(ctx.probeCalls()).toBe(probesBeforeSave);
  });

  it("suggests AV1 for already-inspected HEVC on library refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null }),
      readable: async () => true,
      probe: async () => ({
        format: { duration: "3600" },
        streams: [
          { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" }, index: 1 },
        ],
      }),
      fetch: (async (url: string) => {
        if (String(url).includes("/movie")) {
          return new Response(JSON.stringify([{
            id: 10,
            title: "Already HEVC",
            path: "/mnt/nas/movies/hevc.mkv",
            sizeOnDisk: 1_000_000_000,
            movieFile: { path: "/mnt/nas/movies/hevc.mkv", size: 1_000_000_000, quality: { quality: { name: "Bluray-1080p" } } },
            images: [],
          }]));
        }
        if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        languageConfirmed: true,
        preferredLanguage: "eng",
        reviewPath: join(dir, "review"),
        videoTarget: "av1",
        suggestionDefaults: {
          transcodeToSizeCap: false,
          transcodeBelowHevc: false,
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: false,
        },
      }),
    });
    await created.app.request("/api/library/refresh", { method: "POST", headers });
    await created.inspectPending();
    expect(((await (await created.app.request("/api/suggestions", { headers })).json()) as { items: unknown[] }).items).toHaveLength(0);

    created.store.saveSettings({
      ...created.store.getSettings(),
      suggestionDefaults: { ...created.store.getSettings().suggestionDefaults, transcodeBelowHevc: true },
    });
    await created.app.request("/api/library/refresh", { method: "POST", headers });
    await created.inspectPending();
    const suggestions = (await (await created.app.request("/api/suggestions", { headers })).json()) as {
      items: Array<{ after?: { codec?: string }; reasons?: string[] }>;
    };
    expect(suggestions.items).toHaveLength(1);
    expect(suggestions.items[0]?.after?.codec).toBe("AV1");
    expect(suggestions.items[0]?.reasons?.some((reason) => reason.includes("HEVC") && reason.includes("AV1"))).toBe(true);
  });

  it("suggests AV1 for already-inspected HEVC once the GPU lists an AV1 encoder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    let releaseHardware: ((hw: HardwareInfo) => void) | undefined;
    const hardwareReady = new Promise<HardwareInfo>((resolve) => {
      releaseHardware = resolve;
    });
    const created = createApp({
      env,
      hardware: () => hardwareReady,
      readable: async () => true,
      probe: async () => ({
        format: { duration: "3600" },
        streams: [
          { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" }, index: 1 },
        ],
      }),
      fetch: (async (url: string) => {
        if (String(url).includes("/movie")) {
          return new Response(JSON.stringify([{
            id: 10,
            title: "Already HEVC",
            path: "/mnt/nas/movies/hevc.mkv",
            sizeOnDisk: 1_000_000_000,
            movieFile: { path: "/mnt/nas/movies/hevc.mkv", size: 1_000_000_000, quality: { quality: { name: "Bluray-1080p" } } },
            images: [],
          }]));
        }
        if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        languageConfirmed: true,
        preferredLanguage: "eng",
        reviewPath: join(dir, "review"),
        videoTarget: "av1",
        suggestionDefaults: {
          transcodeToSizeCap: false,
          transcodeBelowHevc: true,
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: false,
        },
      }),
    });
    await created.app.request("/api/library/refresh", { method: "POST", headers });
    await created.inspectPending();
    expect(((await (await created.app.request("/api/suggestions", { headers })).json()) as { items: unknown[] }).items).toHaveLength(0);

    releaseHardware?.({ backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null });
    await vi.waitFor(async () => {
      const suggestions = (await (await created.app.request("/api/suggestions", { headers })).json()) as {
        items: Array<{ after?: { codec?: string } }>;
      };
      expect(suggestions.items).toHaveLength(1);
      expect(suggestions.items[0]?.after?.codec).toBe("AV1");
    });
  });

  it("lets a movie encode target override the house HEVC target for AV1 suggestions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null }),
      readable: async () => true,
      probe: async () => ({
        format: { duration: "3600" },
        streams: [
          { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" }, index: 1 },
        ],
      }),
      fetch: (async (url: string) => {
        if (String(url).includes("/movie")) {
          return new Response(JSON.stringify([{
            id: 10,
            title: "Already HEVC",
            path: "/mnt/nas/movies/hevc.mkv",
            sizeOnDisk: 1_000_000_000,
            movieFile: { path: "/mnt/nas/movies/hevc.mkv", size: 1_000_000_000, quality: { quality: { name: "Bluray-1080p" } } },
            images: [],
          }]));
        }
        if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        languageConfirmed: true,
        preferredLanguage: "eng",
        reviewPath: join(dir, "review"),
        videoTarget: "hevc",
        suggestionDefaults: {
          transcodeToSizeCap: false,
          transcodeBelowHevc: true,
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: false,
        },
      }),
    });
    await created.app.request("/api/library/refresh", { method: "POST", headers });
    await created.inspectPending();
    expect(((await (await created.app.request("/api/suggestions", { headers })).json()) as { items: unknown[] }).items).toHaveLength(0);
    const itemId = created.store.listItems("movie")[0]?.id ?? "";
    const saved = await created.app.request(`/api/library/items/${itemId}/video-target`, {
      method: "POST",
      headers,
      body: JSON.stringify({ videoTarget: "av1" }),
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { item?: { videoTarget?: string }; healthyCount?: number; suggestionCount?: number };
    expect(body.item?.videoTarget).toBe("av1");
    expect(body.healthyCount).toBe(0);
    expect(body.suggestionCount).toBe(1);
    const suggestions = (await (await created.app.request("/api/suggestions", { headers })).json()) as {
      items: Array<{ after?: { codec?: string } }>;
    };
    expect(suggestions.items).toHaveLength(1);
    expect(suggestions.items[0]?.after?.codec).toBe("AV1");
  });

  it("lets a series encode target override the house target for every episode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null }),
      readable: async () => true,
      probe: async () => ({
        format: { duration: "1369" },
        streams: [
          { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" }, index: 1 },
        ],
      }),
      fetch: (async (url: string) => {
        if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Sonarr", version: "4" }));
        return new Response("[]");
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "sonarr", name: "Sonarr", url: "http://sonarr:8989", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        languageConfirmed: true,
        preferredLanguage: "eng",
        reviewPath: join(dir, "review"),
        videoTarget: "hevc",
        suggestionDefaults: {
          transcodeToSizeCap: false,
          transcodeBelowHevc: true,
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: false,
        },
      }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    created.store.upsertItem({
      id: `${instanceId}:episode:10`,
      instanceId,
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
      sizeBytes: 1_000_000_000,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    await created.inspectPending();
    expect(((await (await created.app.request("/api/suggestions", { headers })).json()) as { items: unknown[] }).items).toHaveLength(0);
    const saved = await created.app.request(`/api/library/series/${instanceId}/42/video-target`, {
      method: "POST",
      headers,
      body: JSON.stringify({ videoTarget: "av1" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ videoTarget: "av1", healthyCount: 0, suggestionCount: 1 });
    const series = (await (await created.app.request("/api/library/series", { headers })).json()) as {
      items: Array<{ videoTarget?: string | null; healthyCount?: number; suggestionCount?: number }>;
    };
    expect(series.items[0]?.videoTarget).toBe("av1");
    expect(series.items[0]?.healthyCount).toBe(0);
    expect(series.items[0]?.suggestionCount).toBe(1);
    const suggestions = (await (await created.app.request("/api/suggestions", { headers })).json()) as {
      items: Array<{ after?: { codec?: string } }>;
    };
    expect(suggestions.items).toHaveLength(1);
    expect(suggestions.items[0]?.after?.codec).toBe("AV1");
  });

  it("lets a series prefer stereo so 5.1 episodes get a stereo suggestion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      probe: async () => ({
        format: { duration: "1369" },
        streams: [
          { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "ac3", channels: 6, tags: { language: "eng" }, index: 1 },
        ],
      }),
      fetch: (async (url: string) => {
        if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Sonarr", version: "4" }));
        return new Response("[]");
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "sonarr", name: "Sonarr", url: "http://sonarr:8989", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        languageConfirmed: true,
        preferredLanguage: "eng",
        reviewPath: join(dir, "review"),
        suggestionDefaults: {
          transcodeToSizeCap: false,
          transcodeBelowHevc: false,
          removeNonPreferredSubtitles: false,
          removeNonPreferredAudio: false,
          addStereo: true,
        },
      }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    created.store.upsertItem({
      id: `${instanceId}:episode:10`,
      instanceId,
      arrId: 10,
      arrSeriesId: 42,
      arrEpisodeFileId: 10,
      type: "episode",
      title: "Pilot",
      showTitle: "Kids Show",
      season: 1,
      episode: 1,
      episodeTitle: "Pilot",
      path: "/tv/kids.mkv",
      sizeBytes: 1_000_000_000,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    await created.inspectPending();
    expect(((await (await created.app.request("/api/suggestions", { headers })).json()) as { items: unknown[] }).items).toHaveLength(0);
    const saved = await created.app.request(`/api/library/series/${instanceId}/42/audio-mix`, {
      method: "POST",
      headers,
      body: JSON.stringify({ audioMix: "stereo" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ audioMix: "stereo", healthyCount: 0, suggestionCount: 1 });
    const suggestions = (await (await created.app.request("/api/suggestions", { headers })).json()) as {
      items: Array<{
        reasons?: string[];
        keepAudio?: number[];
        stripAudio?: number[];
        actions?: string[];
        after?: { tracks?: string[] };
      }>;
    };
    expect(suggestions.items).toHaveLength(1);
    expect(suggestions.items[0]?.actions).toEqual(expect.arrayContaining(["tracks", "add_stereo"]));
    expect(suggestions.items[0]?.keepAudio).toEqual([]);
    expect(suggestions.items[0]?.stripAudio).toEqual([1]);
    expect(suggestions.items[0]?.reasons?.some((reason) => /Replace surround/i.test(reason))).toBe(true);
    expect(suggestions.items[0]?.after?.tracks?.some((track) => /AAC 2\.0/i.test(track))).toBe(true);
    expect(suggestions.items[0]?.after?.tracks?.some((track) => /5\.1|ac3/i.test(track))).toBe(false);
  });

  it("rejects a do-nothing custom plan with a field error", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
    });
    await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
    await ctx.app.inspectPending();
    const movies = (await (await ctx.app.app.request("/api/library/movies", { headers })).json()) as {
      items: Array<{ id: string; videoLabel?: string; report?: unknown }>;
    };
    const id = movies.items[0]?.id ?? "";
    expect(movies.items[0]?.videoLabel).toMatch(/h264/i);
    expect(movies.items[0]?.report).toBeUndefined();
    const title = (await (await ctx.app.app.request(`/api/library/items/${id}`, { headers })).json()) as { item: { report?: { durationSec?: number } } };
    expect(title.item.report?.durationSec).toBeGreaterThan(0);
    const empty = await ctx.app.app.request(`/api/library/items/${id}/plan`, { method: "POST", headers, body: JSON.stringify({ draft: {} }) });
    expect(empty.status).toBe(400);
    const body = (await empty.json()) as { errors?: Array<{ field: string }> };
    expect(body.errors?.[0]?.field).toBe("plan");
  });

  it("removes the automatic suggestion when a custom plan is queued", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
    });
    await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
    await ctx.app.inspectPending();
    const movies = (await (await ctx.app.app.request("/api/library/movies", { headers })).json()) as {
      items: Array<{ id: string; reasons: string[]; suggestion: { id: string } | null }>;
    };
    const id = movies.items[0]?.id ?? "";
    const suggestionId = movies.items[0]?.suggestion?.id;
    expect(suggestionId).toBeTruthy();
    const queued = await ctx.app.app.request(`/api/library/items/${id}/queue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ draft: { video: { mode: "quality", quality: 22 } } }),
    });
    expect(queued.status).toBe(200);
    const suggestions = (await (await ctx.app.app.request("/api/suggestions", { headers })).json()) as { items: Array<{ id: string }> };
    expect(suggestions.items.some((row) => row.id === suggestionId)).toBe(false);
    const after = (await (await ctx.app.app.request("/api/library/movies", { headers })).json()) as {
      items: Array<{ id: string; reasons: string[]; suggestion: { id: string } | null }>;
    };
    expect(after.items[0]?.suggestion).toBeNull();
    const jobs = (await (await ctx.app.app.request("/api/jobs", { headers })).json()) as { items: Array<{ status: string }> };
    if (jobs.items.some((job) => job.status === "queued" || job.status === "running" || job.status === "held")) {
      expect(after.items[0]?.reasons.some((reason) => /encoder quality/i.test(reason) || /quality/i.test(reason))).toBe(true);
    }
    const bulk = await ctx.app.app.request("/api/queue", {
      method: "POST",
      headers,
      body: JSON.stringify({ suggestionId }),
    });
    expect(bulk.status).toBe(400);
  });

  it("rejects downscale on a copy-mode custom plan without a type assertion", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await ctx.app.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
    });
    await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
    await ctx.app.inspectPending();
    const movies = (await (await ctx.app.app.request("/api/library/movies", { headers })).json()) as { items: Array<{ id: string }> };
    const id = movies.items[0]?.id ?? "";
    const res = await ctx.app.app.request(`/api/library/items/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ draft: { video: { mode: "copy", downscale1080p: true } } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: Array<{ field: string }> };
    expect(body.errors?.[0]?.field).toBe("video.downscale1080p");
  });

  it("ends inspect after unreadable files and does not leave pending work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    let missingReads = 0;
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async (path) => {
        if (path.includes("missing")) missingReads += 1;
        return !path.includes("missing");
      },
      probe: async () => ({
        format: { duration: "3600" },
        streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
      }),
      fetch: (async () => new Response("[]")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    created.store.upsertItem({
      id: `${instanceId}:movie:ok`,
      instanceId,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Ok",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/mnt/nas/ok.mkv",
      sizeBytes: 1_000,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    created.store.upsertItem({
      id: `${instanceId}:movie:missing`,
      instanceId,
      arrId: 2,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Missing",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/mnt/nas/missing.mkv",
      sizeBytes: 1_000,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    await created.inspectPending();
    const state = created.store.getInspectState();
    expect(state.walking).toBe(false);
    expect(state.pending).toBe(0);
    expect(state.failed).toBe(1);
    expect(created.store.getInspection(`${instanceId}:movie:ok`)).toBeTruthy();
    expect(created.store.listErrors().some((e) => e.path.includes("missing"))).toBe(true);
    expect(missingReads).toBe(1);
    await created.inspectPending();
    expect(missingReads).toBe(1);
    expect(created.store.getInspectState().pending).toBe(0);
    expect(created.store.getInspectState().walking).toBe(false);
  });

  it("does not reset leftover count when inspect is already walking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let probes = 0;
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      probe: async () => {
        probes += 1;
        if (probes === 2) await gate;
        return {
          format: { duration: "3600" },
          streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
        };
      },
      fetch: (async () => new Response("[]")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    for (const name of ["one", "two"] as const) {
      created.store.upsertItem({
        id: `${instanceId}:movie:${name}`,
        instanceId,
        arrId: name === "one" ? 1 : 2,
        arrSeriesId: null,
        arrEpisodeFileId: null,
        type: "movie",
        title: name,
        showTitle: null,
        season: null,
        episode: null,
        episodeTitle: null,
        path: `/mnt/nas/${name}.mkv`,
        sizeBytes: 1_000,
        quality: "HD",
        resolution: "1080",
        profile: "HD",
        tags: [],
        posterRemoteUrl: null,
        sizeExempt: false,
      });
    }
    const first = created.inspectPending();
    await vi.waitFor(() => {
      expect(created.store.getInspectState().pending).toBe(1);
    });
    const during = created.store.getInspectState().pending;
    const second = created.inspectPending();
    expect(created.store.getInspectState().pending).toBe(during);
    release();
    await first;
    await second;
    expect(probes).toBe(2);
    expect(created.store.getInspectState().pending).toBe(0);
    expect(created.store.getInspectState().walking).toBe(false);
  });

  it("does not count episodes without a file path as leftover inspect work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      probe: async () => ({
        format: { duration: "3600" },
        streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
      }),
      fetch: (async () => new Response("[]")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    await created.app.request("/api/integrations", {
      method: "POST",
      headers: { cookie: cookie(setupRes) },
      body: JSON.stringify({ kind: "sonarr", name: "Sonarr", url: "http://sonarr:8989", apiKey: "k", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    created.store.upsertItem({
      id: `${instanceId}:episode:1`,
      instanceId,
      arrId: 1,
      arrSeriesId: 9,
      arrEpisodeFileId: null,
      type: "episode",
      title: "Star Wars Rebels",
      showTitle: "Star Wars Rebels",
      season: 1,
      episode: 1,
      episodeTitle: "Spark",
      path: "",
      sizeBytes: 0,
      quality: "",
      resolution: "",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    await created.inspectPending();
    expect(created.store.getInspectState().pending).toBe(0);
    expect(created.store.getInspection(`${instanceId}:episode:1`)).toBeUndefined();
  });

  it("drops leftover count when a file starts inspecting, not only after it finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      probe: async () => {
        await gate;
        return {
          format: { duration: "3600" },
          streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
        };
      },
      fetch: (async () => new Response("[]")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    created.store.upsertItem({
      id: `${instanceId}:movie:slow`,
      instanceId,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Slow",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/mnt/nas/slow.mkv",
      sizeBytes: 1_000,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    const walk = created.inspectPending();
    await vi.waitFor(() => {
      expect(created.store.getInspectState().pending).toBe(0);
    });
    expect(created.store.getInspectState().walking).toBe(true);
    release();
    await walk;
    expect(created.store.getInspectState().walking).toBe(false);
  });

  it("lists this machine as the only encode node without a cluster token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373", POLISHARR_NODE_NAME: "homeserver" });
    const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null };
    const created = createApp({ env, hardware: async () => hw });
    apps.push({ store: created.store, app: created });
    expect((await created.app.request("/api/nodes")).status).toBe(401);
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const listed = await created.app.request("/api/nodes", { headers });
    const body = (await listed.json()) as {
      thisNodeId: string;
      defaultEncodeNodeId: string;
      nodes: Array<{ name: string; role: string; roleLabel: string; thisNode: boolean; hardwareLabel: string; concurrency: number; online: boolean }>;
    };
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]?.name).toBe("homeserver");
    expect(body.nodes[0]?.role).toBe("standalone");
    expect(body.nodes[0]?.roleLabel).toBe("This machine");
    expect(body.nodes[0]?.thisNode).toBe(true);
    expect(body.nodes[0]?.online).toBe(true);
    expect(body.nodes[0]?.hardwareLabel).toBe("NVIDIA GPU, AV1 encoder listed");
    expect(body.nodes[0]?.concurrency).toBe(1);
    expect(body.defaultEncodeNodeId).toBe(body.thisNodeId);
    const settings = (await (await created.app.request("/api/settings", { headers })).json()) as { hasClusterToken?: boolean; thisNodeId?: string };
    expect(settings.hasClusterToken).toBe(false);
    expect(settings.thisNodeId).toBe(body.thisNodeId);
  });

  it("lets a worker hello a master and marks it offline after the stale window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    let now = 1_000;
    const env = loadEnv({
      CONFIG_DIR: dir,
      PORT: "7373",
      POLISHARR_ROLE: "master",
      POLISHARR_NODE_NAME: "homeserver",
      POLISHARR_CLUSTER_TOKEN: "cluster-secret",
    });
    const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null };
    const created = createApp({ env, hardware: async () => hw, clock: () => now });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const denied = await created.app.request("/api/cluster/hello", {
      method: "POST",
      body: JSON.stringify({ nodeId: "worker-1", name: "5090", version: "0.2.18", hardware: hw, concurrency: 1 }),
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "The cluster token is wrong." });
    const hello = await created.app.request("/api/cluster/hello", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "worker-1", name: "5090", version: "0.2.18", hardware: hw, concurrency: 1 }),
    });
    expect(hello.status).toBe(200);
    const listed = (await (await created.app.request("/api/nodes", { headers })).json()) as {
      nodes: Array<{ id: string; name: string; role: string; online: boolean; thisNode: boolean }>;
      defaultEncodeNodeId: string;
    };
    const worker = listed.nodes.find((node) => node.id === "worker-1");
    const masterNode = listed.nodes.find((node) => node.thisNode);
    expect(worker).toMatchObject({ name: "5090", role: "worker", online: true });
    expect(masterNode).toMatchObject({ name: "homeserver", role: "master", online: true });
    now = 1_000 + 60_000 + 1;
    const stale = (await (await created.app.request("/api/nodes", { headers })).json()) as {
      nodes: Array<{ id: string; online: boolean }>;
    };
    expect(stale.nodes.find((node) => node.id === "worker-1")?.online).toBe(false);
    const beat = await created.app.request("/api/cluster/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "worker-1", hardware: hw, concurrency: 1 }),
    });
    expect(beat.status).toBe(200);
    const fresh = (await (await created.app.request("/api/nodes", { headers })).json()) as {
      nodes: Array<{ id: string; online: boolean }>;
    };
    expect(fresh.nodes.find((node) => node.id === "worker-1")?.online).toBe(true);
    const unknown = await created.app.request("/api/cluster/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "missing", hardware: hw }),
    });
    expect(unknown.status).toBe(404);
    const saved = await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultEncodeNodeId: "worker-1" }),
    });
    expect(saved.status).toBe(200);
    const settings = (await (await created.app.request("/api/settings", { headers })).json()) as { defaultEncodeNodeId: string };
    expect(settings.defaultEncodeNodeId).toBe("worker-1");
  });

  it("leases a job to the assigned worker and writes Review from a remote sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({
      CONFIG_DIR: dir,
      PORT: "7373",
      POLISHARR_ROLE: "master",
      POLISHARR_NODE_NAME: "homeserver",
      POLISHARR_CLUSTER_TOKEN: "cluster-secret",
    });
    const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null };
    const created = createApp({
      env,
      hardware: async () => hw,
      readable: async () => true,
      probe: async () => ({
        format: { duration: "3600" },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac", channels: 6, tags: { language: "eng" }, index: 1 },
          { codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "spa" }, index: 2 },
        ],
      }),
      fetch: (async (url: string) => {
        if (String(url).includes("/movie")) {
          return new Response(JSON.stringify([{
            id: 10,
            title: "American Underdog",
            path: "/mnt/nas/movies/underdog.mkv",
            sizeOnDisk: 8_000_000_000,
            movieFile: { path: "/mnt/nas/movies/underdog.mkv", size: 8_000_000_000, quality: { quality: { name: "Bluray-1080p" } } },
          }]));
        }
        if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
      optimizer: async () => {
        throw new Error("The master must not run a job assigned to a worker.");
      },
    });
    created.jobs.stop();
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(dir, "review") }),
    });
    await created.app.request("/api/library/refresh", { method: "POST", headers });
    await created.inspectPending();
    await created.app.request("/api/cluster/hello", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "worker-1", name: "5090", version: "0.2.18", hardware: hw, concurrency: 1 }),
    });
    const suggestions = (await (await created.app.request("/api/suggestions", { headers })).json()) as { items: Array<{ id: string }> };
    expect(suggestions.items.length).toBeGreaterThan(0);
    const queued = await created.app.request("/api/queue", {
      method: "POST",
      headers,
      body: JSON.stringify({ suggestionId: suggestions.items[0]?.id, assignedNodeId: "worker-1" }),
    });
    expect(queued.status).toBe(200);
    const queuedBody = (await queued.json()) as { id: string };
    expect(created.store.getJob(queuedBody.id)).toMatchObject({ status: "queued", assignedNodeId: "worker-1" });
    await created.app.request("/api/cluster/hello", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "worker-2", name: "intel", version: "0.2.18", hardware: hw, concurrency: 1 }),
    });
    const empty = await created.app.request("/api/cluster/claim", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "worker-2", freeSlots: 1 }),
    });
    expect(((await empty.json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
    const claimed = await created.app.request("/api/cluster/claim", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "worker-1", freeSlots: 1 }),
    });
    const claimedBody = (await claimed.json()) as { jobs: Array<{ id: string; leaseToken: string; sourcePath: string }> };
    expect(claimedBody.jobs).toHaveLength(1);
    expect(claimedBody.jobs[0]?.id).toBe(queuedBody.id);
    const again = await created.app.request("/api/cluster/claim", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "worker-1", freeSlots: 1 }),
    });
    expect(((await again.json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
    const progressed = await created.app.request(`/api/cluster/jobs/${queuedBody.id}/progress`, {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ leaseToken: claimedBody.jobs[0]?.leaseToken, phase: "transcoding", progress: 0.4, log: "frame=1\n" }),
    });
    expect(progressed.status).toBe(200);
    expect(created.store.getJob(queuedBody.id)).toMatchObject({ phase: "transcoding", progress: 0.4 });
    const logOnly = await created.app.request(`/api/cluster/jobs/${queuedBody.id}/progress`, {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ leaseToken: claimedBody.jobs[0]?.leaseToken, log: "frame=2\n" }),
    });
    expect(logOnly.status).toBe(200);
    expect(created.store.getJob(queuedBody.id)).toMatchObject({ phase: "transcoding", progress: 0.4 });
    const oldWorkerLog = await created.app.request(`/api/cluster/jobs/${queuedBody.id}/progress`, {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ leaseToken: claimedBody.jobs[0]?.leaseToken, phase: "transcoding", progress: 0, log: "frame=3\n" }),
    });
    expect(oldWorkerLog.status).toBe(200);
    expect(created.store.getJob(queuedBody.id)).toMatchObject({ phase: "transcoding", progress: 0.4 });
    const sidecarPath = join(dir, "out.mkv");
    writeFileSync(sidecarPath, "SIDECAR");
    const done = await created.app.request(`/api/cluster/jobs/${queuedBody.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({
        leaseToken: claimedBody.jobs[0]?.leaseToken,
        sidecarPath,
        output: {
          sourceSig: "out|1",
          sourceMethod: "ffprobe",
          listingState: "complete",
          durationSec: 3600,
          sizeBytes: 3_000_000_000,
          sizePerHourGb: 3,
          videoCodec: "hevc",
          width: 1920,
          height: 1080,
          bitDepth: 8,
          hdr: "none",
          audio: [{ index: 1, language: "eng", channels: 2, codec: "aac", title: "", untagged: false, commentary: false }],
          subtitles: [],
          hasChapters: false,
          hasAttachments: false,
        },
      }),
    });
    expect(done.status).toBe(200);
    expect(created.store.getJob(queuedBody.id)?.status).toBe("succeeded");
    expect(created.store.listReviews()).toHaveLength(1);
    expect(created.store.listReviews()[0]?.sidecarPath).toBe(sidecarPath);
    expect(created.store.listReviews()[0]).toMatchObject({
      nodeName: "5090",
      encodeApi: "CUDA",
    });
    expect(created.store.listReviews()[0]?.encodeApi).not.toBe("QuickSync");
    expect(created.store.listReviews()[0]?.encodeMs).toBeGreaterThanOrEqual(0);
    const listed = (await (await created.app.request("/api/jobs", { headers })).json()) as {
      items: Array<{ id: string; assignedNodeName: string | null }>;
    };
    expect(listed.items.find((job) => job.id === queuedBody.id)?.assignedNodeName).toBe("5090");
  });

  it("rejects an AV1 job on a HEVC-only node, offers cluster AV1, and skips claims on a drained node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({
      CONFIG_DIR: dir,
      PORT: "7373",
      POLISHARR_ROLE: "master",
      POLISHARR_NODE_NAME: "homeserver",
      POLISHARR_CLUSTER_TOKEN: "cluster-secret",
    });
    const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null };
    const created = createApp({ env, hardware: async () => hw });
    created.jobs.stop();
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/cluster/hello", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({
        nodeId: "intel",
        name: "intel",
        version: "0.2.18",
        hardware: { backend: "vaapi", cuda: false, vaapi: true, av1: false, reason: null },
        concurrency: 1,
      }),
    });
    await created.app.request("/api/cluster/hello", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({
        nodeId: "5090",
        name: "5090",
        version: "0.2.18",
        hardware: { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null },
        concurrency: 1,
      }),
    });
    const listed = (await (await created.app.request("/api/nodes", { headers })).json()) as { av1Available: boolean };
    expect(listed.av1Available).toBe(true);
    const instanceId = created.store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "k",
      enabled: true,
    });
    created.store.upsertItem({
      id: `${instanceId}:movie:1`,
      instanceId,
      arrId: 1,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: "/mnt/nas/movies/film.mkv",
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    created.store.saveInspection(`${instanceId}:movie:1`, {
      sourceSig: "p|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 3600,
      sizeBytes: 8,
      sizePerHourGb: 1,
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    });
    const av1Plan = {
      origin: "custom" as const,
      video: { kind: "size" as const, codec: "av1" as const, targetBytes: 3, downscale1080p: false, bitDepth: 8 },
      audio: [],
      subtitles: [],
      container: "mkv" as const,
      writeMode: "sidecar" as const,
      warning: null,
      reasons: ["AV1"],
      estimatedOutputBytes: 3,
      category: "movie1080p" as const,
    };
    const denied = created.jobs.enqueueCustom(`${instanceId}:movie:1`, av1Plan, { assignedNodeId: "intel" });
    expect(denied).toMatchObject({ error: "That encode node cannot run this plan.", status: 400 });
    const ok = created.jobs.enqueueCustom(`${instanceId}:movie:1`, av1Plan, { assignedNodeId: "5090" });
    expect("id" in ok).toBe(true);
    if (!("id" in ok)) return;
    await created.app.request("/api/nodes/5090", {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    const claimed = await created.app.request("/api/cluster/claim", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-secret" },
      body: JSON.stringify({ nodeId: "5090", freeSlots: 1 }),
    });
    expect(((await claimed.json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
    expect(created.store.getJob(ok.id)?.status).toBe("queued");
    await created.app.request(`/api/jobs/${ok.id}/assign`, {
      method: "POST",
      headers,
      body: JSON.stringify({ nodeId: "intel" }),
    });
    expect(created.store.getJob(ok.id)?.assignedNodeId).toBe("5090");
  });

  it("does not accept cluster hello on standalone", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/settings/cluster-token", { method: "POST", headers });
    const hello = await ctx.app.app.request("/api/cluster/hello", {
      method: "POST",
      headers: { Authorization: "Bearer unused" },
      body: JSON.stringify({ nodeId: "worker-1", name: "5090", version: "0.2.18" }),
    });
    expect(hello.status).toBe(404);
    expect(await hello.json()).toEqual({
      error: "This Polisharr is not accepting workers. Set POLISHARR_ROLE=master on the always-on host.",
    });
  });

  it("keeps a worker from creating an admin or mutating the library", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-"));
    const env = loadEnv({
      CONFIG_DIR: dir,
      PORT: "7373",
      POLISHARR_ROLE: "worker",
      POLISHARR_NODE_NAME: "5090",
      POLISHARR_MASTER_URL: "http://192.168.1.10:7373",
      POLISHARR_CLUSTER_TOKEN: "cluster-secret",
    });
    const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null };
    const created = createApp({
      env,
      hardware: async () => hw,
      fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const status = (await (await created.app.request("/api/auth/status")).json()) as { role: string };
    expect(status.role).toBe("worker");
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    expect(setupRes.status).toBe(409);
    expect(await setupRes.json()).toEqual({ error: "This container is a worker. Open the master to manage the library." });
    expect(created.store.userCount()).toBe(0);
    const queue = await created.app.request("/api/queue", { method: "POST", body: JSON.stringify({}) });
    expect(queue.status).toBe(409);
    const worker = (await (await created.app.request("/api/worker")).json()) as {
      name: string;
      masterUrl: string;
      hardwareLabel: string;
      detail: string;
    };
    expect(worker.name).toBe("5090");
    expect(worker.masterUrl).toBe("http://192.168.1.10:7373");
    expect(worker.hardwareLabel).toContain("NVIDIA GPU");
    expect(worker.detail).toContain("http://192.168.1.10:7373");
  });

  it("mints a cluster token once and never echoes it from settings", async () => {
    const ctx = await setup();
    apps.push(ctx);
    expect((await ctx.app.app.request("/api/settings/cluster-token", { method: "POST" })).status).toBe(401);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const minted = await ctx.app.app.request("/api/settings/cluster-token", { method: "POST", headers });
    const body = (await minted.json()) as { token?: string };
    expect(body.token).toMatch(/^[a-f0-9]{48}$/);
    const listed = await ctx.app.app.request("/api/settings", { headers });
    const settings = (await listed.json()) as { hasClusterToken?: boolean };
    expect(settings.hasClusterToken).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(body.token);
  });

  it("mints a webhook token once and never echoes it from settings", async () => {
    const ctx = await setup();
    apps.push(ctx);
    expect((await ctx.app.app.request("/api/settings/webhook-token", { method: "POST" })).status).toBe(401);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const minted = await ctx.app.app.request("/api/settings/webhook-token", { method: "POST", headers });
    const body = (await minted.json()) as { token?: string; url?: string };
    expect(body.token).toMatch(/^[a-f0-9]{48}$/);
    expect(body.url).toBe("/api/hooks/arr");
    const listed = await ctx.app.app.request("/api/settings", { headers });
    const settings = (await listed.json()) as { hasWebhookToken?: boolean };
    expect(settings.hasWebhookToken).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(body.token);
  });

  it("accepts an Arr webhook with a header or Basic token and rejects a bad token", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const minted = (await (await ctx.app.app.request("/api/settings/webhook-token", { method: "POST", headers })).json()) as { token: string };
    const denied = await ctx.app.app.request("/api/hooks/arr", { method: "POST", body: JSON.stringify({ eventType: "Test" }) });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "The webhook token is wrong." });
    const testOk = await ctx.app.app.request("/api/hooks/arr", {
      method: "POST",
      headers: { "X-Api-Key": minted.token },
      body: JSON.stringify({ eventType: "Test" }),
    });
    expect(testOk.status).toBe(200);
    const basicOk = await ctx.app.app.request("/api/hooks/arr", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`hook:${minted.token}`).toString("base64")}` },
      body: JSON.stringify({ eventType: "Test" }),
    });
    expect(basicOk.status).toBe(200);
    const queryOk = await ctx.app.app.request(`/api/hooks/arr?apikey=${minted.token}`, {
      method: "POST",
      body: JSON.stringify({ eventType: "Test" }),
    });
    expect(queryOk.status).toBe(200);
  });

  it("syncs a Radarr import from the webhook without enqueueing optimize", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await ctx.app.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    const minted = (await (await ctx.app.app.request("/api/settings/webhook-token", { method: "POST", headers })).json()) as { token: string };
    const jobsBefore = (await (await ctx.app.app.request("/api/jobs", { headers })).json()) as { items: unknown[] };
    expect(jobsBefore.items).toEqual([]);
    const accepted = await ctx.app.app.request("/api/hooks/arr", {
      method: "POST",
      headers: { "X-Api-Key": minted.token },
      body: JSON.stringify({ eventType: "Download", movie: { id: 10 } }),
    });
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => {
      expect(ctx.store.listItems("movie").some((item) => item.title === "American Underdog")).toBe(true);
    });
    const jobsAfter = (await (await ctx.app.app.request("/api/jobs", { headers })).json()) as { items: unknown[] };
    expect(jobsAfter.items).toEqual([]);
  });

  it("requires a session and a confirm before asking Radarr to search for preferred audio", async () => {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "opt-search-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      fetch: (async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (String(url).includes("/system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
        if (String(url).endsWith("/movie/10")) {
          return new Response(JSON.stringify({ id: 10, movieFile: { id: 77, path: "/media/film.mkv" } }));
        }
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    expect((await created.app.request("/api/library/items/x/search-preferred", { method: "POST", body: "{}" })).status).toBe(401);
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(dir, "review") }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    const itemId = `${instanceId}:movie:10`;
    created.store.upsertItem({
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
      path: "/media/film.mkv",
      sizeBytes: 1,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    created.store.saveInspection(itemId, {
      sourceSig: "/media/film.mkv|1",
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 3600,
      isoPlaylist: null,
      sizeBytes: 1,
      sizePerHourGb: 1,
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [{ index: 1, language: "deu", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false }],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    });
    const denied = await created.app.request(`/api/library/items/${itemId}/search-preferred`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(400);
    const ok = await created.app.request(`/api/library/items/${itemId}/search-preferred`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: true }),
    });
    expect(ok.status).toBe(200);
    expect(created.store.getItem(itemId)).toBeUndefined();
    expect(calls.some((call) => call.startsWith("DELETE ") && call.includes("/moviefile/77"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST ") && call.includes("/command"))).toBe(true);
  });

  it("identifies an untagged soundtrack and saves the language without rewriting the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-lid-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const sourcePath = join(dir, "film.mkv");
    writeFileSync(sourcePath, "ORIGINAL");
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      extractLanguageClip: async () => undefined,
      runLanguageLid: async () => JSON.stringify({ language: "en", probability: 0.94 }),
      fetch: (async () => new Response("[]")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    expect((await created.app.request("/api/library/items/x/detect-language", { method: "POST", body: "{}" })).status).toBe(401);
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    const itemId = `${instanceId}:movie:10`;
    created.store.upsertItem({
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
      path: sourcePath,
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    created.store.saveInspection(itemId, {
      sourceSig: `${sourcePath}|8`,
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 7200,
      isoPlaylist: null,
      sizeBytes: 8,
      sizePerHourGb: 1,
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [{ index: 1, language: "und", channels: 6, codec: "dts", title: "", untagged: true, commentary: false }],
      subtitles: [],
      hasChapters: false,
      hasAttachments: false,
    });
    const title = (await (await created.app.request(`/api/library/items/${itemId}`, { headers })).json()) as { languageId?: { available?: boolean } };
    expect(title.languageId?.available).toBe(true);
    const detected = await created.app.request(`/api/library/items/${itemId}/detect-language`, {
      method: "POST",
      headers,
      body: JSON.stringify({ trackIndex: 1 }),
    });
    const detectedBody = (await detected.json()) as { ok?: boolean; language?: string; probability?: number };
    expect(detected.status).toBe(200);
    expect(detectedBody).toMatchObject({ ok: true, language: "eng" });
    expect(created.store.getInspection(itemId)?.audio[0]?.language).toBe("und");
    const applied = await created.app.request(`/api/library/items/${itemId}/apply-language`, {
      method: "POST",
      headers,
      body: JSON.stringify({ trackIndex: 1, language: "eng", probability: detectedBody.probability }),
    });
    expect(applied.status).toBe(200);
    expect(created.store.getInspection(itemId)?.audio[0]).toMatchObject({ language: "eng", untagged: false });
    expect(readFileSync(sourcePath, "utf8")).toBe("ORIGINAL");
  });

  it("identifies an untagged text subtitle without rewriting the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-sub-lid-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const sourcePath = join(dir, "film.mkv");
    writeFileSync(sourcePath, "ORIGINAL");
    const sample = `1
00:01:30,000 --> 00:01:40,000
The quick brown fox jumps over the lazy dog. Hello, how are you today? This is a longer sample of English dialogue from a movie scene.
`;
    const created = createApp({
      env,
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      extractSubtitleSample: async () => sample,
      fetch: (async () => new Response("[]")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    expect((await created.app.request("/api/library/items/x/detect-subtitle-language", { method: "POST", body: "{}" })).status).toBe(401);
    const setupRes = await created.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
    });
    const instanceId = created.store.listInstances()[0]?.id ?? "";
    const itemId = `${instanceId}:movie:11`;
    created.store.upsertItem({
      id: itemId,
      instanceId,
      arrId: 11,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Film",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: sourcePath,
      sizeBytes: 8,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    created.store.saveInspection(itemId, {
      sourceSig: `${sourcePath}|8`,
      sourceMethod: "ffprobe",
      listingState: "complete",
      durationSec: 7200,
      isoPlaylist: null,
      sizeBytes: 8,
      sizePerHourGb: 1,
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      hdr: "none",
      audio: [],
      subtitles: [{ index: 2, language: "und", codec: "subrip", title: "", untagged: true, forced: false, sdh: false }],
      hasChapters: false,
      hasAttachments: false,
    });
    const detected = await created.app.request(`/api/library/items/${itemId}/detect-subtitle-language`, {
      method: "POST",
      headers,
      body: JSON.stringify({ trackIndex: 2 }),
    });
    const detectedBody = (await detected.json()) as { ok?: boolean; language?: string; probability?: number };
    expect(detected.status).toBe(200);
    expect(detectedBody).toMatchObject({ ok: true, language: "eng" });
    expect(created.store.getInspection(itemId)?.subtitles[0]?.language).toBe("und");
    const applied = await created.app.request(`/api/library/items/${itemId}/apply-subtitle-language`, {
      method: "POST",
      headers,
      body: JSON.stringify({ trackIndex: 2, language: "eng", probability: detectedBody.probability }),
    });
    expect(applied.status).toBe(200);
    expect(created.store.getInspection(itemId)?.subtitles[0]).toMatchObject({ language: "eng", untagged: false });
    expect(readFileSync(sourcePath, "utf8")).toBe("ORIGINAL");
  });
});
