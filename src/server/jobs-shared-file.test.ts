import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JobService, SHARED_FILE_BUSY } from "./jobs.ts";
import { Store } from "./store.ts";
import type { ExecutablePlan, InspectionReport, ReviewItem } from "./types.ts";

const plan: ExecutablePlan = {
  origin: "custom",
  video: { kind: "copy" },
  audio: [],
  subtitles: [],
  container: "mkv",
  writeMode: "sidecar",
  warning: null,
  reasons: ["Copy tracks."],
  estimatedOutputBytes: 8,
  category: "tv1080p",
};

describe("shared multi-episode files", () => {
  it("lists both episodes for one path and combines Queue and Review titles", () => {
    const ctx = setupEpisodes();
    expect(ctx.store.itemsForPath(ctx.path, ctx.instanceId).map((item) => item.episode)).toEqual([35, 36]);
    ctx.store.insertJob({
      id: "job-1",
      itemId: ctx.e35,
      suggestionId: null,
      status: "queued",
      phase: "queued",
      progress: 0,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 1,
      plan,
    });
    expect(ctx.store.activeJobForPath(ctx.path, ctx.instanceId)?.itemId).toBe(ctx.e35);
    expect(ctx.store.jobPage(0, 10).items[0]?.displayTitle).toBe(
      "Paw Patrol S08E35–E36 · Rescue Knights: Pups Save the Baby Dragons",
    );
    ctx.store.insertReview(reviewRow("rev-1", "job-1", ctx.e35, ctx.path, ctx.sidecarPath));
    expect(ctx.store.pendingReviewForPath(ctx.path, ctx.instanceId)?.itemId).toBe(ctx.e35);
    expect(ctx.store.reviewPage(0, 10).items[0]?.displayTitle).toBe(
      "Paw Patrol S08E35–E36 · Rescue Knights: Pups Save the Baby Dragons",
    );
    ctx.close();
  });

  it("rejects a second queue job for the sibling episode", () => {
    const ctx = setupEpisodes();
    ctx.store.insertJob({
      id: "job-1",
      itemId: ctx.e35,
      suggestionId: null,
      status: "running",
      phase: "transcoding",
      progress: 0.4,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 1,
      plan,
    });
    const jobs = ctx.jobs();
    expect(jobs.enqueueCustom(ctx.e36, plan)).toEqual({ error: SHARED_FILE_BUSY, status: 409 });
    ctx.close();
  });

  it("rejects queue when the sibling already has a Review sidecar", () => {
    const ctx = setupEpisodes();
    ctx.store.insertReview(reviewRow("rev-1", "job-1", ctx.e35, ctx.path, ctx.sidecarPath));
    const jobs = ctx.jobs();
    expect(jobs.enqueueCustom(ctx.e36, plan)).toEqual({ error: SHARED_FILE_BUSY, status: 409 });
    ctx.close();
  });

  it("keeps the shared sidecar when discarding one of two Review cards", async () => {
    const ctx = setupEpisodes();
    writeFileSync(ctx.sidecarPath, "SIDECAR");
    ctx.store.insertReview(reviewRow("rev-35", "job-1", ctx.e35, ctx.path, ctx.sidecarPath));
    ctx.store.insertReview(reviewRow("rev-36", "job-2", ctx.e36, ctx.path, ctx.sidecarPath));
    const jobs = ctx.jobs();
    expect(await jobs.discard("rev-35")).toEqual({ accepted: true });
    expect(existsSync(ctx.sidecarPath)).toBe(true);
    expect(ctx.store.getReview("rev-35")).toBeUndefined();
    expect(ctx.store.getReview("rev-36")?.itemId).toBe(ctx.e36);
    expect(await jobs.discard("rev-36")).toEqual({ accepted: true });
    expect(existsSync(ctx.sidecarPath)).toBe(false);
    ctx.close();
  });

  it("Keeps a shared sidecar once and drops the sibling Review card", async () => {
    const ctx = setupEpisodes();
    writeFileSync(ctx.path, "ORIGINAL!");
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    ctx.store.insertJob({
      id: "job-1",
      itemId: ctx.e35,
      suggestionId: null,
      status: "succeeded",
      phase: "idle",
      progress: 1,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 1,
      plan,
    });
    ctx.store.insertReview(reviewRow("rev-35", "job-1", ctx.e35, ctx.path, ctx.sidecarPath, 9, 10));
    ctx.store.insertReview(reviewRow("rev-36", "job-2", ctx.e36, ctx.path, ctx.sidecarPath, 9, 10));
    const promoted: string[] = [];
    const reinspected: string[] = [];
    const jobs = ctx.jobs({
      promote: async (input) => {
        promoted.push(input.outputPath);
        writeFileSync(input.item.path, "SIDECAR!!!");
        return { replaced: true, destPath: input.item.path, savedBytes: 1, warning: null, error: null };
      },
      reinspectChangedItem: async (id) => {
        reinspected.push(id);
        return { ok: true as const };
      },
    });
    expect(await jobs.keep("rev-35")).toMatchObject({ accepted: true, disposition: "started" });
    await vi.waitFor(() => expect(ctx.store.getReview("rev-35")).toBeUndefined());
    expect(ctx.store.getReview("rev-36")).toBeUndefined();
    expect(promoted).toEqual([ctx.sidecarPath]);
    expect(reinspected.sort()).toEqual([ctx.e35, ctx.e36].sort());
    expect(ctx.store.getItem(ctx.e35)?.sizeBytes).toBe(10);
    expect(ctx.store.getItem(ctx.e36)?.sizeBytes).toBe(10);
    ctx.close();
  });

  it("does not start a second Keep of the same sidecar from Keep all", async () => {
    const ctx = setupEpisodes();
    writeFileSync(ctx.path, "ORIGINAL!");
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    ctx.store.insertJob({
      id: "job-1",
      itemId: ctx.e35,
      suggestionId: null,
      status: "succeeded",
      phase: "idle",
      progress: 1,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 1,
      plan,
    });
    ctx.store.insertReview(reviewRow("rev-35", "job-1", ctx.e35, ctx.path, ctx.sidecarPath, 9, 10));
    ctx.store.insertReview(reviewRow("rev-36", "job-2", ctx.e36, ctx.path, ctx.sidecarPath, 9, 10));
    const promoted: string[] = [];
    const jobs = ctx.jobs({
      promote: async (input) => {
        promoted.push(input.outputPath);
        await new Promise((resolve) => setTimeout(resolve, 40));
        writeFileSync(input.item.path, "SIDECAR!!!");
        return { replaced: true, destPath: input.item.path, savedBytes: 1, warning: null, error: null };
      },
    });
    const result = await jobs.keepPending();
    expect(result).toEqual({ accepted: 1, skipped: 1, started: 1, waiting: 0 });
    await vi.waitFor(() => expect(ctx.store.listReviews()).toEqual([]));
    expect(promoted).toEqual([ctx.sidecarPath]);
    ctx.close();
  });
});

