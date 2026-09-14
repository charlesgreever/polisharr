import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { PLAYBACK_WAIT_FINISH, PLAYBACK_WAIT_STATUS } from "./playback-policy.ts";
import type { HardwareInfo } from "./types.ts";

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null };
const apps: Array<{ store: { close: () => void }; app: { jobs: { stop: () => void }; previews?: { stop: () => void }; workerLoop?: { stop: () => void }; playbackMonitor?: { stop: () => Promise<void> } } }> = [];

afterEach(async () => {
  for (const a of apps) {
    a.app.jobs.stop();
    a.app.previews?.stop();
    a.app.workerLoop?.stop();
    await a.app.playbackMonitor?.stop();
    a.store.close();
  }
  apps.length = 0;
});

function playing(sourceId = "src-1080") {
  return {
    Id: "sess-1",
    DeviceId: "living-room",
    DeviceName: "Living Room TV",
    IsActive: false,
    UserName: "ada",
    RemoteEndPoint: "10.0.0.5",
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
    PlayState: { IsPaused: false, MediaSourceId: sourceId, PlayMethod: "Transcode", AudioStreamIndex: 1 },
    TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: false, TranscodeReasons: ["AudioCodecNotSupported"] },
  };
}

async function playbackApp(fetchImpl: typeof fetch, extras: { clock?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opt-play-http-"));
  const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
  const created = createApp({
    env,
    hardware: async () => hw,
    fetch: fetchImpl,
    clock: extras.clock,
    playbackPollMs: 0,
    playbackTimeoutMs: 50,
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
    body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr", apiKey: "arr", enabled: true }),
  });
  await created.app.request("/api/integrations", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", token: "server-key", enabled: true }),
  });
  const jf = created.store.listInstances().find((row) => row.kind === "jellyfin")!;
  created.store.upsertItem({
    id: "film-1080",
    instanceId: created.store.listInstances().find((row) => row.kind === "radarr")!.id,
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
    sizeBytes: 1,
    quality: "Bluray-1080p",
    resolution: "1080",
    profile: "HD",
    tags: [],
    posterRemoteUrl: null,
    sizeExempt: false,
    tmdbId: 42,
  });
  created.store.upsertItem({
    id: "film-4k",
    instanceId: created.store.listInstances().find((row) => row.kind === "radarr")!.id,
    arrId: 2,
    arrSeriesId: null,
    arrEpisodeFileId: null,
    type: "movie",
    title: "The Film",
    showTitle: null,
    season: null,
    episode: null,
    episodeTitle: null,
    path: "/mnt/nas/movies/film-4k.mkv",
    sizeBytes: 2,
    quality: "Bluray-2160p",
    resolution: "2160",
    profile: "HD",
    tags: [],
    posterRemoteUrl: null,
    sizeExempt: false,
    tmdbId: 42,
  });
  return { ...created, headers, jfId: jf.id };
}

