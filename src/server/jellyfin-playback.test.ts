import { describe, expect, it } from "vitest";
import {
  createJellyfinPlayback,
  describePlaybackObservation,
  parseTranscodeReasons,
  sessionHasCurrentItem,
  transcodeReasonFamily,
  verifiedSessionPath,
} from "./jellyfin-playback.ts";

function playback(fetchImpl: typeof fetch, clock = () => 1_000) {
  return createJellyfinPlayback({ fetch: fetchImpl, clock, timeoutMs: 50, sourceCacheMs: 60_000, sourceConcurrency: 2 });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: "sess-1",
    DeviceId: "living-room",
    DeviceName: "Living Room TV",
    IsActive: false,
    UserName: "ada",
    RemoteEndPoint: "192.168.1.20",
    NowPlayingItem: {
      Id: "item-1",
      Name: "The Film",
      Type: "Movie",
      MediaType: "Video",
      Path: "/mnt/nas/movies/film-1080.mkv",
      MediaSources: [
        { Id: "src-1080", Path: "/mnt/nas/movies/film-1080.mkv", Protocol: "File", IsRemote: false },
        { Id: "src-4k", Path: "/mnt/nas/movies/film-4k.mkv", Protocol: "File", IsRemote: false },
      ],
      MediaStreams: [
        { Index: 0, Type: "Video", Codec: "hevc" },
        { Index: 1, Type: "Audio", Codec: "truehd", Channels: 8, Language: "eng" },
      ],
    },
    PlayState: {
      IsPaused: false,
      MediaSourceId: "src-1080",
      PlayMethod: "DirectPlay",
      AudioStreamIndex: 1,
      SubtitleStreamIndex: null,
    },
    TranscodingInfo: null,
    ...over,
  };
}

