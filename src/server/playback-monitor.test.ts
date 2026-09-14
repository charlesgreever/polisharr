import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.ts";
import { createPlaybackMonitor, mediaPathsEqual, parsePlaybackSettingsInput } from "./playback-monitor.ts";
import type { LibraryItem } from "./types.ts";

const stores: Store[] = [];
const monitors: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  for (const monitor of monitors) await monitor.stop();
  monitors.length = 0;
  for (const store of stores) store.close();
  stores.length = 0;
});

function store(): Store {
  const created = new Store(join(mkdtempSync(join(tmpdir(), "opt-play-")), "polisharr.db"));
  stores.push(created);
  return created;
}

function item(over: Partial<LibraryItem> & { id: string; instanceId: string; path: string; title: string }): Omit<LibraryItem, "hasPoster" | "instanceName"> {
  return {
    arrId: Number(over.id.replace(/\D/g, "") || 1),
    arrSeriesId: over.arrSeriesId ?? null,
    arrEpisodeFileId: over.arrEpisodeFileId ?? null,
    type: over.type ?? "movie",
    showTitle: over.showTitle ?? null,
    season: over.season ?? null,
    episode: over.episode ?? null,
    episodeTitle: over.episodeTitle ?? null,
    sizeBytes: over.sizeBytes ?? 1,
    quality: "Bluray-1080p",
    resolution: "1080",
    profile: "HD",
    tags: [],
    posterRemoteUrl: null,
    sizeExempt: false,
    tmdbId: over.tmdbId ?? 42,
    ...over,
  };
}