function jellyfinFetch(opts: { token?: string; sessions?: () => unknown; hold?: Array<() => void> } = {}): typeof fetch {
  const token = opts.token ?? "server-key";
  return (async (url) => {
    const text = String(url);
    if (text.endsWith("/System/Info")) return new Response(JSON.stringify({ ServerName: "JF" }), { status: 200 });
    if (text.endsWith("/Auth/Keys")) {
      if (token === "user-token") return new Response("{}", { status: 403 });
      return new Response(JSON.stringify({ Items: [{ AccessToken: "server-key", AppName: "Polisharr" }] }), { status: 200 });
    }
    if (text.endsWith("/Sessions")) {
      if (opts.hold) {
        await new Promise<void>((resolve) => opts.hold!.push(resolve));
      }
      const payload = opts.sessions ? opts.sessions() : [playing()];
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (text.includes("/PlaybackInfo")) {
      return new Response(JSON.stringify({
        MediaSources: [
          { Id: "src-1080", Path: "/mnt/nas/movies/film-1080.mkv", Protocol: "File", IsRemote: false },
          { Id: "src-4k", Path: "/mnt/nas/movies/film-4k.mkv", Protocol: "File", IsRemote: false },
        ],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("playback HTTP", () => {
  it("requires an admin session and leaves observation off by default", async () => {
    const ctx = await playbackApp(jellyfinFetch());
    expect((await ctx.app.request("/api/playback/settings")).status).toBe(401);
    const listed = await ctx.app.request("/api/playback/settings", { headers: ctx.headers });
    const body = await listed.json() as { connections: Array<{ observePlayback: boolean; health: { status: string } }> };
    expect(body.connections[0]?.observePlayback).toBe(false);
    expect(body.connections[0]?.health.status).toBe("off");
    const radarrId = ctx.store.listInstances().find((row) => row.kind === "radarr")?.id;
    const enabled = await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true }] }),
    });
    const saved = await enabled.json() as { connections: Array<{ observePlayback: boolean; coveredArrInstanceIds: string[]; protectNodes: boolean }> };
    expect(saved.connections[0]?.observePlayback).toBe(true);
    expect(saved.connections[0]?.protectNodes).toBe(false);
    expect(saved.connections[0]?.coveredArrInstanceIds).toEqual([radarrId]);
  });

  it("reports a server API key as household-capable and a user token as missing access", async () => {
    const keyApp = await playbackApp(jellyfinFetch({ token: "server-key", sessions: () => [] }));
    const keyTest = await keyApp.app.request(`/api/playback/connections/${keyApp.jfId}/test`, {
      method: "POST",
      headers: keyApp.headers,
    });
    expect(keyTest.status).toBe(200);
    expect(await keyTest.json()).toMatchObject({
      ok: true,
      playback: { credentialKind: "apiKey", householdVisible: true },
    });

    const userApp = await playbackApp(jellyfinFetch({ token: "user-token", sessions: () => [playing(), { ...playing(), Id: "two" }] }));
    await userApp.app.request("/api/integrations", {
      method: "POST",
      headers: userApp.headers,
      body: JSON.stringify({ id: userApp.jfId, kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", token: "user-token", enabled: true }),
    });
    const userTest = await userApp.app.request(`/api/playback/connections/${userApp.jfId}/test`, {
      method: "POST",
      headers: userApp.headers,
    });
    expect(userTest.status).toBe(400);
    const userBody = await userTest.json() as { playback: { credentialKind: string; householdVisible: boolean; kind: string } };
    expect(userBody.playback).toMatchObject({ credentialKind: "userToken", householdVisible: false, kind: "access" });
  });

  it("observes a conversion once, matches the physical file, and keeps unmatched rows off Errors", async () => {
    let source = "src-1080";
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [playing(source)] }));
    const enabled = await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true }] }),
    });
    expect(enabled.status).toBe(200);
    const first = await (await ctx.app.request("/api/playback/observations", { headers: ctx.headers })).json() as {
      items: Array<{ libraryItemIds: string[]; match: string; summary: string; stale: boolean }>;
    };
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.libraryItemIds).toEqual(["film-1080"]);
    expect(first.items[0]?.summary).toContain("converted the audio");
    expect(JSON.stringify(first)).not.toContain("ada");
    expect(JSON.stringify(first)).not.toContain("10.0.0.5");
    await ctx.playbackMonitor.refresh();
    source = "src-4k";
    const switched = await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true }] }),
    });
    expect(switched.status).toBe(200);
    const second = await (await ctx.app.request("/api/playback/observations", { headers: ctx.headers })).json() as {
      items: Array<{ libraryItemIds: string[] }>;
    };
    expect(second.items.some((row) => row.libraryItemIds.includes("film-4k"))).toBe(true);
    const errors = await (await ctx.app.request("/api/errors", { headers: ctx.headers })).json() as { items: unknown[] };
    expect(errors.items).toEqual([]);
  });

  it("returns cached observations while a refresh is in flight", async () => {
    const hold: Array<() => void> = [];
    const ctx = await playbackApp(jellyfinFetch({ hold, sessions: () => [] }));
    const put = ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true }] }),
    });
    await waitUntil(() => hold.length === 1);
    const cached = await ctx.app.request("/api/playback/observations", { headers: ctx.headers });
    expect(cached.status).toBe(200);
    const body = await cached.json() as { items: unknown[]; connections: Array<{ status: string }> };
    expect(body.items).toEqual([]);
    expect(body.connections[0]?.status).toBe("unknown");
    hold[0]?.();
    expect((await put).status).toBe(200);
  });

  it("clears history without disabling live coverage", async () => {
    const ctx = await playbackApp(jellyfinFetch());
    await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true, retainHistory: false }] }),
    });
    const listed = await (await ctx.app.request("/api/playback/observations", { headers: ctx.headers })).json() as {
      items: unknown[];
      connections: Array<{ status: string }>;
    };
    expect(listed.items).toEqual([]);
    expect(listed.connections[0]?.status).toBe("playing");
    await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true, retainHistory: true }] }),
    });
    const cleared = await ctx.app.request("/api/playback/history", { method: "DELETE", headers: ctx.headers });
    const clearedBody = await cleared.json() as { coverage: { connections: Array<{ status: string }> } };
    expect(clearedBody.coverage.connections[0]?.status).toBe("playing");
  });

  it("forgets playback coverage when the Jellyfin connection is removed", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true }] }),
    });
    expect((await (await ctx.app.request("/api/playback/settings", { headers: ctx.headers })).json() as {
      connections: Array<{ connectionId: string }>;
    }).connections.map((row) => row.connectionId)).toEqual([ctx.jfId]);
    const removed = await ctx.app.request(`/api/integrations/${ctx.jfId}`, { method: "DELETE", headers: ctx.headers });
    expect(removed.status).toBe(200);
    const settings = await (await ctx.app.request("/api/playback/settings", { headers: ctx.headers })).json() as {
      connections: Array<{ connectionId: string }>;
    };
    const observations = await (await ctx.app.request("/api/playback/observations", { headers: ctx.headers })).json() as {
      connections: Array<{ connectionId: string }>;
    };
    expect(settings.connections).toEqual([]);
    expect(observations.connections).toEqual([]);
  });

  it("saves node and library coverage for playback protection", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    const nodeId = ctx.store.localNodeId();
    const radarrId = ctx.store.listInstances().find((row) => row.kind === "radarr")!.id;
    const saved = await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({
        connections: [{
          connectionId: ctx.jfId,
          protectNodes: true,
          protectedNodeIds: [nodeId],
          protectReplacement: true,
          coveredArrInstanceIds: [radarrId],
        }],
      }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json() as {
      connections: Array<{ protectNodes: boolean; protectedNodeIds: string[]; protectReplacement: boolean; coveredArrInstanceIds: string[] }>;
    };
    expect(body.connections[0]).toMatchObject({
      protectNodes: true,
      protectedNodeIds: [nodeId],
      protectReplacement: true,
      coveredArrInstanceIds: [radarrId],
    });
  });

  it("holds a queued job during playback and does not call Jellyfin for status reads", async () => {
    let sessions = 0;
    const ctx = await playbackApp(((url, init) => {
      if (String(url).endsWith("/Sessions")) sessions += 1;
      return jellyfinFetch({ sessions: () => [playing()] })(url, init);
    }) as typeof fetch);
    const nodeId = ctx.store.localNodeId();
    await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({
        connections: [{ connectionId: ctx.jfId, protectNodes: true, protectedNodeIds: [nodeId] }],
      }),
    });
    const plan = {
      origin: "custom" as const, video: { kind: "copy" as const }, audio: [], subtitles: [], container: "mkv" as const,
      writeMode: "sidecar" as const, warning: null, reasons: ["Copy"], estimatedOutputBytes: 1, category: "movie1080p" as const,
    };
    ctx.store.insertJob({
      id: "job-1", itemId: "film-1080", suggestionId: null, status: "queued", phase: "queued", progress: 0,
      error: null, warning: null, runNow: true, createdAt: 1, writeMode: "sidecar", plan, assignedNodeId: nodeId,
    });
    const before = sessions;
    const listed = await ctx.app.request("/api/jobs", { headers: ctx.headers });
    const settings = await ctx.app.request("/api/playback/settings", { headers: ctx.headers });
    expect(listed.status).toBe(200);
    expect(settings.status).toBe(200);
    expect(sessions).toBe(before);
    const body = await listed.json() as {
      items: Array<{ id: string; status: string; playbackHold?: { sentence: string | null; detail: string | null }; waitingReason?: string | null }>;
    };
    const job = body.items.find((row) => row.id === "job-1");
    expect(job?.status).toBe("queued");
    expect(job?.waitingReason).toBe("playback");
    expect(job?.playbackHold?.sentence).toBe(PLAYBACK_WAIT_FINISH);
    expect(job?.playbackHold?.detail).toBe("Jellyfin");
    expect(ctx.store.getJob("job-1")?.status).toBe("queued");
  });

  it("holds mapped nodes when the Jellyfin login cannot see the household", async () => {
    let now = 1_000;
    let sessions = 0;
    const ctx = await playbackApp(((url, init) => {
      if (String(url).endsWith("/Sessions")) sessions += 1;
      return jellyfinFetch({ token: "user-token", sessions: () => [] })(url, init);
    }) as typeof fetch, { clock: () => now });
    await ctx.app.request("/api/integrations", {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({
        id: ctx.jfId,
        kind: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin:8096",
        token: "user-token",
        enabled: true,
      }),
    });
    const nodeId = ctx.store.localNodeId();
    const saved = await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({
        connections: [{ connectionId: ctx.jfId, protectNodes: true, protectedNodeIds: [nodeId] }],
      }),
    });
    expect(saved.status).toBe(200);
    const settings = await saved.json() as {
      connections: Array<{ health: { status: string; lastError: string | null } }>;
    };
    expect(settings.connections[0]?.health.status).toBe("unavailable");
    expect(settings.connections[0]?.health.lastError).toMatch(/server API key/);
    const plan = {
      origin: "custom" as const, video: { kind: "copy" as const }, audio: [], subtitles: [], container: "mkv" as const,
      writeMode: "sidecar" as const, warning: null, reasons: ["Copy"], estimatedOutputBytes: 1, category: "movie1080p" as const,
    };
    ctx.store.insertJob({
      id: "job-user", itemId: "film-1080", suggestionId: null, status: "queued", phase: "queued", progress: 0,
      error: null, warning: null, runNow: true, createdAt: 1, writeMode: "sidecar", plan, assignedNodeId: nodeId,
    });
    const before = sessions;
    now = 40_000;
    const listed = await ctx.app.request("/api/jobs", { headers: ctx.headers });
    const reread = await ctx.app.request("/api/playback/settings", { headers: ctx.headers });
    expect(listed.status).toBe(200);
    expect(reread.status).toBe(200);
    expect(sessions).toBe(before);
    const body = await listed.json() as {
      items: Array<{ id: string; status: string; playbackHold?: { sentence: string | null }; waitingReason?: string | null }>;
    };
    const job = body.items.find((row) => row.id === "job-user");
    expect(job?.status).toBe("queued");
    expect(job?.waitingReason).toBe("playback-status");
    expect(job?.playbackHold?.sentence).toBe(PLAYBACK_WAIT_STATUS);
    expect(ctx.store.getJob("job-user")?.status).toBe("queued");
  });

  it("holds mapped work when the monitor is stale and shows the last check time", async () => {
    let now = 1_000;
    const dir = mkdtempSync(join(tmpdir(), "opt-play-stale-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => hw,
      fetch: jellyfinFetch({ sessions: () => [] }),
      clock: () => now,
      playbackPollMs: 0,
      playbackTimeoutMs: 50,
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
      body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr", apiKey: "arr", enabled: true }),
    });
    await created.app.request("/api/integrations", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", token: "server-key", enabled: true }),
    });
    const jfId = created.store.listInstances().find((row) => row.kind === "jellyfin")!.id;
    const nodeId = created.store.localNodeId();
    await created.app.request("/api/playback/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        connections: [{ connectionId: jfId, protectNodes: true, protectedNodeIds: [nodeId] }],
      }),
    });
    now = 40_000;
    const listed = await created.app.request("/api/nodes", { headers });
    const nodes = await listed.json() as { nodes: Array<{ id: string; playbackHold?: { sentence: string | null; observedAt: number | null } | null }> };
    const node = nodes.nodes.find((row) => row.id === nodeId);
    expect(node?.playbackHold?.sentence).toBe(PLAYBACK_WAIT_STATUS);
    expect(node?.playbackHold?.observedAt).toBe(1_000);
  });

  it("blocks playback routes on a worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-play-worker-"));
    const env = loadEnv({
      CONFIG_DIR: dir,
      PORT: "7373",
      POLISHARR_ROLE: "worker",
      POLISHARR_NODE_NAME: "5090",
      POLISHARR_MASTER_URL: "http://192.168.1.10:7373",
      POLISHARR_CLUSTER_TOKEN: "cluster-secret",
    });
    const created = createApp({ env, hardware: async () => hw, fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch });
    apps.push({ store: created.store, app: created });
    const res = await created.app.request("/api/playback/settings");
    expect(res.status).toBe(409);
  });
});

async function waitUntil(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
