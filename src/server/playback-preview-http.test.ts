import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { PREVIEW_PROTOCOL_VERSION, PREVIEW_SDR_1080P_PROFILE } from "./cluster.ts";
import { loadEnv } from "./env.ts";
import { PLAYBACK_WAIT_FINISH } from "./playback-policy.ts";
import type { HardwareInfo, InspectionReport } from "./types.ts";

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null };
const apps: Array<{
  store: { close: () => void };
  app: { jobs: { stop: () => void }; previews?: { stop: () => void }; workerLoop?: { stop: () => void }; playbackMonitor?: { stop: () => Promise<void> } };
}> = [];

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

function surroundReport(path: string, sizeBytes: number): InspectionReport {
  return {
    sourceSig: `${path}|${sizeBytes}`,
    sourceMethod: "ffprobe",
    listingState: "complete",
    durationSec: 60,
    sizeBytes,
    sizePerHourGb: 1,
    videoCodec: "hevc",
    width: 1920,
    height: 1080,
    bitDepth: 10,
    hdr: "none",
    audio: [{ index: 1, language: "eng", channels: 8, codec: "truehd", title: "Atmos", untagged: false, commentary: false }],
    subtitles: [],
    hasChapters: false,
    hasAttachments: false,
  };
}

function playing(path: string) {
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
      MediaSources: [{ Id: "src-1", Path: path, Protocol: "File", IsRemote: false }],
    },
    PlayState: { IsPaused: false, MediaSourceId: "src-1", PlayMethod: "Transcode", AudioStreamIndex: 1 },
    TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: false, TranscodeReasons: ["AudioCodecNotSupported"] },
  };
}

