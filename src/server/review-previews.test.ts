import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_LEASE_MS, PREVIEW_LEASE_SAFETY_MARGIN_MS, PREVIEW_PROTOCOL_VERSION, PREVIEW_SDR_1080P_PROFILE } from "./cluster.ts";
import { JobService, type JobPlaybackGate } from "./jobs.ts";
import { PLAYBACK_ALLOWED, type PlaybackDecision } from "./playback-policy.ts";
import {
  PREVIEW_CACHE_MAX_BYTES,
  PREVIEW_CACHE_TTL_MS,
  PREVIEW_FINISHED_FILE,
  PREVIEW_HDR_UNAVAILABLE,
  PREVIEW_ORIGINAL_FILE,
  PREVIEW_PUBLISHED_MARKER,
  type PreviewMediaInfo,
} from "./preview-render.ts";
import { previewDirBytes, previewPairDir } from "./optimize.ts";
import {
  nextAdmissionKind,
  NO_PREVIEW_NODE,
  PREVIEW_CACHE_CLEANUP_WARNING,
  PREVIEW_LEASE_INVALID,
  PREVIEW_PUBLICATION_REVOKED,
  PREVIEW_STALE,
  PreviewService,
} from "./review-previews.ts";
import { Store } from "./store.ts";
import type { PreviewCapability } from "./cluster.ts";
import type { ExecutablePlan, InspectionReport, ReviewItem } from "./types.ts";

const stores: Store[] = [];
const services: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const svc of services) svc.stop();
  services.length = 0;
  for (const store of stores) store.close();
  stores.length = 0;
});

const previewCap: PreviewCapability = {
  protocolVersion: PREVIEW_PROTOCOL_VERSION,
  h264Encoder: "h264_nvenc",
  profiles: [PREVIEW_SDR_1080P_PROFILE],
};

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
    audio: [{ index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false, default: true }],
    subtitles: [],
    hasChapters: false,
    hasAttachments: false,
  };
}

function copyPlan(): ExecutablePlan {
  return {
    origin: "custom",
    video: { kind: "copy" },
    audio: [],
    subtitles: [],
    container: "mkv",
    writeMode: "sidecar",
    warning: null,
    reasons: ["Copy tracks."],
    estimatedOutputBytes: 3,
    category: "movie1080p",
  };
}

function sdrMedia(over: Partial<PreviewMediaInfo> = {}): PreviewMediaInfo {
  return {
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    sarNum: 1,
    sarDen: 1,
    hdr: "none",
    videoIndex: 0,
    audio: [
      { index: 1, language: "eng", channels: 6, codec: "ac3", default: true },
      { index: 2, language: "eng", channels: 2, codec: "aac", default: false },
    ],
    hasVideo: true,
    ...over,
  };
}

function publishPair(reviewPath: string, taskId: string, original = "orig-bytes", finished = "fin-bytes"): void {
  const dir = previewPairDir(reviewPath, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PREVIEW_ORIGINAL_FILE), original);
  writeFileSync(join(dir, PREVIEW_FINISHED_FILE), finished);
  writeFileSync(join(dir, PREVIEW_PUBLISHED_MARKER), "");
}

