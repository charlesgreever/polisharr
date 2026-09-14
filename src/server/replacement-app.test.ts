import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { REPLACEMENT_STARTED, WAITING_TO_REPLACE } from "./review-recovery.ts";
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

describe("deferred replacement HTTP", () => {
  it("cancels a waiting Keep, preserves the sidecar, and conflicts after mutation starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-repl-http-"));
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const sourcePath = join(dir, "movie.mkv");
    const sidecarPath = join(dir, "sidecar.mkv");
    writeFileSync(sourcePath, "ORIGINAL!");
    writeFileSync(sidecarPath, "SIDECAR!!!");
    const created = createApp({
      env,
      hardware: async () => hw,
      fetch: (async () => new Response("{}")) as typeof fetch,
    });
    apps.push({ store: created.store, app: created });
    const setupRes = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const headers = { cookie: cookie(setupRes) };
    const instanceId = created.store.upsertInstance({
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: null,
      enabled: true,
    });
    const itemId = `${instanceId}:movie:1`;
    created.store.upsertItem({
      id: itemId,
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
      path: sourcePath,
      sizeBytes: 9,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    created.store.insertReview({
      id: "rev-wait",
      jobId: "job-1",
      itemId,
      displayTitle: "Film",
      status: "waiting",
      flagged: false,
      flagReason: null,
      sourcePath,
      sidecarPath,
      source: { codec: "h264", quality: "HD", sizeBytes: 9, sizePerHourGb: 1, durationSec: 60, tracks: "" },
      sidecar: { codec: "hevc", quality: "HD", sizeBytes: 6, sizePerHourGb: 0.5, durationSec: 60, tracks: "" },
      error: null,
      intentOrigin: "keep",
      waitReason: WAITING_TO_REPLACE,
    });
    await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: dir }),
    });
    const listed = await created.app.request("/api/review", { headers });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ pendingCount: 0, waitingCount: 1 });
    const cancelled = await created.app.request("/api/review/rev-wait/cancel-keep", { method: "POST", headers });
    expect(cancelled.status).toBe(200);
    expect(created.store.getReview("rev-wait")).toMatchObject({ status: "pending", intentOrigin: null });
    expect(created.store.getReview("rev-wait")?.sidecarPath).toBe(sidecarPath);

    created.store.insertReview({
      id: "rev-keep",
      jobId: "job-2",
      itemId,
      displayTitle: "Film",
      status: "keeping",
      flagged: false,
      flagReason: null,
      sourcePath,
      sidecarPath: join(dir, "sidecar-2.mkv"),
      source: { codec: "h264", quality: "HD", sizeBytes: 9, sizePerHourGb: 1, durationSec: 60, tracks: "" },
      sidecar: { codec: "hevc", quality: "HD", sizeBytes: 6, sizePerHourGb: 0.5, durationSec: 60, tracks: "" },
      error: null,
      mutationStarted: true,
    });
    const conflict = await created.app.request("/api/review/rev-keep/cancel-keep", { method: "POST", headers });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: REPLACEMENT_STARTED });
  });
});
