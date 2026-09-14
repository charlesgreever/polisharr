import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService, type JobPlaybackGate } from "./jobs.ts";
import { PLAYBACK_ALLOWED, type PlaybackDecision } from "./playback-policy.ts";
import {
  KEEP_ALREADY_WAITING,
  MISSING_REVISION,
  REPLACEMENT_STARTED,
  SOURCE_CHANGED,
  WAITING_TO_REPLACE,
} from "./review-recovery.ts";
import { Store } from "./store.ts";
import type { ExecutablePlan, InspectionReport, ReviewItem } from "./types.ts";

const stores: Store[] = [];
const services: JobService[] = [];

afterEach(() => {
  for (const jobs of services) jobs.stop();
  services.length = 0;
  for (const store of stores) store.close();
  stores.length = 0;
});

const blockedPlay: PlaybackDecision = {
  allowed: false,
  reason: "playing",
  connectionIds: ["jf"],
  connectionNames: ["Living Room"],
  observedAt: 1_000,
};

function compare(sourceBytes: number, sidecarBytes: number): Pick<ReviewItem, "source" | "sidecar"> {
  return {
    source: { codec: "hevc", quality: "HD", sizeBytes: sourceBytes, sizePerHourGb: 1, durationSec: 60, tracks: "1 audio / 0 subtitles" },
    sidecar: { codec: "hevc", quality: "HD", sizeBytes: sidecarBytes, sizePerHourGb: 0.5, durationSec: 60, tracks: "1 audio / 0 subtitles" },
  };
}

function reportFor(path: string, sizeBytes: number): InspectionReport {
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

function copyPlan(writeMode: "sidecar" | "direct" = "sidecar"): ExecutablePlan {
  return {
    origin: "custom",
    video: { kind: "copy" },
    audio: [],
    subtitles: [],
    container: "mkv",
    writeMode,
    warning: null,
    reasons: ["Copy tracks."],
    estimatedOutputBytes: 3,
    category: "movie1080p",
  };
}

function harness(opts: {
  playback?: JobPlaybackGate;
  clock?: () => number;
  promote?: ConstructorParameters<typeof JobService>[0]["promote"];
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opt-repl-"));
  const store = new Store(join(dir, "polisharr.db"));
  stores.push(store);
  store.saveSettings({ ...store.getSettings(), reviewPath: dir, concurrency: 1 });
  store.upsertNode({
    id: "worker-1",
    name: "5090",
    role: "worker",
    lastSeen: Date.now(),
    hardware: { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null },
    concurrency: 1,
    enabled: true,
    version: "1",
    currentJobId: null,
  });
  const instanceId = store.upsertInstance({
    kind: "radarr",
    name: "Radarr",
    url: "http://radarr",
    secret: "enc",
    enabled: true,
  });
  const itemId = `${instanceId}:movie:10`;
  const sourcePath = join(dir, "movie.mkv");
  const sidecarPath = join(dir, "sidecar.mkv");
  writeFileSync(sourcePath, "ORIGINAL!");
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
    path: sourcePath,
    sizeBytes: 9,
    quality: "HD",
    resolution: "1080",
    profile: "HD",
    tags: [],
    posterRemoteUrl: null,
    sizeExempt: false,
  });
  store.saveInspection(itemId, reportFor(sourcePath, 9));
  store.insertJob({
    id: "job-1",
    itemId,
    suggestionId: null,
    status: "succeeded",
    phase: "idle",
    progress: 1,
    error: null,
    warning: null,
    runNow: false,
    createdAt: 1,
    plan: copyPlan(),
  });
  const jobs = new JobService({
    store,
    optimizer: async () => {
      writeFileSync(sidecarPath, "SIDECAR!!!");
      return { sidecarPath, output: { ...reportFor(sidecarPath, 10), videoCodec: "hevc", sizeBytes: 10 } };
    },
    hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
    tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
    decrypt: () => "key",
    fetch: (async () => new Response("{}", { status: 201 })) as typeof fetch,
    reinspectChangedItem: async () => ({ ok: true as const }),
    clock: opts.clock,
    playback: opts.playback,
    promote: opts.promote,
  });
  services.push(jobs);
  return { dir, store, jobs, itemId, sourcePath, sidecarPath, instanceId };
}

function insertPending(ctx: ReturnType<typeof harness>, id = "rev-1"): void {
  writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
  ctx.store.insertReview({
    id,
    jobId: "job-1",
    itemId: ctx.itemId,
    displayTitle: "Film",
    status: "pending",
    flagged: false,
    flagReason: null,
    sourcePath: ctx.sourcePath,
    sidecarPath: ctx.sidecarPath,
    ...compare(9, 10),
    error: null,
  });
}