function harness(opts: {
  playback?: JobPlaybackGate;
  clock?: () => number;
  cacheFits?: () => boolean;
  isMutating?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  probeMedia?: (path: string) => Promise<PreviewMediaInfo>;
  removePairDir?: (dir: string) => Promise<boolean>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opt-preview-"));
  const store = new Store(join(dir, "polisharr.db"));
  stores.push(store);
  store.saveSettings({ ...store.getSettings(), reviewPath: dir, concurrency: 1 });
  store.upsertNode({
    id: "master",
    name: "homeserver",
    role: "master",
    lastSeen: 1_000,
    hardware: { backend: "none", cuda: false, vaapi: false, av1: false, reason: "No GPU." },
    concurrency: 1,
    enabled: true,
    version: "1",
    currentJobId: null,
    preview: null,
  });
  store.upsertNode({
    id: "worker-1",
    name: "5090",
    role: "worker",
    lastSeen: 1_000,
    hardware: { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null },
    concurrency: 1,
    enabled: true,
    version: "1",
    currentJobId: null,
    preview: previewCap,
  });
  store.upsertNode({
    id: "old-worker",
    name: "old",
    role: "worker",
    lastSeen: 1_000,
    hardware: { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null },
    concurrency: 1,
    enabled: true,
    version: "1",
    currentJobId: null,
    preview: null,
  });
  const instanceId = store.upsertInstance({ kind: "radarr", name: "Radarr", url: "http://radarr", secret: "enc", enabled: true });
  const itemId = `${instanceId}:movie:10`;
  const sourcePath = join(dir, "movie.mkv");
  const sidecarPath = join(dir, "sidecar.mkv");
  writeFileSync(sourcePath, "ORIGINAL!");
  writeFileSync(sidecarPath, "SIDECAR!!!");
  store.upsertItem({
    id: itemId, instanceId, arrId: 10, arrSeriesId: null, arrEpisodeFileId: null, type: "movie",
    title: "Film", showTitle: null, season: null, episode: null, episodeTitle: null, path: sourcePath,
    sizeBytes: 9, quality: "HD", resolution: "1080", profile: "HD", tags: [], posterRemoteUrl: null, sizeExempt: false,
  });
  store.saveInspection(itemId, reportFor(sourcePath, 9));
  store.insertJob({
    id: "job-1", itemId, suggestionId: null, status: "succeeded", phase: "idle", progress: 1,
    error: null, warning: null, runNow: false, createdAt: 1, plan: copyPlan(),
  });
  store.insertReview({
    id: "rev-1", jobId: "job-1", itemId, displayTitle: "Film", status: "pending", flagged: false, flagReason: null,
    sourcePath, sidecarPath, ...compare(9, 10), error: null,
  });
  const previews = new PreviewService({
    store,
    clock: opts.clock ?? (() => 1_000),
    sleep: opts.sleep,
    playback: opts.playback,
    isMutating: opts.isMutating,
    cacheFits: opts.cacheFits,
    localNodeId: () => "master",
    probeMedia: opts.probeMedia ?? (async () => sdrMedia()),
    reviewPath: () => dir,
    removePairDir: opts.removePairDir,
  });
  services.push(previews);
  const jobs = new JobService({
    store,
    optimizer: async () => ({ sidecarPath, output: reportFor(sidecarPath, 10) }),
    hardware: async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null }),
    tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
    decrypt: () => "key",
    fetch: (async () => new Response("{}", { status: 201 })) as typeof fetch,
    reinspectChangedItem: async () => ({ ok: true as const }),
    clock: opts.clock ?? (() => 1_000),
    playback: opts.playback,
    localNodeId: () => "master",
    sleep: opts.sleep,
  });
  jobs.attachPreviews(previews);
  services.push(jobs);
  return { dir, store, jobs, previews, itemId, sourcePath, sidecarPath };
}

describe("preview admission preference", () => {
  it("prefers one preview then ordinary work so queued encodes are not starved", () => {
    expect(nextAdmissionKind({ lastKind: null, previewWaiting: true, optimizeWaiting: true })).toBe("preview");
    expect(nextAdmissionKind({ lastKind: "preview", previewWaiting: true, optimizeWaiting: true })).toBe("optimize");
    expect(nextAdmissionKind({ lastKind: "optimize", previewWaiting: true, optimizeWaiting: true })).toBe("preview");
    expect(nextAdmissionKind({ lastKind: "preview", previewWaiting: true, optimizeWaiting: false })).toBe("preview");
  });
});