describe("Jellyfin session snapshot", () => {
  it("parses Direct Play, audio conversion, video conversion, paused video, missing state, unknown reasons, and an empty list", async () => {
    const fixtures = [
      session(),
      session({
        Id: "sess-audio",
        PlayState: { IsPaused: false, MediaSourceId: "src-1080", PlayMethod: "Transcode", AudioStreamIndex: 1 },
        TranscodingInfo: {
          IsVideoDirect: true,
          IsAudioDirect: false,
          AudioCodec: "aac",
          VideoCodec: "hevc",
          TranscodeReasons: ["AudioCodecNotSupported", "AudioChannelsNotSupported"],
        },
      }),
      session({
        Id: "sess-video",
        PlayState: { IsPaused: false, MediaSourceId: "src-1080", PlayMethod: "Transcode" },
        TranscodingInfo: {
          IsVideoDirect: false,
          IsAudioDirect: true,
          TranscodeReasons: ["VideoCodecNotSupported"],
        },
      }),
      session({
        Id: "sess-paused",
        PlayState: { IsPaused: true, MediaSourceId: "src-1080", PlayMethod: "DirectPlay" },
      }),
      session({
        Id: "sess-missing",
        PlayState: null,
        TranscodingInfo: null,
        NowPlayingItem: { Id: "item-1", Name: "The Film", MediaType: "Video" },
      }),
      session({
        Id: "sess-unknown",
        PlayState: { IsPaused: false, MediaSourceId: "src-1080", PlayMethod: "Warp" },
        TranscodingInfo: { TranscodeReasons: ["FutureReasonX"] },
      }),
    ];
    const client = playback(async (url) => {
      if (String(url).endsWith("/Sessions")) return json(fixtures);
      return json({}, 404);
    });
    const snapshot = await client.fetchSnapshot({ url: "http://jellyfin:8096", token: "k", connectionId: "jf" });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.sessions).toHaveLength(6);
    expect(snapshot.sessions.every((row) => sessionHasCurrentItem(row))).toBe(true);
    expect(snapshot.sessions[0]?.playState?.playMethod).toBe("DirectPlay");
    expect(verifiedSessionPath(snapshot.sessions[0]!)).toBe("/mnt/nas/movies/film-1080.mkv");
    expect(snapshot.sessions[1]?.transcoding?.transcodeReasons).toEqual(["AudioCodecNotSupported", "AudioChannelsNotSupported"]);
    expect(transcodeReasonFamily(snapshot.sessions[1]!.transcoding!.transcodeReasons)).toBe("audio");
    expect(transcodeReasonFamily(snapshot.sessions[2]!.transcoding!.transcodeReasons)).toBe("video");
    expect(snapshot.sessions[3]?.playState?.isPaused).toBe(true);
    expect(snapshot.sessions[4]?.playState).toBeNull();
    expect(snapshot.sessions[5]?.playState?.playMethod).toBe("Warp");
    expect(snapshot.sessions[5]?.transcoding?.transcodeReasons).toEqual(["FutureReasonX"]);
    expect(transcodeReasonFamily(["FutureReasonX"])).toBe("unknown");

    const empty = playback(async () => json([]));
    const idle = await empty.fetchSnapshot({ url: "http://jellyfin:8096", token: "k", connectionId: "jf" });
    expect(idle).toMatchObject({ complete: true, sessions: [], error: null });
  });

  it("does not treat IsActive or LastActivityDate as playback, and keeps usernames out of the parsed snapshot", async () => {
    const client = playback(async () => json([
      session({ IsActive: false, LastActivityDate: "2020-01-01T00:00:00Z" }),
      {
        Id: "idle-session",
        DeviceId: "phone",
        DeviceName: "Phone",
        IsActive: true,
        LastActivityDate: new Date().toISOString(),
        NowPlayingItem: null,
        PlayState: null,
      },
    ]));
    const snapshot = await client.fetchSnapshot({ url: "http://jellyfin:8096", token: "k", connectionId: "jf" });
    expect(sessionHasCurrentItem(snapshot.sessions[0]!)).toBe(true);
    expect(sessionHasCurrentItem(snapshot.sessions[1]!)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("ada");
    expect(JSON.stringify(snapshot)).not.toContain("192.168.1.20");
  });

  it("marks a snapshot incomplete when the body exceeds 2 MiB or 1,000 sessions", async () => {
    const oversized = playback(async () => new Response("x".repeat(2 * 1024 * 1024 + 8), {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 8) },
    }));
    const big = await oversized.fetchSnapshot({ url: "http://jellyfin:8096", token: "k", connectionId: "jf" });
    expect(big.complete).toBe(false);
    expect(big.truncated).toBe(true);

    const many = Array.from({ length: 1001 }, (_, i) => session({ Id: `sess-${i}` }));
    const capped = playback(async () => json(many));
    const snapshot = await capped.fetchSnapshot({ url: "http://jellyfin:8096", token: "k", connectionId: "jf" });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.sessions).toHaveLength(1000);
  });

  it("never POSTs PlaybackInfo or opens a live stream, matches a source id exactly, and caches for 60 seconds", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let now = 1_000;
    let playbackInfo = 0;
    const client = createJellyfinPlayback({
      fetch: (async (url, init) => {
        calls.push({ url: String(url), method: String(init?.method ?? "GET") });
        if (String(url).includes("/PlaybackInfo")) {
          playbackInfo += 1;
          return json({
            MediaSources: [
              { Id: "src-1080", Path: "/mnt/nas/movies/film-1080.mkv", Protocol: "File", IsRemote: false },
              { Id: "src-4k", Path: "/mnt/nas/movies/film-4k.mkv", Protocol: "File", IsRemote: false },
              { Id: "http", Path: "https://cdn.example/film.mkv", Protocol: "Http", IsRemote: true },
            ],
          });
        }
        return json({}, 404);
      }) as typeof fetch,
      clock: () => now,
      sourceCacheMs: 60_000,
    });
    const first = await client.resolveMediaSource({
      url: "http://jellyfin:8096",
      token: "k",
      connectionId: "jf",
      itemId: "item-1",
      mediaSourceId: "src-1080",
    });
    const cached = await client.resolveMediaSource({
      url: "http://jellyfin:8096",
      token: "k",
      connectionId: "jf",
      itemId: "item-1",
      mediaSourceId: "src-1080",
    });
    expect(first).toMatchObject({ outcome: "ok", path: "/mnt/nas/movies/film-1080.mkv", localFile: true });
    expect(cached.path).toBe(first.path);
    expect(playbackInfo).toBe(1);
    const fourK = await client.resolveMediaSource({
      url: "http://jellyfin:8096",
      token: "k",
      connectionId: "jf",
      itemId: "item-1",
      mediaSourceId: "src-4k",
    });
    expect(fourK.path).toBe("/mnt/nas/movies/film-4k.mkv");
    const remote = await client.resolveMediaSource({
      url: "http://jellyfin:8096",
      token: "k",
      connectionId: "jf",
      itemId: "item-1",
      mediaSourceId: "http",
    });
    expect(remote.outcome).toBe("remote");
    const missing = await client.resolveMediaSource({
      url: "http://jellyfin:8096",
      token: "k",
      connectionId: "jf",
      itemId: "item-1",
      mediaSourceId: "nope",
    });
    expect(missing.outcome).toBe("missing");
    now += 60_001;
    const beforeExpiry = playbackInfo;
    await client.resolveMediaSource({
      url: "http://jellyfin:8096",
      token: "k",
      connectionId: "jf",
      itemId: "item-1",
      mediaSourceId: "src-1080",
    });
    expect(playbackInfo).toBe(beforeExpiry + 1);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url.includes("LiveStreams"))).toBe(false);
    expect(calls.some((call) => call.url.includes("POST"))).toBe(false);
  });

  it("invalidates a cached source when the local revision changes", async () => {
    let playbackInfo = 0;
    const client = createJellyfinPlayback({
      fetch: (async (url) => {
        if (String(url).includes("/PlaybackInfo")) {
          playbackInfo += 1;
          return json({ MediaSources: [{ Id: "src-1080", Path: "/mnt/nas/movies/film-1080.mkv", Protocol: "File" }] });
        }
        return json({}, 404);
      }) as typeof fetch,
      clock: () => 1_000,
    });
    await client.resolveMediaSource({
      url: "http://jellyfin:8096", token: "k", connectionId: "jf", itemId: "item-1", mediaSourceId: "src-1080", revisionKey: "a",
    });
    await client.resolveMediaSource({
      url: "http://jellyfin:8096", token: "k", connectionId: "jf", itemId: "item-1", mediaSourceId: "src-1080", revisionKey: "b",
    });
    expect(playbackInfo).toBe(2);
  });

  it("limits PlaybackInfo resolution to two concurrent requests per connection", async () => {
    let inflight = 0;
    let max = 0;
    const releases: Array<() => void> = [];
    const client = createJellyfinPlayback({
      fetch: (async (url) => {
        if (!String(url).includes("/PlaybackInfo")) return json({}, 404);
        inflight += 1;
        max = Math.max(max, inflight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inflight -= 1;
        return json({ MediaSources: [{ Id: "src", Path: "/a.mkv", Protocol: "File" }] });
      }) as typeof fetch,
      sourceConcurrency: 2,
    });
    const pending = [
      client.resolveMediaSource({ url: "http://jf", token: "k", connectionId: "jf", itemId: "a", mediaSourceId: "1" }),
      client.resolveMediaSource({ url: "http://jf", token: "k", connectionId: "jf", itemId: "b", mediaSourceId: "1" }),
      client.resolveMediaSource({ url: "http://jf", token: "k", connectionId: "jf", itemId: "c", mediaSourceId: "1" }),
    ];
    await viWaitUntil(() => releases.length === 2);
    expect(max).toBe(2);
    releases.splice(0).forEach((release) => release());
    await viWaitUntil(() => releases.length === 1);
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending);
    expect(max).toBe(2);
  });
});

