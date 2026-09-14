import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import type { HardwareInfo } from "./types.ts";

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null };
const apps: Array<{ store: { close: () => void }; app: { jobs: { stop: () => void }; workerLoop?: { stop: () => void }; playbackMonitor?: { stop: () => Promise<void> } } }> = [];

afterEach(async () => {
  for (const a of apps) {
    a.app.jobs.stop();
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

async function playbackApp(fetchImpl: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "opt-play-http-"));
  const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
  const created = createApp({
    env,
    hardware: async () => hw,
    fetch: fetchImpl,
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

  it("explains audio conversion, opens an add-stereo draft, and leaves the queue empty", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [playing()] }));
    ctx.store.saveInspection("film-1080", surroundReport());
    await ctx.app.request("/api/playback/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ connections: [{ connectionId: ctx.jfId, observePlayback: true }] }),
    });
    const listed = await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as {
      items: Array<{ id: string; reasonFamily: string; recommendation: { kind: string; draft: unknown }; occurrenceCount: number }>;
      windowDays: number;
      total: number;
    };
    expect(listed.windowDays).toBe(7);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.reasonFamily).toBe("audio");
    expect(listed.items[0]?.recommendation.kind).toBe("add_stereo");
    expect(listed.items[0]?.occurrenceCount).toBe(1);
    const draft = await ctx.app.request(`/api/playback/diagnostics/${listed.items[0]!.id}/repair-draft`, {
      method: "POST",
      headers: ctx.headers,
    });
    expect(draft.status).toBe(200);
    const body = await draft.json() as {
      queued: boolean;
      itemId: string;
      kind: string;
      draft: { audio?: Array<{ action: string; channels?: number }> };
    };
    expect(body.queued).toBe(false);
    expect(body.itemId).toBe("film-1080");
    expect(body.kind).toBe("add_stereo");
    expect(body.draft.audio).toEqual([{ index: 1, action: "add_downmix", channels: 2 }]);
    const jobs = await (await ctx.app.request("/api/jobs", { headers: ctx.headers })).json() as { items: unknown[] };
    expect(jobs.items).toEqual([]);
    await ctx.playbackMonitor.refresh();
    const again = await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as { items: Array<{ occurrenceCount: number }> };
    expect(again.items[0]?.occurrenceCount).toBe(1);
  });

  it("filters diagnostics and observations together and caps pages at 100", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    const revision = { canonicalPath: "/mnt/nas/movies/film-1080.mkv", sizeBytes: 1, mtimeMs: 1, fileId: "1:1" };
    for (let i = 0; i < 3; i += 1) {
      ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
        id: `a-${i}`,
        sessionId: `a-${i}`,
        deviceId: "living-room",
        deviceLabel: "Living Room TV",
        lastSeenAt: Date.now(),
        revision,
      }));
    }
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "bed",
      sessionId: "bed",
      deviceId: "bedroom",
      deviceLabel: "Bedroom TV",
      lastSeenAt: Date.now(),
      revision,
    }));
    const filtered = await (await ctx.app.request("/api/playback/diagnostics?client=Living&reasonFamily=audio&title=Film", { headers: ctx.headers })).json() as {
      items: Array<{ deviceId: string; occurrenceCount: number }>;
    };
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.deviceId).toBe("living-room");
    expect(filtered.items[0]?.occurrenceCount).toBe(3);
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "mixed",
      sessionId: "mixed",
      deviceId: "den",
      deviceLabel: "Den TV",
      reasonFamily: "mixed",
      rawReasons: ["AudioCodecNotSupported", "ContainerBitrateExceedsLimit"],
      lastSeenAt: Date.now(),
      revision,
    }));
    const mixedUnderAudio = await (await ctx.app.request("/api/playback/diagnostics?reasonFamily=audio", { headers: ctx.headers })).json() as {
      items: Array<{ deviceId: string; reasonFamily: string }>;
    };
    expect(mixedUnderAudio.items.some((row) => row.deviceId === "den" && row.reasonFamily === "mixed")).toBe(true);
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "direct",
      sessionId: "direct",
      playMethod: "DirectPlay",
      reasonFamily: null,
      rawReasons: [],
      lastSeenAt: Date.now(),
      revision,
    }));
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "unknown",
      sessionId: "unknown",
      playMethod: "Transcode",
      reasonFamily: "unknown",
      rawReasons: ["FutureReasonX"],
      lastSeenAt: Date.now(),
      revision,
    }));
    const unknownObs = await (await ctx.app.request("/api/playback/observations?reasonFamily=unknown", { headers: ctx.headers })).json() as {
      items: Array<{ id: string; playMethod: string | null }>;
    };
    expect(unknownObs.items.some((row) => row.id === "unknown")).toBe(true);
    expect(unknownObs.items.some((row) => row.playMethod === "DirectPlay" || row.id === "direct")).toBe(false);
    const bad = await ctx.app.request("/api/playback/diagnostics?days=14", { headers: ctx.headers });
    expect(bad.status).toBe(400);
    const page = await ctx.app.request("/api/playback/observations?limit=100", { headers: ctx.headers });
    expect(page.status).toBe(200);
    const over = await (await ctx.app.request("/api/playback/observations?limit=500", { headers: ctx.headers })).json() as { items: unknown[] };
    expect(over.items.length).toBeLessThanOrEqual(100);
  });

  it("dismisses a recommendation until the file revision changes", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    const revision = { canonicalPath: "/mnt/nas/movies/film-1080.mkv", sizeBytes: 1, mtimeMs: 1, fileId: "1:1" };
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, { id: "one", sessionId: "one", revision }));
    const listed = await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as { items: Array<{ id: string }> };
    expect(listed.items).toHaveLength(1);
    const dismissed = await ctx.app.request(`/api/playback/diagnostics/${listed.items[0]!.id}/dismiss`, {
      method: "POST",
      headers: ctx.headers,
    });
    expect(dismissed.status).toBe(200);
    expect((await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as { items: unknown[] }).items).toEqual([]);
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "two",
      sessionId: "two",
      revision: { ...revision, sizeBytes: 2, fileId: "1:2" },
    }));
    const after = await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as { items: Array<{ id: string }> };
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.id).not.toBe(listed.items[0]?.id);
  });

  it("guides an existing stereo track instead of drafting a duplicate", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    ctx.store.saveInspection("film-1080", {
      ...surroundReport(),
      audio: [
        { index: 1, language: "eng", channels: 8, codec: "truehd", title: "Atmos", untagged: false, commentary: false },
        { index: 2, language: "eng", channels: 2, codec: "aac", title: "Stereo", untagged: false, commentary: false },
      ],
    });
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, { id: "stereo", sessionId: "stereo" }));
    const listed = await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as {
      items: Array<{ recommendation: { kind: string; draft: unknown; canRepair: boolean } }>;
    };
    expect(listed.items[0]?.recommendation.kind).toBe("try_existing_stereo");
    expect(listed.items[0]?.recommendation.canRepair).toBe(false);
    expect(listed.items[0]?.recommendation.draft).toBeNull();
    const jobs = await (await ctx.app.request("/api/jobs", { headers: ctx.headers })).json() as { items: unknown[] };
    expect(jobs.items).toEqual([]);
  });

  it("does not auto-choose HEVC for video conversion and never removes subtitles", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    ctx.store.saveInspection("film-1080", surroundReport());
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "vid",
      sessionId: "vid",
      reasonFamily: "video",
      rawReasons: ["VideoCodecNotSupported"],
      reasons: ["Jellyfin converted the video on Living Room TV."],
    }));
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "sub",
      sessionId: "sub",
      deviceId: "bedroom",
      deviceLabel: "Bedroom TV",
      reasonFamily: "subtitle",
      rawReasons: ["SubtitleCodecNotSupported"],
      selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: 2 },
    }));
    const listed = await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as {
      items: Array<{ reasonFamily: string; recommendation: { kind: string; draft: { video?: { mode: string }; subtitles?: unknown[] } } }>;
    };
    const video = listed.items.find((row) => row.reasonFamily === "video");
    const subtitle = listed.items.find((row) => row.reasonFamily === "subtitle");
    expect(video?.recommendation.kind).toBe("video_constraint");
    expect(video?.recommendation.draft).toBeNull();
    expect(subtitle?.recommendation.kind).toBe("subtitle_guidance");
    expect(subtitle?.recommendation.draft).toBeNull();
  });

  it("shows Direct Play after Keep on the title page and Not yet observed without a later play", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "before",
      sessionId: "before",
      lastSeenAt: 1_000,
      endedAt: 1_000,
    }));
    ctx.store.addHistory("film-1080", "kept", 0, 2_000);
    const pending = await (await ctx.app.request("/api/library/items/film-1080", { headers: ctx.headers })).json() as {
      playback: { afterKeep: { sentence: string | null }; observations: unknown[] };
    };
    expect(pending.playback.afterKeep.sentence).toBe("Not yet observed.");
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "after",
      sessionId: "after",
      playMethod: "DirectPlay",
      reasonFamily: null,
      rawReasons: [],
      lastSeenAt: 3_000,
    }));
    const observed = await (await ctx.app.request("/api/library/items/film-1080", { headers: ctx.headers })).json() as {
      playback: { afterKeep: { sentence: string | null } };
    };
    expect(observed.playback.afterKeep.sentence).toBe("Direct playback observed on this device after Keep.");
  });

  it("omits after-Keep copy on a kept title that never had a conversion problem", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    ctx.store.addHistory("film-1080", "kept", 0, Date.now() - 1_000);
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, {
      id: "direct",
      sessionId: "direct",
      playMethod: "DirectPlay",
      reasonFamily: null,
      rawReasons: [],
    }));
    const body = await (await ctx.app.request("/api/library/items/film-1080", { headers: ctx.headers })).json() as {
      playback: { afterKeep: { sentence: string | null } };
    };
    expect(body.playback.afterKeep.sentence).toBeNull();
  });

  it("rejects queueing a stale playback draft and leaves the queue empty", async () => {
    const ctx = await playbackApp(jellyfinFetch({ sessions: () => [] }));
    ctx.store.saveInspection("film-1080", surroundReport());
    const revision = { canonicalPath: "/mnt/nas/movies/film-1080.mkv", sizeBytes: 8, mtimeMs: 8, fileId: "8:8" };
    ctx.store.savePlaybackOccurrence(seedOccurrence(ctx.jfId, { id: "stale-q", sessionId: "stale-q", revision }));
    const listed = await (await ctx.app.request("/api/playback/diagnostics", { headers: ctx.headers })).json() as {
      items: Array<{ id: string; recommendation: { draft: unknown } }>;
    };
    expect(listed.items[0]?.id).toBeTruthy();
    const reviewPath = join(ctx.store.db.name, "..", "review");
    mkdirSync(reviewPath, { recursive: true });
    await ctx.app.request("/api/settings", {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath }),
    });
    const queued = await ctx.app.request("/api/library/items/film-1080/queue", {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({
        draft: listed.items[0]?.recommendation.draft ?? { video: { mode: "copy" }, audio: [{ index: 1, action: "add_downmix", channels: 2 }] },
        playbackDiagnosticId: listed.items[0]!.id,
      }),
    });
    expect(queued.status).toBe(409);
    const jobs = await (await ctx.app.request("/api/jobs", { headers: ctx.headers })).json() as { items: unknown[] };
    expect(jobs.items).toEqual([]);
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