describe("preview task lifecycle", () => {
  it("queues a preview with its own id and fails closed when no H.264 node exists", async () => {
    const ctx = harness();
    ctx.store.deleteNode("worker-1");
    const result = await ctx.previews.request("rev-1");
    expect("accepted" in result).toBe(true);
    if (!("accepted" in result)) return;
    expect(result.task.id).not.toBe("job-1");
    expect(result.task.status).toBe("failed");
    expect(result.task.error).toBe(NO_PREVIEW_NODE);
    expect(ctx.store.workSummary().queued).toBe(0);
    expect(ctx.store.workSummary().review).toBe(1);
    expect(ctx.store.historyPage(0, 10).total).toBe(0);
  });

  it("dispatches a GPU-less master to a capable worker and withholds work from an old worker", async () => {
    const ctx = harness();
    const requested = await ctx.previews.request("rev-1");
    expect("accepted" in requested).toBe(true);
    if (!("accepted" in requested)) return;
    expect(requested.task.status).toBe("queued");
    expect(ctx.previews.claimForNode("old-worker", 1)).toEqual([]);
    const claimed = ctx.previews.claimForNode("worker-1", 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe("preview");
    expect(claimed[0]?.id).toBe(requested.task.id);
    expect(claimed[0]?.id).not.toBe("job-1");
    expect(ctx.previews.status(requested.task.id)).toMatchObject({
      status: "running",
      nodeId: "worker-1",
      nodeName: "5090",
    });
    expect(ctx.store.runningCountOnNode("worker-1")).toBe(1);
    expect(ctx.store.reservationsForReview("rev-1")).toHaveLength(2);
  });

  it("shares node slots with encodes and limits one pair per node and two globally", async () => {
    const ctx = harness();
    ctx.store.upsertNode({
      ...ctx.store.getNode("worker-1")!,
      concurrency: 1,
      lastSeen: 1_000,
      preview: previewCap,
    });
    ctx.store.insertJob({
      id: "job-queued", itemId: ctx.itemId, suggestionId: null, status: "queued", phase: "queued", progress: 0,
      error: null, warning: null, runNow: true, createdAt: 2, plan: copyPlan(), assignedNodeId: "worker-1",
    });
    const first = await ctx.previews.request("rev-1", { startMs: 0 });
    if (!("accepted" in first)) return;
    expect(ctx.jobs.claimForNode("worker-1", 1)).toHaveLength(0);
    expect(ctx.previews.claimForNode("worker-1", 1)).toHaveLength(1);
    expect(ctx.previews.claimForNode("worker-1", 1)).toHaveLength(0);
    expect(ctx.jobs.claimForNode("worker-1", 1)).toHaveLength(0);

    ctx.store.upsertNode({
      id: "worker-2", name: "4070", role: "worker", lastSeen: 1_000,
      hardware: { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null },
      concurrency: 1, enabled: true, version: "1", currentJobId: null, preview: previewCap,
    });
    ctx.store.upsertNode({
      id: "worker-3", name: "a770", role: "worker", lastSeen: 1_000,
      hardware: { backend: "vaapi", cuda: false, vaapi: true, av1: false, reason: null },
      concurrency: 1, enabled: true, version: "1", currentJobId: null, preview: previewCap,
    });
    const second = await ctx.previews.request("rev-1", { startMs: 1_000 });
    const third = await ctx.previews.request("rev-1", { startMs: 2_000 });
    if (!("accepted" in second) || !("accepted" in third)) return;
    expect(ctx.previews.claimForNode("worker-2", 1)).toHaveLength(1);
    expect(ctx.store.runningPreviewCount()).toBe(2);
    expect(ctx.previews.claimForNode("worker-3", 1)).toHaveLength(0);
    const leftover = ctx.store.queuedPreviewTasks();
    expect(leftover).toHaveLength(1);
    expect(leftover[0]?.waitReason).toBe("node");
  });

  it("holds preview dispatch during playback and reports the playback wait reason", async () => {
    const ctx = harness({
      playback: {
        nodeAdmission: (nodeId) => nodeId === "worker-1" ? blockedPlay : PLAYBACK_ALLOWED,
        blockedNodeIds: () => ["worker-1"],
      },
    });
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    expect(ctx.previews.claimForNode("worker-1", 1)).toHaveLength(0);
    expect(ctx.store.getPreviewTask(requested.task.id)?.waitReason).toBe("playback");
  });

  it("waits for input lock or cache capacity instead of dispatching", async () => {
    const mutating = harness({ isMutating: () => true });
    const locked = await mutating.previews.request("rev-1");
    if (!("accepted" in locked)) return;
    expect(mutating.previews.claimForNode("worker-1", 1)).toHaveLength(0);
    expect(mutating.store.getPreviewTask(locked.task.id)?.waitReason).toBe("input_lock");

    const cache = harness({ cacheFits: () => false });
    const waiting = await cache.previews.request("rev-1");
    if (!("accepted" in waiting)) return;
    expect(cache.previews.claimForNode("worker-1", 1)).toHaveLength(0);
    expect(cache.store.getPreviewTask(waiting.task.id)?.waitReason).toBe("cache_capacity");
  });

  it("admits ordinary work after one preview when both wait", async () => {
    const ctx = harness();
    ctx.store.insertJob({
      id: "job-queued", itemId: ctx.itemId, suggestionId: null, status: "queued", phase: "queued", progress: 0,
      error: null, warning: null, runNow: true, createdAt: 2, plan: copyPlan(), assignedNodeId: "worker-1",
    });
    const first = await ctx.previews.request("rev-1");
    if (!("accepted" in first)) return;
    const previewDoc = ctx.previews.claimForNode("worker-1", 1);
    expect(previewDoc).toHaveLength(1);
    expect(ctx.jobs.claimForNode("worker-1", 1)).toHaveLength(0);
    publishPair(ctx.dir, first.task.id);
    expect(ctx.previews.complete(first.task.id, previewDoc[0]!.leaseToken)).toEqual({ ok: true });
    const second = await ctx.previews.request("rev-1");
    if (!("accepted" in second)) return;
    expect(ctx.previews.claimForNode("worker-1", 1)).toHaveLength(0);
    expect(ctx.jobs.claimForNode("worker-1", 1)).toHaveLength(1);
  });

  it("does not pin previews to an ordinary job's node", async () => {
    const ctx = harness();
    ctx.store.upsertNode({
      id: "worker-2", name: "4070", role: "worker", lastSeen: 1_000,
      hardware: { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null },
      concurrency: 1, enabled: true, version: "1", currentJobId: null, preview: previewCap,
    });
    ctx.store.updateJob("job-1", { status: "queued" });
    ctx.store.setJobAssignedNode("job-1", "worker-1");
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    const claimed = ctx.previews.claimForNode("worker-2", 1);
    expect(claimed[0]?.nodeId).toBe("worker-2");
  });

  it("rejects stale leases and revoked publication on late completion", async () => {
    let now = 1_000;
    const ctx = harness({ clock: () => now });
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    const claimed = ctx.previews.claimForNode("worker-1", 1);
    const token = claimed[0]!.leaseToken;
    now = 1_000 + PREVIEW_LEASE_MS + 1;
    ctx.previews.expire();
    expect(ctx.previews.complete(requested.task.id, token)).toMatchObject({ error: PREVIEW_LEASE_INVALID, status: 409 });
    expect(ctx.store.getPreviewTask(requested.task.id)?.status).toBe("failed");

    const again = await ctx.previews.request("rev-1");
    if (!("accepted" in again)) return;
    now = 1_000 + PREVIEW_LEASE_MS + 2;
    const claimedAgain = ctx.previews.claimForNode("worker-1", 1);
    ctx.previews.revokeAndCancel("rev-1");
    expect(ctx.previews.complete(again.task.id, claimedAgain[0]!.leaseToken)).toMatchObject({
      error: PREVIEW_PUBLICATION_REVOKED,
      status: 409,
    });
    expect(ctx.store.getPreviewTask(again.task.id)?.status).not.toBe("ready");
  });

  it("cancels a preview without cancelling the optimize job or changing Review counts", async () => {
    const ctx = harness();
    ctx.store.updateJob("job-1", { status: "succeeded" });
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    expect(ctx.previews.cancel(requested.task.id)).toEqual({ ok: true });
    expect(ctx.store.getPreviewTask(requested.task.id)?.status).toBe("cancelled");
    expect(ctx.store.getJob("job-1")?.status).toBe("succeeded");
    expect(ctx.store.workSummary().review).toBe(1);
    expect(ctx.store.historyPage(0, 10).total).toBe(0);
  });

  it("keeps original bytes after lease expiry until the master safety margin passes", async () => {
    let now = 1_000;
    const waiters: Array<() => void> = [];
    const ctx = harness({
      clock: () => now,
      sleep: () => new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
    });
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    ctx.previews.claimForNode("worker-1", 1);
    now = 1_000 + PREVIEW_LEASE_MS + 1;
    ctx.previews.expire();
    expect(ctx.store.getPreviewTask(requested.task.id)?.status).toBe("failed");
    expect(ctx.store.reservationsForReview("rev-1").length).toBeGreaterThan(0);
    const keep = ctx.jobs.keep("rev-1");
    await vi.waitFor(() => expect(waiters.length).toBeGreaterThan(0));
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    now = 1_000 + PREVIEW_LEASE_MS + PREVIEW_LEASE_SAFETY_MARGIN_MS + 1;
    for (const wake of waiters.splice(0)) wake();
    await vi.waitFor(() => expect(readFileSync(ctx.sourcePath, "utf8")).toBe("SIDECAR!!!"));
    await keep;
    expect(ctx.store.getReview("rev-1")).toBeUndefined();
  });

  it("waits through the preview lease and safety margin before Keep mutates source bytes", async () => {
    let now = 1_000;
    const ctx = harness({
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    ctx.previews.claimForNode("worker-1", 1);
    expect(ctx.store.reservationsForReview("rev-1").length).toBeGreaterThan(0);
    const keep = ctx.jobs.keep("rev-1");
    await vi.waitFor(() => expect(readFileSync(ctx.sourcePath, "utf8")).toBe("SIDECAR!!!"));
    await keep;
    expect(now).toBeGreaterThanOrEqual(1_000 + PREVIEW_LEASE_MS + PREVIEW_LEASE_SAFETY_MARGIN_MS);
    expect(ctx.store.getReview("rev-1")).toBeUndefined();
  });

  it("does not let Discard delete an input still held by an authorized reader until release", async () => {
    const waiters: Array<() => void> = [];
    const ctx = harness({
      sleep: () => new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
    });
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    const claimed = ctx.previews.claimForNode("worker-1", 1);
    const discarding = ctx.jobs.discard("rev-1");
    await vi.waitFor(() => expect(waiters.length).toBeGreaterThan(0));
    expect(readFileSync(ctx.sidecarPath, "utf8")).toBe("SIDECAR!!!");
    expect(ctx.store.getReview("rev-1")).toBeDefined();
    ctx.previews.fail(requested.task.id, claimed[0]!.leaseToken, "cancelled");
    for (const wake of waiters) wake();
    await discarding;
    expect(ctx.store.getReview("rev-1")).toBeUndefined();
  });

  it("reuses one task for the same interval and tracks, and makes a new pair when audio changes", async () => {
    const ctx = harness();
    const first = await ctx.previews.request("rev-1", { startMs: 1_000, originalAudioIndex: 1, sidecarAudioIndex: 1 });
    const again = await ctx.previews.request("rev-1", { startMs: 1_000, originalAudioIndex: 1, sidecarAudioIndex: 1 });
    if (!("accepted" in first) || !("accepted" in again)) return;
    expect(again.task.id).toBe(first.task.id);
    const other = await ctx.previews.request("rev-1", { startMs: 1_000, originalAudioIndex: 1, sidecarAudioIndex: 2 });
    if (!("accepted" in other)) return;
    expect(other.task.id).not.toBe(first.task.id);
  });

  it("returns 400 for an invalid timestamp and unavailable for HDR", async () => {
    const ctx = harness();
    const invalid = await ctx.previews.request("rev-1", { startMs: 60_000 });
    expect(invalid).toMatchObject({ status: 400 });
    const hdr = harness({ probeMedia: async () => sdrMedia({ hdr: "hdr10" }) });
    const blocked = await hdr.previews.request("rev-1");
    if (!("accepted" in blocked)) return;
    expect(blocked.task.status).toBe("failed");
    expect(blocked.task.error).toBe(PREVIEW_HDR_UNAVAILABLE);
  });

  it("serves published clips from a server-owned path and invalidates after a source change", async () => {
    const ctx = harness();
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    const claimed = ctx.previews.claimForNode("worker-1", 1);
    publishPair(ctx.dir, requested.task.id, "ORIGCLIP!!", "FINCLIP!!!");
    expect(ctx.previews.complete(requested.task.id, claimed[0]!.leaseToken)).toEqual({ ok: true });
    const clip = ctx.previews.openClip("rev-1", requested.task.id, "original");
    if ("error" in clip) throw new Error(clip.error);
    expect(readFileSync(clip.path, "utf8")).toBe("ORIGCLIP!!");
    clip.release();
    writeFileSync(ctx.sourcePath, "CHANGED!!");
    const stale = ctx.previews.openClip("rev-1", requested.task.id, "original");
    expect(stale).toMatchObject({ error: PREVIEW_STALE, status: 409 });
  });

  it("deletes a published pair after the lease expires and a late complete is rejected", async () => {
    let now = 1_000;
    const ctx = harness({ clock: () => now });
    const requested = await ctx.previews.request("rev-1");
    if (!("accepted" in requested)) return;
    const claimed = ctx.previews.claimForNode("worker-1", 1);
    publishPair(ctx.dir, requested.task.id);
    const pair = previewPairDir(ctx.dir, requested.task.id);
    now = 1_000 + PREVIEW_LEASE_MS + 1;
    ctx.previews.expire();
    expect(ctx.previews.complete(requested.task.id, claimed[0]!.leaseToken)).toMatchObject({
      error: PREVIEW_LEASE_INVALID,
      status: 409,
    });
    await vi.waitFor(() => expect(existsSync(pair)).toBe(false));
    expect(ctx.store.getPreviewTask(requested.task.id)?.bytes).toBe(0);
  });

  it("keeps cache accounting when pair files cannot be deleted", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    let now = 1_000;
    // Root in Docker can unlink a 0555 tree, so the test stubs the delete seam instead of chmod.
    const ctx = harness({ clock: () => now, removePairDir: async () => false });
    try {
      const requested = await ctx.previews.request("rev-1");
      if (!("accepted" in requested)) return;
      ctx.previews.claimForNode("worker-1", 1);
      publishPair(ctx.dir, requested.task.id, "0123456789", "abcdefghij");
      const pair = previewPairDir(ctx.dir, requested.task.id);
      now = 1_000 + PREVIEW_LEASE_MS + 1;
      ctx.previews.expire();
      await vi.waitFor(() => {
        expect(existsSync(pair)).toBe(true);
        expect(ctx.previews.cacheUsage()).toBeGreaterThanOrEqual(previewDirBytes(pair));
        expect(errors.some((row) => row.includes(PREVIEW_CACHE_CLEANUP_WARNING))).toBe(true);
      });
      ctx.store.updatePreviewTask(requested.task.id, { bytes: PREVIEW_CACHE_MAX_BYTES, updatedAt: now });
      const extra = await ctx.previews.request("rev-1", { startMs: 2_000 });
      if (!("accepted" in extra)) return;
      expect(ctx.previews.claimForNode("worker-1", 1)).toHaveLength(0);
      expect(ctx.store.getPreviewTask(extra.task.id)?.waitReason).toBe("cache_capacity");
    } finally {
      spy.mockRestore();
    }
  });

  it("evicts an expired idle pair before admitting another preview", async () => {
    let now = 1_000;
    const ctx = harness({ clock: () => now });
    const first = await ctx.previews.request("rev-1", { startMs: 0 });
    if (!("accepted" in first)) return;
    const claimed = ctx.previews.claimForNode("worker-1", 1);
    publishPair(ctx.dir, first.task.id);
    expect(ctx.previews.complete(first.task.id, claimed[0]!.leaseToken)).toEqual({ ok: true });
    now = 1_000 + PREVIEW_CACHE_TTL_MS + 1;
    ctx.store.upsertNode({ ...ctx.store.getNode("worker-1")!, lastSeen: now });
    const second = await ctx.previews.request("rev-1", { startMs: 2_000 });
    if (!("accepted" in second)) return;
    expect(ctx.previews.claimForNode("worker-1", 1)).toHaveLength(1);
    expect(ctx.store.getPreviewTask(first.task.id)?.status).toBe("expired");
    await vi.waitFor(() => expect(existsSync(previewPairDir(ctx.dir, first.task.id))).toBe(false));
  });

  it("retries an interrupted preview with its stored render plan after restart", async () => {
    const ctx = harness();
    const requested = await ctx.previews.request("rev-1", { startMs: 1_000, originalAudioIndex: 1, sidecarAudioIndex: 2 });
    if (!("accepted" in requested)) return;
    expect(ctx.previews.claimForNode("worker-1", 1)).toHaveLength(1);
    expect(ctx.store.getPreviewTask(requested.task.id)?.artifact).toBeTruthy();
    ctx.previews.start();
    expect(ctx.store.getPreviewTask(requested.task.id)?.status).toBe("queued");
    expect(ctx.store.getPreviewTask(requested.task.id)?.artifact).toMatchObject({
      originalAudioIndex: 1,
      sidecarAudioIndex: 2,
      interval: { startMs: 1_000, durationMs: 15_000 },
    });
    const claimed = ctx.previews.claimForNode("worker-1", 1);
    expect(claimed[0]?.render).toMatchObject({
      originalAudioIndex: 1,
      sidecarAudioIndex: 2,
      startMs: 1_000,
      durationMs: 15_000,
    });
  });
});