describe("Jellyfin playback access", () => {
  it("accepts a server API key even when no sessions are visible", async () => {
    const client = playback(async (url) => {
      if (String(url).endsWith("/Auth/Keys")) {
        return json({ Items: [{ AccessToken: "server-key", AppName: "Polisharr" }] });
      }
      if (String(url).endsWith("/Sessions")) return json([]);
      return json({}, 404);
    });
    const result = await client.testPlaybackAccess({ url: "http://jellyfin:8096", token: "server-key" });
    expect(result).toMatchObject({ ok: true, credentialKind: "apiKey", householdVisible: true });
  });

  it("rejects an ordinary user token even when that user can see sessions", async () => {
    const client = playback(async (url) => {
      if (String(url).endsWith("/Auth/Keys")) return json({}, 403);
      if (String(url).endsWith("/Sessions")) return json([session(), session({ Id: "sess-2" })]);
      return json({}, 404);
    });
    const result = await client.testPlaybackAccess({ url: "http://jellyfin:8096", token: "user-token" });
    expect(result.ok).toBe(false);
    expect(result.credentialKind).toBe("userToken");
    expect(result.householdVisible).toBe(false);
    expect(result.kind).toBe("access");
  });

  it("rejects an admin user token that can list keys but is not itself a server API key", async () => {
    const client = playback(async (url) => {
      if (String(url).endsWith("/Auth/Keys")) {
        return json({ Items: [{ AccessToken: "server-key", AppName: "Other" }] });
      }
      if (String(url).endsWith("/Sessions")) return json([session(), session({ Id: "two" })]);
      return json({}, 404);
    });
    const result = await client.testPlaybackAccess({ url: "http://jellyfin:8096", token: "admin-user-token" });
    expect(result).toMatchObject({ ok: false, credentialKind: "userToken", householdVisible: false, kind: "access" });
  });
});

describe("playback reason copy", () => {
  it("keeps unknown enum values and names a missing reason", () => {
    expect(parseTranscodeReasons(["AudioCodecNotSupported", "FutureReasonX"])).toEqual([
      "AudioCodecNotSupported",
      "FutureReasonX",
    ]);
    expect(describePlaybackObservation({
      deviceLabel: "Living Room TV",
      playMethod: "Transcode",
      reasons: ["AudioCodecNotSupported"],
    })).toBe("Jellyfin converted the audio on Living Room TV.");
    expect(describePlaybackObservation({
      deviceLabel: "Living Room TV",
      playMethod: "DirectPlay",
      reasons: [],
    })).toBe("Jellyfin played this file directly on Living Room TV.");
    expect(describePlaybackObservation({
      deviceLabel: "Living Room TV",
      playMethod: "Transcode",
      reasons: [],
    })).toBe("Jellyfin did not report the reason.");
  });
});

async function viWaitUntil(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