function jellyfinFetch(path: string): typeof fetch {
  return (async (url) => {
    const text = String(url);
    if (text.endsWith("/System/Info")) return new Response(JSON.stringify({ ServerName: "JF" }), { status: 200 });
    if (text.endsWith("/Auth/Keys")) {
      return new Response(JSON.stringify({ Items: [{ AccessToken: "server-key", AppName: "Polisharr" }] }), { status: 200 });
    }
    if (text.endsWith("/Sessions")) return new Response(JSON.stringify([playing(path)]), { status: 200 });
    if (text.includes("/PlaybackInfo")) {
      return new Response(JSON.stringify({
        MediaSources: [{ Id: "src-1", Path: path, Protocol: "File", IsRemote: false }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("merged diagnostics and Review clips", () => {
  it("serves diagnostics next to preview HTTP, holds new work, and parks Keep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-merged-http-"));
    const libraryDir = join(dir, "library");
    mkdirSync(libraryDir, { recursive: true });
    const sourcePath = join(libraryDir, "movie.mkv");
    const sidecarPath = join(libraryDir, "sidecar.mkv");
    const otherPath = join(libraryDir, "other.mkv");
    writeFileSync(sourcePath, "ORIGINAL!");
    writeFileSync(sidecarPath, "SIDECAR!!!");
    writeFileSync(otherPath, "OTHERFILE");
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => hw,
      fetch: jellyfinFetch(sourcePath),
      playbackPollMs: 0,
      playbackTimeoutMs: 50,
      previewCapability: async () => ({
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        h264Encoder: "h264_nvenc",
        profiles: [PREVIEW_SDR_1080P_PROFILE],
      }),
      previewProbe: async () => ({
        durationMs: 60_000,
        width: 1920,
        height: 1080,
        sarNum: 1,
        sarDen: 1,
        hdr: "none",
        videoIndex: 0,
        audio: [{ index: 1, language: "eng", channels: 6, codec: "ac3", default: true }],
        hasVideo: true,
      }),
      previewRenderer: async () => ({ ok: true }),
      optimizer: async (req) => ({
        sidecarPath: join(dir, "other-sidecar.mkv"),
        output: { ...req.report, videoCodec: "hevc", sizeBytes: 3 },
      }),
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
    const radarrId = created.store.listInstances().find((row) => row.kind === "radarr")!.id;
    const jfId = created.store.listInstances().find((row) => row.kind === "jellyfin")!.id;
    const filmId = `${radarrId}:movie:1`;
    const otherId = `${radarrId}:movie:2`;
    created.store.upsertItem({
      id: filmId, instanceId: radarrId, arrId: 1, arrSeriesId: null, arrEpisodeFileId: null, type: "movie",
      title: "The Film", showTitle: null, season: null, episode: null, episodeTitle: null, path: sourcePath,
      sizeBytes: 9, quality: "HD", resolution: "1080", profile: "HD", tags: [], posterRemoteUrl: null, sizeExempt: false,
    });
    created.store.upsertItem({
      id: otherId, instanceId: radarrId, arrId: 2, arrSeriesId: null, arrEpisodeFileId: null, type: "movie",
      title: "Other", showTitle: null, season: null, episode: null, episodeTitle: null, path: otherPath,
      sizeBytes: 8, quality: "HD", resolution: "1080", profile: "HD", tags: [], posterRemoteUrl: null, sizeExempt: false,
    });
    created.store.saveInspection(filmId, surroundReport(sourcePath, 9));
    created.store.saveInspection(otherId, surroundReport(otherPath, 8));
    const plan = {
      origin: "custom" as const, video: { kind: "copy" as const }, audio: [], subtitles: [], container: "mkv" as const,
      writeMode: "sidecar" as const, warning: null, reasons: ["Copy"], estimatedOutputBytes: 1, category: "movie1080p" as const,
    };
    created.store.insertJob({
      id: "job-done", itemId: filmId, suggestionId: null, status: "succeeded", phase: "idle", progress: 1,
      error: null, warning: null, runNow: false, createdAt: 1, writeMode: "sidecar", plan,
    });
    created.store.insertReview({
      id: "rev-1", jobId: "job-done", itemId: filmId, displayTitle: "The Film", status: "pending",
      flagged: false, flagReason: null, sourcePath, sidecarPath,
      source: { codec: "hevc", quality: "HD", sizeBytes: 9, sizePerHourGb: 1, durationSec: 60, tracks: "1 audio / 0 subtitles" },
      sidecar: { codec: "hevc", quality: "HD", sizeBytes: 10, sizePerHourGb: 0.5, durationSec: 60, tracks: "1 audio / 0 subtitles" },
      error: null,
    });
    const reviewPath = join(dir, "review");
    const settings = await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath }),
    });
    expect(settings.status).toBe(200);
    const nodes = await (await created.app.request("/api/nodes", { headers })).json() as { thisNodeId: string };
    const saved = await created.app.request("/api/playback/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        connections: [{
          connectionId: jfId,
          observePlayback: true,
          protectNodes: true,
          protectedNodeIds: [nodes.thisNodeId],
          protectReplacement: true,
          coveredArrInstanceIds: [radarrId],
        }],
      }),
    });
    expect(saved.status).toBe(200);

    const diagnostics = await (await created.app.request("/api/playback/diagnostics", { headers })).json() as {
      items: Array<{ reasonFamily: string; recommendation: { kind: string }; libraryItemIds: string[] }>;
    };
    expect(diagnostics.items).toHaveLength(1);
    expect(diagnostics.items[0]?.reasonFamily).toBe("audio");
    expect(diagnostics.items[0]?.recommendation.kind).toBe("add_stereo");
    expect(diagnostics.items[0]?.libraryItemIds).toEqual([filmId]);

    const preview = await created.app.request("/api/review/rev-1/previews", {
      method: "POST",
      headers,
      body: JSON.stringify({ startMs: 1000 }),
    });
    expect(preview.status).toBe(202);
    const previewBody = await preview.json() as { id: string; status: string; waitReason: string | null };
    expect(previewBody.id).not.toBe("job-done");
    expect(previewBody.status).toBe("queued");
    expect(previewBody.waitReason).toBe("playback");
    const previewStatus = await created.app.request(`/api/review/rev-1/previews/${previewBody.id}`, { headers });
    expect(previewStatus.status).toBe(200);
    const stillDiagnostics = await created.app.request("/api/playback/diagnostics", { headers });
    expect(stillDiagnostics.status).toBe(200);

    created.store.insertJob({
      id: "job-queued", itemId: otherId, suggestionId: null, status: "queued", phase: "queued", progress: 0,
      error: null, warning: null, runNow: true, createdAt: 2, writeMode: "sidecar", plan, assignedNodeId: nodes.thisNodeId,
    });
    const jobs = await (await created.app.request("/api/jobs", { headers })).json() as {
      items: Array<{ id: string; status: string; waitingReason?: string | null; playbackHold?: { sentence: string | null } }>;
    };
    const queued = jobs.items.find((row) => row.id === "job-queued");
    expect(queued?.status).toBe("queued");
    expect(queued?.waitingReason).toBe("playback");
    expect(queued?.playbackHold?.sentence).toBe(PLAYBACK_WAIT_FINISH);
    expect(created.store.getJob("job-queued")?.status).toBe("queued");

    const keep = await created.app.request("/api/review/rev-1/keep", { method: "POST", headers });
    expect(keep.status).toBe(202);
    expect(await keep.json()).toMatchObject({ ok: true, accepted: true, disposition: "waiting" });
    expect(readFileSync(sourcePath, "utf8")).toBe("ORIGINAL!");
    expect(readFileSync(sidecarPath, "utf8")).toBe("SIDECAR!!!");
    const review = await (await created.app.request("/api/review", { headers })).json() as {
      items: Array<{ id: string; status: string; waitReason: string | null }>;
      waitingCount: number;
    };
    expect(review.waitingCount).toBe(1);
    expect(review.items[0]).toMatchObject({ id: "rev-1", status: "waiting", waitReason: PLAYBACK_WAIT_FINISH });
    const afterKeepPreview = await (await created.app.request(`/api/review/rev-1/previews/${previewBody.id}`, { headers })).json() as {
      status: string;
    };
    expect(afterKeepPreview.status).toBe("cancelled");
    expect((await created.app.request("/api/playback/diagnostics", { headers })).status).toBe(200);
    expect(created.store.getJob("job-queued")?.status).toBe("queued");
    expect(readFileSync(sourcePath, "utf8")).toBe("ORIGINAL!");
  });
});