function surroundReport() {
  return {
    sourceSig: "/mnt/nas/movies/film-1080.mkv|1",
    sourceMethod: "ffprobe" as const,
    listingState: "complete" as const,
    durationSec: 3600,
    sizeBytes: 8_000_000_000,
    sizePerHourGb: 8,
    videoCodec: "hevc",
    width: 1920,
    height: 1080,
    bitDepth: 10,
    hdr: "none" as const,
    audio: [{ index: 1, language: "eng", channels: 8, codec: "truehd", title: "Atmos", untagged: false, commentary: false }],
    subtitles: [{ index: 2, language: "eng", codec: "pgs", title: "", untagged: false, forced: false, sdh: false }],
    hasChapters: false,
    hasAttachments: false,
  };
}

function seedOccurrence(connectionId: string, over: Record<string, unknown>) {
  return {
    id: "occ",
    connectionId,
    deviceId: "living-room",
    deviceLabel: "Living Room TV",
    sessionId: "sess",
    itemId: "item-1",
    mediaSourceId: "src-1080",
    itemName: "The Film",
    playMethod: "Transcode",
    mediaType: "Video",
    isPaused: false,
    reasons: ["Jellyfin converted the audio on Living Room TV."],
    rawReasons: ["AudioCodecNotSupported"],
    reasonFamily: "audio",
    selectedTracks: { audioStreamIndex: 1, subtitleStreamIndex: null },
    match: "matched" as const,
    libraryItemIds: ["film-1080"],
    path: "/mnt/nas/movies/film-1080.mkv",
    revision: {
      canonicalPath: "/mnt/nas/movies/film-1080.mkv",
      sizeBytes: 1,
      mtimeMs: 1,
      fileId: "1:1",
    },
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    endedAt: null,
    gap: false,
    ...over,
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