describe("deferred replacement", () => {
  it("records Keep during playback, preserves both files, and cancels wait without a move", async () => {
    const ctx = harness({
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => blockedPlay,
      },
    });
    insertPending(ctx);
    const keep = await ctx.jobs.keep("rev-1");
    expect(keep).toEqual({ accepted: true, disposition: "waiting" });
    expect(ctx.store.getReview("rev-1")).toMatchObject({
      status: "waiting",
      intentOrigin: "keep",
      cancellable: true,
      waitReason: "Waiting for Jellyfin playback to finish",
    });
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    expect(readFileSync(ctx.sidecarPath, "utf8")).toBe("SIDECAR!!!");
    expect(ctx.store.historyPage(0, 10).items.filter((row) => row.outcome === "kept")).toHaveLength(0);
    expect(await ctx.jobs.keep("rev-1")).toMatchObject({ error: KEEP_ALREADY_WAITING, status: 409 });
    expect(await ctx.jobs.cancelKeep("rev-1")).toEqual({ accepted: true });
    expect(ctx.store.getReview("rev-1")).toMatchObject({ status: "pending", intentOrigin: null });
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    expect(existsSync(ctx.sidecarPath)).toBe(true);
  });

  it("returns 409 when Cancel wait runs after mutation starts", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = harness({
      promote: async (input) => {
        await held;
        writeFileSync(input.item.path, "SIDECAR!!!");
        return { replaced: true, destPath: input.item.path, savedBytes: 1, warning: null, error: null };
      },
    });
    insertPending(ctx);
    const keep = await ctx.jobs.keep("rev-1");
    expect(keep).toMatchObject({ accepted: true, disposition: "started" });
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")?.mutationStarted).toBe(true));
    expect(await ctx.jobs.cancelKeep("rev-1")).toMatchObject({ error: REPLACEMENT_STARTED, status: 409 });
    release();
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")).toBeUndefined());
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("SIDECAR!!!");
  });

  it("turns a blocked local or remote direct write into a waiting Review without savings", async () => {
    const refreshed: number[] = [];
    const ctx = harness({
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => blockedPlay,
        refreshReplacementPreflight: () => {
          refreshed.push(1);
        },
      },
    });
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    const queued = ctx.jobs.enqueueCustom(ctx.itemId, copyPlan("direct"), { assignedNodeId: "worker-1" });
    expect("id" in queued).toBe(true);
    if (!("id" in queued)) return;
    const claimed = ctx.jobs.claimForNode("worker-1", 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.plan).toMatchObject({ writeMode: "direct" });
    ctx.store.saveSettings({ ...ctx.store.getSettings(), writeMode: "sidecar" });
    const playerCalls: string[] = [];
    const jobs = new JobService({
      store: ctx.store,
      optimizer: async () => {
        throw new Error("master must not encode");
      },
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
      decrypt: () => "key",
      fetch: (async (url) => {
        playerCalls.push(String(url));
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
      reinspectChangedItem: async () => ({ ok: true as const }),
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => blockedPlay,
      },
    });
    services.push(jobs);
    const done = await jobs.completeRemote(queued.id, claimed[0]!.leaseToken, ctx.sidecarPath, {
      ...reportFor(ctx.sidecarPath, 10),
      videoCodec: "hevc",
      sizeBytes: 10,
    });
    expect(done).toEqual({ ok: true });
    expect(ctx.store.getJob(queued.id)?.status).toBe("succeeded");
    expect(ctx.store.jobLease(queued.id)?.token).toBeNull();
    const review = ctx.store.listReviews()[0];
    expect(review).toMatchObject({ status: "waiting", intentOrigin: "direct" });
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    expect(existsSync(ctx.sidecarPath)).toBe(true);
    expect(ctx.store.historyPage(0, 10).items.filter((row) => row.outcome === "kept")).toHaveLength(0);
    expect(playerCalls).toEqual([]);
    const again = await jobs.completeRemote(queued.id, claimed[0]!.leaseToken, ctx.sidecarPath, {
      ...reportFor(ctx.sidecarPath, 10),
      sizeBytes: 10,
    });
    expect(again).toEqual({ ok: true });
    expect(ctx.store.listReviews()).toHaveLength(1);
  });

  it("does not create an automatic intent when the pre-encode revision is missing", async () => {
    const ctx = harness({
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => blockedPlay,
      },
    });
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    const queued = ctx.jobs.enqueueCustom(ctx.itemId, copyPlan("direct"), { assignedNodeId: "worker-1" });
    expect("id" in queued).toBe(true);
    if (!("id" in queued)) return;
    const claimed = ctx.jobs.claimForNode("worker-1", 1);
    ctx.store.updateJob(queued.id, { sourceRevision: null });
    await ctx.jobs.completeRemote(queued.id, claimed[0]!.leaseToken, ctx.sidecarPath, {
      ...reportFor(ctx.sidecarPath, 10),
      sizeBytes: 10,
    });
    expect(ctx.store.listReviews()[0]).toMatchObject({ status: "pending", error: MISSING_REVISION, intentOrigin: null });
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
  });

  it("cancels a waiting intent when the original changes and leaves both copies", async () => {
    const ctx = harness({
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => blockedPlay,
      },
    });
    insertPending(ctx);
    await ctx.jobs.keep("rev-1");
    expect(ctx.store.getReview("rev-1")?.status).toBe("waiting");
    writeFileSync(ctx.sourcePath, "ARR-UPGRADE-BYTES");
    const allowed: JobPlaybackGate = {
      nodeAdmission: () => PLAYBACK_ALLOWED,
      blockedNodeIds: () => [],
      fileReplacement: () => PLAYBACK_ALLOWED,
    };
    const resumed = new JobService({
      store: ctx.store,
      optimizer: async () => {
        throw new Error("optimizer should not run");
      },
      hardware: async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null }),
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
      decrypt: () => "",
      fetch: (async () => new Response("{}")) as typeof fetch,
      reinspectChangedItem: async () => ({ ok: true as const }),
      playback: allowed,
    });
    services.push(resumed);
    resumed.start();
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")?.status).toBe("pending"));
    expect(ctx.store.getReview("rev-1")?.error).toBe(SOURCE_CHANGED);
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ARR-UPGRADE-BYTES");
    expect(readFileSync(ctx.sidecarPath, "utf8")).toBe("SIDECAR!!!");
    expect(ctx.store.historyPage(0, 10).items.filter((row) => row.outcome === "kept")).toHaveLength(0);
  });

  it("reports started, waiting, and skipped on mixed bulk Keep and skips waiting cards", async () => {
    const ctx = harness({
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: (file) => (file.itemId === ctx.itemId ? blockedPlay : PLAYBACK_ALLOWED),
      },
    });
    insertPending(ctx, "rev-wait");
    const second = `${ctx.instanceId}:movie:11`;
    const secondPath = join(ctx.dir, "movie-2.mkv");
    const secondSidecar = join(ctx.dir, "sidecar-2.mkv");
    writeFileSync(secondPath, "ORIGINAL2");
    writeFileSync(secondSidecar, "SIDE2");
    ctx.store.upsertItem({
      id: second,
      instanceId: ctx.instanceId,
      arrId: 11,
      arrSeriesId: null,
      arrEpisodeFileId: null,
      type: "movie",
      title: "Film 2",
      showTitle: null,
      season: null,
      episode: null,
      episodeTitle: null,
      path: secondPath,
      sizeBytes: 9,
      quality: "HD",
      resolution: "1080",
      profile: "HD",
      tags: [],
      posterRemoteUrl: null,
      sizeExempt: false,
    });
    ctx.store.insertJob({
      id: "job-2",
      itemId: second,
      suggestionId: null,
      status: "succeeded",
      phase: "idle",
      progress: 1,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 2,
      plan: copyPlan(),
    });
    ctx.store.insertReview({
      id: "rev-start",
      jobId: "job-2",
      itemId: second,
      displayTitle: "Film 2",
      status: "pending",
      flagged: false,
      flagReason: null,
      sourcePath: secondPath,
      sidecarPath: secondSidecar,
      ...compare(9, 6),
      error: null,
    });
    ctx.store.insertReview({
      id: "rev-already",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "waiting",
      flagged: false,
      flagReason: null,
      sourcePath: ctx.sourcePath,
      sidecarPath: join(ctx.dir, "other-sidecar.mkv"),
      ...compare(9, 6),
      error: null,
      intentOrigin: "keep",
    });
    const result = await ctx.jobs.keepPending();
    expect(result).toEqual({ accepted: 2, skipped: 0, started: 1, waiting: 1 });
    expect(ctx.store.getReview("rev-wait")?.status).toBe("waiting");
    await vi.waitFor(() => expect(ctx.store.getReview("rev-start")).toBeUndefined());
    expect(ctx.store.getReview("rev-already")?.status).toBe("waiting");
    expect(ctx.store.pendingReviewIds()).not.toContain("rev-wait");
    expect(ctx.store.reviewPage(0, 50)).toMatchObject({ pendingCount: 0, waitingCount: 2 });
  });

  it("returns waiting on a stale preflight and pending on a file-operation failure", async () => {
    let now = 20_000;
    const refreshed: string[] = [];
    const staleAllowed: PlaybackDecision = {
      allowed: true,
      reason: null,
      connectionIds: [],
      connectionNames: [],
      observedAt: 1_000,
    };
    const ctx = harness({
      clock: () => now,
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => staleAllowed,
        refreshReplacementPreflight: () => {
          refreshed.push("refresh");
        },
      },
    });
    insertPending(ctx);
    const keep = await ctx.jobs.keep("rev-1");
    expect(keep).toEqual({ accepted: true, disposition: "waiting" });
    expect(refreshed).toEqual(["refresh"]);
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");

    const failing = harness({
      promote: async () => ({ replaced: false, destPath: "", savedBytes: 0, warning: null, error: "disk full" }),
    });
    insertPending(failing);
    const started = await failing.jobs.keep("rev-1");
    expect(started).toMatchObject({ accepted: true, disposition: "started" });
    await vi.waitFor(() => expect(failing.store.getReview("rev-1")?.status).toBe("pending"));
    expect(failing.store.getReview("rev-1")).toMatchObject({ error: "disk full", intentOrigin: null });
    expect(readFileSync(failing.sourcePath, "utf8")).toBe("ORIGINAL!");
    expect(existsSync(failing.sidecarPath)).toBe(true);
    failing.jobs.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(failing.store.getReview("rev-1")?.status).toBe("pending");
  });

  it("restores a waiting intent after restart and replaces only after playback allows it", async () => {
    const ctx = harness({
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => blockedPlay,
      },
    });
    insertPending(ctx);
    await ctx.jobs.keep("rev-1");
    ctx.jobs.stop();
    const held = new JobService({
      store: ctx.store,
      optimizer: async () => {
        throw new Error("optimizer should not run");
      },
      hardware: async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null }),
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
      decrypt: () => "",
      fetch: (async () => new Response("{}")) as typeof fetch,
      reinspectChangedItem: async () => ({ ok: true as const }),
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => ({
          allowed: false,
          reason: "unknown",
          connectionIds: ["jf"],
          connectionNames: ["Living Room"],
          observedAt: null,
        }),
      },
    });
    services.push(held);
    await held.recoverInterruptedKeeps();
    expect(ctx.store.getReview("rev-1")?.status).toBe("waiting");
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    held.stop();
    const open = new JobService({
      store: ctx.store,
      optimizer: async () => {
        throw new Error("optimizer should not run");
      },
      hardware: async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null }),
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
      decrypt: () => "",
      fetch: (async () => new Response("{}")) as typeof fetch,
      reinspectChangedItem: async () => ({ ok: true as const }),
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => PLAYBACK_ALLOWED,
      },
    });
    services.push(open);
    open.start();
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")).toBeUndefined());
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("SIDECAR!!!");
    expect(ctx.store.historyPage(0, 10).items.filter((row) => row.outcome === "kept")).toHaveLength(1);
  });

  it("records one kept event when Keep is requested twice after a successful replace", async () => {
    const ctx = harness();
    insertPending(ctx);
    const first = await ctx.jobs.keep("rev-1");
    expect(first).toMatchObject({ accepted: true, disposition: "started" });
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")).toBeUndefined());
    const second = await ctx.jobs.keep("rev-1");
    expect(second).toMatchObject({ status: 404 });
    expect(ctx.store.historyPage(0, 10).items.filter((row) => row.outcome === "kept")).toHaveLength(1);
  });

  it("discards a waiting card only after cancelling the intent and keeps the original", async () => {
    const ctx = harness({
      playback: {
        nodeAdmission: () => PLAYBACK_ALLOWED,
        blockedNodeIds: () => [],
        fileReplacement: () => blockedPlay,
      },
    });
    insertPending(ctx);
    await ctx.jobs.keep("rev-1");
    expect(await ctx.jobs.discard("rev-1")).toEqual({ accepted: true });
    expect(ctx.store.getReview("rev-1")).toBeUndefined();
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    expect(existsSync(ctx.sidecarPath)).toBe(false);
  });
});