function seedLibrary(db: Store) {
  db.upsertInstance({ id: "radarr", kind: "radarr", name: "Radarr", url: "http://radarr", enabled: true });
  db.upsertInstance({ id: "sonarr", kind: "sonarr", name: "Sonarr", url: "http://sonarr", enabled: true });
  db.upsertInstance({ id: "jf", kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", secret: "server-key", enabled: true });
  db.upsertItem(item({ id: "film-1080", instanceId: "radarr", path: "/mnt/nas/movies/film-1080.mkv", title: "The Film", tmdbId: 42 }));
  db.upsertItem(item({ id: "film-4k", instanceId: "radarr", path: "/mnt/nas/movies/film-4k.mkv", title: "The Film", tmdbId: 42 }));
  db.upsertItem(item({
    id: "ep-1",
    instanceId: "sonarr",
    path: "/mnt/nas/tv/show/S01E01-E02.mkv",
    title: "Show",
    type: "episode",
    showTitle: "Show",
    season: 1,
    episode: 1,
    episodeTitle: "One",
    arrId: 11,
    arrSeriesId: 9,
    arrEpisodeFileId: 80,
  }));
  db.upsertItem(item({
    id: "ep-2",
    instanceId: "sonarr",
    path: "/mnt/nas/tv/show/S01E01-E02.mkv",
    title: "Show",
    type: "episode",
    showTitle: "Show",
    season: 1,
    episode: 2,
    episodeTitle: "Two",
    arrId: 12,
    arrSeriesId: 9,
    arrEpisodeFileId: 80,
  }));
}

function playing(over: Record<string, unknown> = {}) {
  return {
    Id: "sess-1",
    DeviceId: "living-room",
    DeviceName: "Living Room TV",
    IsActive: false,
    NowPlayingItem: {
      Id: "item-1",
      Name: "The Film",
      Type: "Movie",
      MediaType: "Video",
      MediaSources: [
        { Id: "src-1080", Path: "/mnt/nas/movies/film-1080.mkv", Protocol: "File", IsRemote: false },
        { Id: "src-4k", Path: "/mnt/nas/movies/film-4k.mkv", Protocol: "File", IsRemote: false },
      ],
    },
    PlayState: { IsPaused: false, MediaSourceId: "src-1080", PlayMethod: "Transcode", AudioStreamIndex: 1 },
    TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: false, TranscodeReasons: ["AudioCodecNotSupported"] },
    ...over,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function monitorFor(db: Store, sessions: () => unknown, extras: { now?: () => number; pollMs?: number } = {}) {
  const created = createPlaybackMonitor({
    store: db,
    decrypt: (value) => value,
    clock: extras.now ?? (() => 5_000),
    pollMs: extras.pollMs ?? 0,
    staleMs: 30_000,
    fetch: (async (url) => {
      const text = String(url);
      if (text.endsWith("/Auth/Keys")) return json({ Items: [{ AccessToken: "server-key", AppName: "Polisharr" }] });
      if (text.endsWith("/Sessions")) {
        const payload = sessions();
        if (payload instanceof Error) throw payload;
        return json(payload);
      }
      if (text.includes("/PlaybackInfo")) {
        return json({
          MediaSources: [
            { Id: "src-1080", Path: "/mnt/nas/movies/film-1080.mkv", Protocol: "File", IsRemote: false },
            { Id: "src-4k", Path: "/mnt/nas/movies/film-4k.mkv", Protocol: "File", IsRemote: false },
          ],
        });
      }
      return json({}, 404);
    }) as typeof fetch,
  });
  monitors.push(created);
  db.savePlaybackSettings([{
    ...db.defaultPlaybackConnectionSettings("jf"),
    observePlayback: true,
  }]);
  created.start();
  return created;
}

describe("playback path matching", () => {
  it("matches exact paths and rejects basename or title-only identity", () => {
    expect(mediaPathsEqual("/mnt/nas/movies/film-1080.mkv", "/mnt/nas/movies/film-1080.mkv")).toBe(true);
    expect(mediaPathsEqual("/mnt/nas/movies/film-1080.mkv", "/mnt/other/film-1080.mkv")).toBe(false);
    expect(mediaPathsEqual("/mnt/nas/movies/film-1080.mkv", "The Film")).toBe(false);
  });
});

describe("playback settings input", () => {
  it("keeps stored coverage when a PUT only enables observation", () => {
    const parsed = parsePlaybackSettingsInput(
      { connections: [{ connectionId: "jf", observePlayback: true }] },
      {
        jellyfinIds: ["jf"],
        arrIds: ["radarr", "sonarr"],
        nodeIds: ["node-1"],
        current: [{
          connectionId: "jf",
          observePlayback: false,
          retainHistory: true,
          protectNodes: true,
          protectedNodeIds: ["node-1"],
          protectReplacement: true,
          coveredArrInstanceIds: ["radarr", "sonarr"],
        }],
      },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.connections[0]).toEqual({
      connectionId: "jf",
      observePlayback: true,
      retainHistory: true,
      protectNodes: true,
      protectedNodeIds: ["node-1"],
      protectReplacement: true,
      coveredArrInstanceIds: ["radarr", "sonarr"],
    });
  });

  it("clears Arr coverage only when the list is sent", () => {
    const parsed = parsePlaybackSettingsInput(
      { connections: [{ connectionId: "jf", coveredArrInstanceIds: [] }] },
      {
        jellyfinIds: ["jf"],
        arrIds: ["radarr"],
        nodeIds: [],
        current: [{
          connectionId: "jf",
          observePlayback: true,
          retainHistory: true,
          protectNodes: false,
          protectedNodeIds: [],
          protectReplacement: false,
          coveredArrInstanceIds: ["radarr"],
        }],
      },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.connections[0]?.observePlayback).toBe(true);
    expect(parsed.connections[0]?.coveredArrInstanceIds).toEqual([]);
  });
});

describe("playback monitor", () => {
  it("attaches two versions that share provider ids to their own paths", async () => {
    const db = store();
    seedLibrary(db);
    const current = { source: "src-1080" };
    const monitor = monitorFor(db, () => [playing({ PlayState: { IsPaused: false, MediaSourceId: current.source, PlayMethod: "DirectPlay" }, TranscodingInfo: null })]);
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items[0]?.libraryItemIds).toEqual(["film-1080"]);
    current.source = "src-4k";
    await monitor.refresh();
    await monitor.refresh();
    const rows = db.listPlaybackOccurrences().items;
    expect(rows.some((row) => row.libraryItemIds.includes("film-4k") && !row.libraryItemIds.includes("film-1080"))).toBe(true);
  });

  it("attaches a shared episode file to every local row for that path", async () => {
    const db = store();
    seedLibrary(db);
    const monitor = createPlaybackMonitor({
      store: db,
      decrypt: (value) => value,
      clock: () => 5_000,
      pollMs: 0,
      fetch: (async (url) => {
        if (String(url).endsWith("/Auth/Keys")) return json({ Items: [{ AccessToken: "server-key" }] });
        if (String(url).endsWith("/Sessions")) {
          return json([playing({
            NowPlayingItem: {
              Id: "ep-item",
              Name: "Show",
              Type: "Episode",
              MediaType: "Video",
              MediaSources: [{ Id: "src-ep", Path: "/mnt/nas/tv/show/S01E01-E02.mkv", Protocol: "File", IsRemote: false }],
            },
            PlayState: { IsPaused: false, MediaSourceId: "src-ep", PlayMethod: "DirectPlay" },
            TranscodingInfo: null,
          })]);
        }
        return json({ MediaSources: [{ Id: "src-ep", Path: "/mnt/nas/tv/show/S01E01-E02.mkv", Protocol: "File" }] });
      }) as typeof fetch,
    });
    monitors.push(monitor);
    db.savePlaybackSettings([{ ...db.defaultPlaybackConnectionSettings("jf"), observePlayback: true }]);
    monitor.start();
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items[0]?.libraryItemIds.sort()).toEqual(["ep-1", "ep-2"]);
  });

  it("leaves basename-only and title-only playback unmatched", async () => {
    const db = store();
    seedLibrary(db);
    const monitor = createPlaybackMonitor({
      store: db,
      decrypt: (value) => value,
      clock: () => 5_000,
      pollMs: 0,
      fetch: (async (url) => {
        if (String(url).endsWith("/Auth/Keys")) return json({ Items: [{ AccessToken: "server-key" }] });
        if (String(url).endsWith("/Sessions")) {
          return json([
            playing({
              Id: "sess-title",
              NowPlayingItem: { Id: "item-x", Name: "The Film", Type: "Movie", MediaType: "Video" },
              PlayState: { IsPaused: false, PlayMethod: "DirectPlay" },
              TranscodingInfo: null,
            }),
            playing({
              Id: "sess-base",
              NowPlayingItem: {
                Id: "item-base",
                Name: "The Film",
                Type: "Movie",
                MediaType: "Video",
                Path: "/downloads/film-1080.mkv",
                MediaSources: [{ Id: "src-base", Path: "/downloads/film-1080.mkv", Protocol: "File", IsRemote: false }],
              },
              PlayState: { IsPaused: false, MediaSourceId: "src-base", PlayMethod: "DirectPlay" },
              TranscodingInfo: null,
            }),
          ]);
        }
        return json({ MediaSources: [] });
      }) as typeof fetch,
    });
    monitors.push(monitor);
    db.savePlaybackSettings([{ ...db.defaultPlaybackConnectionSettings("jf"), observePlayback: true }]);
    monitor.start();
    await monitor.refresh();
    const rows = db.listPlaybackOccurrences().items;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.match === "unmatched" && row.libraryItemIds.length === 0)).toBe(true);
    expect(rows.some((row) => row.sessionId === "sess-base")).toBe(true);
    expect(db.errorPage(0, 50).items).toEqual([]);
  });

  it("groups repeated polls, opens a new occurrence after a gap, and does not treat failure as a stop", async () => {
    const db = store();
    seedLibrary(db);
    let payload: unknown = [playing()];
    let now = 1_000;
    const monitor = monitorFor(db, () => payload, { now: () => now });
    await monitor.refresh();
    now += 10_000;
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items).toHaveLength(1);
    expect(db.listPlaybackOccurrences().items[0]?.endedAt).toBeNull();
    payload = [];
    now += 10_000;
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items[0]?.endedAt).toBeNull();
    now += 10_000;
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items[0]?.endedAt).toBe(now);
    expect(db.listPlaybackOccurrences().items[0]?.gap).toBe(false);
    payload = [playing()];
    now += 10_000;
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items).toHaveLength(2);

    payload = [playing({ Id: "sess-fail" })];
    now += 10_000;
    await monitor.refresh();
    const beforeFail = db.listPlaybackOccurrences().items.find((row) => row.sessionId === "sess-fail");
    expect(beforeFail?.endedAt).toBeNull();
    payload = new Error("offline");
    now += 10_000;
    await monitor.refresh();
    const afterFail = db.getPlaybackOccurrence(beforeFail!.id);
    expect(afterFail?.gap).toBe(true);
    expect(afterFail?.endedAt).toBe(now);
  });

  it("shares one in-flight fetch across two refresh calls and a timer", async () => {
    const db = store();
    seedLibrary(db);
    let sessions = 0;
    const hold: Array<() => void> = [];
    const created = createPlaybackMonitor({
      store: db,
      decrypt: (value) => value,
      clock: () => 5_000,
      pollMs: 20,
      fetch: (async (url) => {
        if (String(url).endsWith("/Auth/Keys")) return json({ Items: [{ AccessToken: "server-key" }] });
        if (String(url).endsWith("/Sessions")) {
          sessions += 1;
          await new Promise<void>((resolve) => hold.push(resolve));
          return json([]);
        }
        return json({ MediaSources: [] });
      }) as typeof fetch,
    });
    monitors.push(created);
    db.savePlaybackSettings([{ ...db.defaultPlaybackConnectionSettings("jf"), observePlayback: true }]);
    created.start();
    const first = created.refresh();
    await waitUntil(() => hold.length === 1);
    const second = created.refresh();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sessions).toBe(1);
    expect(created.coverage().connections[0]?.status).toBe("unknown");
    hold[0]?.();
    await Promise.all([first, second]);
    expect(sessions).toBe(1);
  });

  it("starts unknown after restart even when the last snapshot was idle", async () => {
    const db = store();
    seedLibrary(db);
    const first = monitorFor(db, () => []);
    first.start();
    await first.refresh();
    expect(first.coverage().connections[0]?.status).toBe("idle");
    first.stop();
    const second = createPlaybackMonitor({
      store: db,
      decrypt: (value) => value,
      clock: () => 9_000,
      pollMs: 0,
      fetch: (async () => json([])) as typeof fetch,
    });
    monitors.push(second);
    second.start();
    expect(second.coverage().connections[0]?.status).toBe("unknown");
    expect(second.coverage().connections[0]?.stale).toBe(true);
  });

  it("keeps live coverage when history is disabled or cleared", async () => {
    const db = store();
    seedLibrary(db);
    const monitor = monitorFor(db, () => [playing()]);
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items).toHaveLength(1);
    db.clearPlaybackHistory();
    expect(db.listPlaybackOccurrences().items).toHaveLength(0);
    expect(monitor.coverage().connections[0]?.status).toBe("playing");
    db.savePlaybackSettings([{ ...db.defaultPlaybackConnectionSettings("jf"), observePlayback: true, retainHistory: false }]);
    await monitor.refresh();
    expect(db.listPlaybackOccurrences().items).toHaveLength(0);
    expect(monitor.coverage().connections[0]?.status).toBe("playing");
  });

  it("re-checks household access after the saved token changes", async () => {
    const db = store();
    seedLibrary(db);
    let secret = "user-token";
    const monitor = createPlaybackMonitor({
      store: db,
      decrypt: () => secret,
      clock: () => 5_000,
      pollMs: 0,
      fetch: (async (url) => {
        if (String(url).endsWith("/Auth/Keys")) {
          if (secret === "user-token") return json({}, 403);
          return json({ Items: [{ AccessToken: "server-key" }] });
        }
        if (String(url).endsWith("/Sessions")) return json([]);
        return json({ MediaSources: [] });
      }) as typeof fetch,
    });
    monitors.push(monitor);
    db.savePlaybackSettings([{ ...db.defaultPlaybackConnectionSettings("jf"), observePlayback: true }]);
    monitor.start();
    await monitor.refresh();
    expect(monitor.coverage().connections[0]).toMatchObject({
      credentialKind: "userToken",
      householdVisible: false,
      status: "unavailable",
    });
    secret = "server-key";
    await monitor.refresh();
    expect(monitor.coverage().connections[0]).toMatchObject({
      credentialKind: "apiKey",
      householdVisible: true,
      status: "idle",
    });
  });

  it("drops live coverage when a Jellyfin connection is forgotten", async () => {
    const db = store();
    seedLibrary(db);
    const monitor = monitorFor(db, () => []);
    await monitor.refresh();
    expect(monitor.coverage().connections.some((row) => row.connectionId === "jf")).toBe(true);
    db.deleteInstance("jf");
    monitor.forgetConnection("jf");
    expect(monitor.coverage().connections.some((row) => row.connectionId === "jf")).toBe(false);
  });

  it("does not poll Jellyfin when observation is off", async () => {
    const db = store();
    seedLibrary(db);
    let sessions = 0;
    const monitor = createPlaybackMonitor({
      store: db,
      decrypt: (value) => value,
      pollMs: 0,
      fetch: (async (url) => {
        if (String(url).endsWith("/Sessions")) sessions += 1;
        return json([]);
      }) as typeof fetch,
    });
    monitors.push(monitor);
    monitor.start();
    await monitor.refresh();
    expect(sessions).toBe(0);
    expect(monitor.coverage().connections[0]?.status).toBe("off");
  });
});

async function waitUntil(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
