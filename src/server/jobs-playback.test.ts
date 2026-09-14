import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService, type JobPlaybackGate } from "./jobs.ts";
import type { Optimizer } from "./optimize.ts";
import { PLAYBACK_ALLOWED, type PlaybackDecision } from "./playback-policy.ts";
import { Store } from "./store.ts";
import type { ExecutablePlan, InspectionReport } from "./types.ts";

const stores: Store[] = [];
const services: JobService[] = [];

afterEach(() => {
  for (const jobs of services) jobs.stop();
  services.length = 0;
  for (const store of stores) store.close();
  stores.length = 0;
});

const blocked: PlaybackDecision = {
  allowed: false,
  reason: "playing",
  connectionIds: ["jf"],
  connectionNames: ["Living Room"],
  observedAt: 1_000,
};

function gate(blockedIds: string[]): JobPlaybackGate {
  return {
    nodeAdmission: (nodeId) => blockedIds.includes(nodeId) ? blocked : PLAYBACK_ALLOWED,
    blockedNodeIds: () => blockedIds,
  };
}

function hardware() {
  return { backend: "cuda" as const, cuda: true, vaapi: false, av1: false, reason: null };
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

function report(path: string): InspectionReport {
  return {
    sourceSig: `${path}|8`,
    sourceMethod: "ffprobe",
    listingState: "complete",
    durationSec: 60,
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
  };
}

function harness(opts: { playback?: JobPlaybackGate; offPeak?: boolean; optimizer?: Optimizer } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opt-play-jobs-"));
  const store = new Store(join(dir, "polisharr.db"));
  stores.push(store);
  store.saveSettings({
    ...store.getSettings(),
    reviewPath: dir,
    offPeakEnabled: opts.offPeak === true,
    offPeakStart: "00:00",
    offPeakEnd: "00:00",
    defaultEncodeNodeId: "local",
  });
  store.upsertNode({
    id: "local", name: "This machine", role: "standalone", lastSeen: Date.now(),
    hardware: hardware(), concurrency: 1, enabled: true, version: "1", currentJobId: null,
  });
  store.upsertNode({
    id: "worker-1", name: "5090", role: "worker", lastSeen: Date.now(),
    hardware: hardware(), concurrency: 1, enabled: true, version: "1", currentJobId: null,
  });
  const instanceId = store.upsertInstance({ kind: "radarr", name: "Radarr", url: "http://radarr", secret: null, enabled: true });
  const addItem = (arrId: number) => {
    const itemId = `${instanceId}:movie:${arrId}`;
    const sourcePath = join(dir, `movie-${arrId}.mkv`);
    writeFileSync(sourcePath, "ORIGINAL");
    store.upsertItem({
      id: itemId, instanceId, arrId, arrSeriesId: null, arrEpisodeFileId: null, type: "movie",
      title: `Film ${arrId}`, showTitle: null, season: null, episode: null, episodeTitle: null, path: sourcePath,
      sizeBytes: 8, quality: "HD", resolution: "1080", profile: "HD", tags: [], posterRemoteUrl: null, sizeExempt: false,
    });
    store.saveInspection(itemId, report(sourcePath));
    return { itemId, sourcePath };
  };
  const first = addItem(10);
  const jobs = new JobService({
    store,
    optimizer: opts.optimizer ?? (async () => ({ sidecarPath: join(dir, "sidecar.mkv"), output: report(first.sourcePath) })),
    hardware: async () => hardware(),
    tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
    decrypt: () => "",
    fetch: (async () => new Response("{}")) as typeof fetch,
    reinspectChangedItem: async () => ({ ok: true }),
    localNodeId: () => "local",
    playback: opts.playback,
  });
  services.push(jobs);
  return { store, jobs, itemId: first.itemId, dir, addItem };
}

describe("playback job admission", () => {
  it("does not start a local job or issue a remote lease while a mapped node is blocked", async () => {
    const { store, jobs, itemId, addItem } = harness({ playback: gate(["local", "worker-1"]) });
    const local = jobs.enqueueCustom(itemId, copyPlan(), { assignedNodeId: "local" });
    expect("id" in local).toBe(true);
    if (!("id" in local)) return;
    jobs.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(store.getJob(local.id)?.status).toBe("queued");
    const remoteItem = addItem(11);
    const remote = jobs.enqueueCustom(remoteItem.itemId, copyPlan(), { assignedNodeId: "worker-1" });
    expect("id" in remote).toBe(true);
    if (!("id" in remote)) return;
    expect(jobs.claimForNode("worker-1", 1)).toEqual([]);
    expect(store.getJob(remote.id)?.status).toBe("queued");
    expect(store.getJob(local.id)?.assignedNodeId).toBe("local");
    expect(store.getJob(remote.id)?.assignedNodeId).toBe("worker-1");
  });

  it("lets an unassigned job use an unblocked node and does not move a pinned job", () => {
    const { store, jobs, itemId, addItem } = harness({ playback: gate(["worker-1"]) });
    store.saveSettings({ ...store.getSettings(), defaultEncodeNodeId: "any" });
    const pinned = jobs.enqueueCustom(itemId, copyPlan(), { assignedNodeId: "worker-1" });
    expect("id" in pinned).toBe(true);
    if (!("id" in pinned)) return;
    expect(store.getJob(pinned.id)?.assignedNodeId).toBe("worker-1");
    expect(jobs.claimForNode("worker-1", 1)).toEqual([]);
    expect(store.getJob(pinned.id)).toMatchObject({ status: "queued", assignedNodeId: "worker-1" });
    const other = addItem(11);
    const pool = jobs.enqueueCustom(other.itemId, copyPlan(), { assignedNodeId: "any" });
    expect("id" in pool).toBe(true);
    if (!("id" in pool)) return;
    expect(store.getJob(pool.id)?.assignedNodeId).toBe("local");
  });

  it("does not let Run now bypass playback protection, and still respects off-peak and pause", async () => {
    const { store, jobs, itemId } = harness({ playback: gate(["local"]), offPeak: true });
    const queued = jobs.enqueueCustom(itemId, copyPlan(), { assignedNodeId: "local" });
    expect("id" in queued).toBe(true);
    if (!("id" in queued)) return;
    jobs.start();
    await vi.waitFor(() => expect(store.getJob(queued.id)?.status).toBe("held"));
    store.updateJob(queued.id, { runNow: true, status: "queued", phase: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(store.getJob(queued.id)?.status).toBe("queued");
    store.updateJob(queued.id, { status: "paused", phase: "paused" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(store.getJob(queued.id)?.status).toBe("paused");
  });

  it("lets a running job finish after playback starts blocking the node", async () => {
    let release: (() => void) | undefined;
    const blockedIds = { current: [] as string[] };
    const { store, jobs, itemId, dir } = harness({
      playback: {
        nodeAdmission: (nodeId) => blockedIds.current.includes(nodeId) ? blocked : PLAYBACK_ALLOWED,
        blockedNodeIds: () => blockedIds.current,
      },
      optimizer: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const sidecarPath = join(dir, "sidecar.mkv");
        writeFileSync(sidecarPath, "NEW");
        return { sidecarPath, output: report(join(dir, "movie-10.mkv")) };
      },
    });
    jobs.start();
    const queued = jobs.enqueueCustom(itemId, copyPlan(), { assignedNodeId: "local" });
    expect("id" in queued).toBe(true);
    if (!("id" in queued)) return;
    await vi.waitFor(() => expect(store.getJob(queued.id)?.status).toBe("running"));
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    blockedIds.current = ["local"];
    release?.();
    await vi.waitFor(() => expect(store.getJob(queued.id)?.status).toBe("succeeded"));
  });

  it("cancels a waiting job while playback holds the node", () => {
    const { store, jobs, itemId } = harness({ playback: gate(["local"]) });
    const queued = jobs.enqueueCustom(itemId, copyPlan(), { assignedNodeId: "local" });
    expect("id" in queued).toBe(true);
    if (!("id" in queued)) return;
    expect(jobs.cancel(queued.id)).toEqual({ ok: true });
    expect(store.getJob(queued.id)?.status).toBe("cancelled");
  });
});