function setupEpisodes() {
  const dir = mkdtempSync(join(tmpdir(), "opt-shared-"));
  const store = new Store(join(dir, "polisharr.db"));
  const instanceId = store.upsertInstance({
    kind: "sonarr",
    name: "TV",
    url: "http://sonarr",
    secret: null,
    enabled: true,
  });
  const path = join(dir, "Paw Patrol - S08E35-E36.mkv");
  const sidecarPath = join(dir, "sidecar.mkv");
  writeFileSync(path, "ORIGINAL!");
  const e35 = upsertEpisode(store, instanceId, 35, path);
  const e36 = upsertEpisode(store, instanceId, 36, path);
  store.saveInspection(e35, inspection(path, 9));
  store.saveInspection(e36, inspection(path, 9));
  store.saveSettings({ ...store.getSettings(), reviewPath: dir });
  return {
    dir,
    store,
    instanceId,
    path,
    sidecarPath,
    e35,
    e36,
    jobs(extra: Partial<ConstructorParameters<typeof JobService>[0]> = {}) {
      return new JobService({
        store,
        optimizer: async () => {
          throw new Error("optimizer should not run");
        },
        hardware: async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null }),
        tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
        decrypt: () => "",
        fetch: (async () => new Response("{}")) as typeof fetch,
        reinspectChangedItem: async () => ({ ok: true as const }),
        ...extra,
      });
    },
    close() {
      store.close();
    },
  };
}

function upsertEpisode(store: Store, instanceId: string, episode: number, path: string): string {
  const id = `${instanceId}:episode:${episode}`;
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
    episodeTitle: episode === 35
      ? "Rescue Knights: Pups Save the Baby Dragons"
      : "Rescue Knights: Pups Break the Ice",
    path,
    sizeBytes: 9,
    quality: "WEBDL-1080p",
    resolution: "1080",
    profile: "HD",
    tags: [],
    posterRemoteUrl: null,
    sizeExempt: false,
  });
  return id;
}

function inspection(path: string, sizeBytes: number): InspectionReport {
  return {
    sourceSig: `${path}|${sizeBytes}`,
    sourceMethod: "ffprobe",
    listingState: "complete",
    durationSec: 60,
    sizeBytes,
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
  };
}

function reviewRow(
  id: string,
  jobId: string,
  itemId: string,
  sourcePath: string,
  sidecarPath: string,
  sourceBytes = 9,
  sidecarBytes = 6,
): ReviewItem {
  return {
    id,
    jobId,
    itemId,
    displayTitle: "Paw Patrol",
    status: "pending",
    flagged: false,
    flagReason: null,
    sourcePath,
    sidecarPath,
    source: { codec: "h264", quality: "HD", sizeBytes: sourceBytes, sizePerHourGb: 1, durationSec: 60, tracks: "" },
    sidecar: { codec: "hevc", quality: "HD", sizeBytes: sidecarBytes, sizePerHourGb: 0.5, durationSec: 60, tracks: "" },
    error: null,
  };
}
