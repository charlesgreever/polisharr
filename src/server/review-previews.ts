import { randomUUID } from "node:crypto";
import {
  nodeCanEncode,
  nodeCanPreview,
  nodeIsOnline,
  pickOpenPreviewNode,
  PREVIEW_LEASE_MS,
  PREVIEW_LEASE_SAFETY_MARGIN_MS,
  PREVIEW_MAX_GLOBAL,
  PREVIEW_MAX_PER_NODE,
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_SDR_1080P_PROFILE,
  encodeNeedFromPlan,
  parsePreviewRequest,
  type RemotePreviewDocument,
} from "./cluster.ts";
import { canonicalFilePath, readFileRevision } from "./file-revision.ts";
import { isIsoPath } from "./inspect.ts";
import type { Store } from "./store.ts";
import type {
  PreviewAdmissionKind,
  PreviewTask,
  PreviewTaskStatus,
  PreviewWaitReason,
} from "./types.ts";
import {
  admitNodeWork,
  PLAYBACK_ALLOWED,
  type PlaybackDecision,
} from "./playback-policy.ts";

export const NO_PREVIEW_NODE = "No encode node can generate H.264 preview clips.";
export const PREVIEW_LEASE_INVALID = "That preview lease is not valid.";
export const PREVIEW_PUBLICATION_REVOKED = "Preview publication was withdrawn.";
export const PREVIEW_REVIEW_BUSY = "This result is being replaced or discarded.";
export const PREVIEW_REVIEW_GONE = "That review item is gone.";
export const PREVIEW_ISO_UNAVAILABLE = "ISO sources cannot generate preview clips in this release.";

export type PreviewRendererControl = {
  isCancelled: () => boolean;
  onProgress: (progress: number) => void;
  registerChild: (child: { kill: (signal?: NodeJS.Signals | number) => boolean | void }) => void;
};

export type PreviewRenderer = (
  task: RemotePreviewDocument,
  control: PreviewRendererControl,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export async function stubPreviewRenderer(): Promise<{ ok: true }> {
  return { ok: true };
}

export type PreviewPlaybackGate = {
  nodeAdmission(nodeId: string): PlaybackDecision;
  blockedNodeIds(): string[];
};

export type PreviewCoordinator = {
  runningCountOnNode(nodeId: string): number;
  shouldDeferOptimize(nodeId: string): boolean;
  recordAdmission(nodeId: string, kind: PreviewAdmissionKind): void;
  revokeAndCancel(reviewId: string): void;
  withdrawAndWait(reviewId: string): Promise<void>;
  forgetReview(reviewId: string): void;
  expire(): void;
};

export type PreviewServiceOptions = {
  store: Store;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  playback?: PreviewPlaybackGate;
  isMutating?: (path: string) => boolean;
  cacheFits?: () => boolean;
  renderer?: PreviewRenderer;
  localNodeId?: () => string;
};

export function nextAdmissionKind(input: {
  lastKind: PreviewAdmissionKind | null;
  previewWaiting: boolean;
  optimizeWaiting: boolean;
}): PreviewAdmissionKind | null {
  if (!input.previewWaiting && !input.optimizeWaiting) return null;
  if (!input.previewWaiting) return "optimize";
  if (!input.optimizeWaiting) return "preview";
  if (input.lastKind === "preview") return "optimize";
  return "preview";
}

export class PreviewService {
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private localRunning = new Set<string>();

  constructor(private readonly opts: PreviewServiceOptions) {}

  start(): void {
    this.opts.store.expirePreviewLeases(this.now());
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  expire(): void {
    if (this.stopped) return;
    try {
      this.opts.store.expirePreviewLeases(this.now());
    } catch (error) {
      if (isClosedDb(error)) return;
      throw error;
    }
  }

  runningCountOnNode(nodeId: string): number {
    return this.opts.store.runningPreviewCountOnNode(nodeId);
  }

  hasQueuedWork(): boolean {
    return this.opts.store.queuedPreviewCount() > 0;
  }

  shouldDeferOptimize(nodeId: string): boolean {
    return this.nextKindForNode(nodeId) === "preview";
  }

  shouldDeferPreview(nodeId: string): boolean {
    return this.nextKindForNode(nodeId) === "optimize";
  }

  recordAdmission(nodeId: string, kind: PreviewAdmissionKind): void {
    this.opts.store.recordAdmissionKind(nodeId, kind, this.now());
  }

  request(
    reviewId: string,
    rawRequest: unknown = {},
  ): { accepted: true; task: PreviewTask } | { error: string; status: number } {
    const review = this.opts.store.getReview(reviewId);
    if (!review) return { error: PREVIEW_REVIEW_GONE, status: 404 };
    if (review.status === "keeping" || review.status === "discarding") {
      return { error: PREVIEW_REVIEW_BUSY, status: 409 };
    }
    if (isIsoPath(review.sourcePath)) {
      const id = randomUUID();
      const now = this.now();
      this.opts.store.insertPreviewTask({
        id,
        reviewId,
        status: "failed",
        error: PREVIEW_ISO_UNAVAILABLE,
        request: parsePreviewRequest(rawRequest),
        createdAt: now,
      });
      return { accepted: true, task: this.opts.store.getPreviewTask(id)! };
    }
    const request = parsePreviewRequest(rawRequest);
    const sourceRevision = readFileRevision(review.sourcePath);
    const sidecarRevision = readFileRevision(review.sidecarPath);
    const id = randomUUID();
    const now = this.now();
    if (!this.hasCapablePreviewNode(now)) {
      this.opts.store.insertPreviewTask({
        id,
        reviewId,
        status: "failed",
        error: NO_PREVIEW_NODE,
        request,
        sourceRevision,
        sidecarRevision,
        createdAt: now,
      });
      return { accepted: true, task: this.opts.store.getPreviewTask(id)! };
    }
    this.opts.store.insertPreviewTask({
      id,
      reviewId,
      request,
      sourceRevision,
      sidecarRevision,
      createdAt: now,
    });
    this.refreshQueuedWaitReasons();
    void this.tick();
    return { accepted: true, task: this.opts.store.getPreviewTask(id)! };
  }

  cancel(id: string): { ok: true } | { error: string; status: number } {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return { error: "That preview task does not exist.", status: 404 };
    if (task.status === "ready" || task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
      return { error: "Finished preview tasks cannot be cancelled.", status: 409 };
    }
    const now = this.now();
    if (task.status === "queued") {
      this.opts.store.updatePreviewTask(id, { status: "cancelled", waitReason: null, updatedAt: now });
      this.opts.store.releasePreviewReservations(id);
    } else {
      this.opts.store.updatePreviewTask(id, { status: "cancelled", waitReason: null, updatedAt: now });
    }
    return { ok: true };
  }

  status(id: string): (PreviewTask & { nodeName: string | null }) | undefined {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return undefined;
    const node = task.nodeId ? this.opts.store.getNode(task.nodeId) : undefined;
    return { ...task, nodeName: node?.name ?? null };
  }

  claimForNode(nodeId: string, freeSlots: number): RemotePreviewDocument[] {
    this.expire();
    this.refreshQueuedWaitReasons();
    if (freeSlots <= 0) return [];
    const node = this.opts.store.getNode(nodeId);
    if (!node?.enabled || !nodeCanPreview(node)) return [];
    if (this.shouldDeferPreview(nodeId)) return [];
    if (!this.canAdmitPreviewOn(nodeId)) return [];
    const queued = this.opts.store.queuedPreviewTasks()[0];
    if (!queued) return [];
    const review = this.opts.store.getReview(queued.reviewId);
    if (!review) {
      this.opts.store.updatePreviewTask(queued.id, { status: "expired", error: PREVIEW_REVIEW_GONE, updatedAt: this.now() });
      return this.claimForNode(nodeId, freeSlots);
    }
    if (this.opts.isMutating?.(canonicalFilePath(review.sourcePath)) || this.opts.isMutating?.(canonicalFilePath(review.sidecarPath))) {
      this.opts.store.updatePreviewTask(queued.id, { waitReason: "input_lock", updatedAt: this.now() });
      return [];
    }
    if (this.opts.cacheFits && !this.opts.cacheFits()) {
      this.opts.store.updatePreviewTask(queued.id, { waitReason: "cache_capacity", updatedAt: this.now() });
      return [];
    }
    const claimed = this.opts.store.claimQueuedPreview(
      nodeId,
      this.now(),
      PREVIEW_LEASE_MS,
      { sourcePath: canonicalFilePath(review.sourcePath), sidecarPath: canonicalFilePath(review.sidecarPath) },
    );
    if (!claimed) return [];
    this.recordAdmission(nodeId, "preview");
    const leaseUntil = claimed.leaseUntil ?? this.now() + PREVIEW_LEASE_MS;
    return [{
      kind: "preview",
      protocolVersion: PREVIEW_PROTOCOL_VERSION,
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      leaseUntil,
      reviewId: claimed.reviewId,
      sourcePath: review.sourcePath,
      sidecarPath: review.sidecarPath,
      request: claimed.request,
      profileId: PREVIEW_SDR_1080P_PROFILE,
      nodeId,
    }];
  }

  progress(
    id: string,
    leaseToken: string,
    progress: number | null,
  ): { ok: true } | { cancelled: true } | { error: string; status: number } {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return { error: "That preview task does not exist.", status: 404 };
    if (task.status === "cancelled") return { cancelled: true };
    if (!task.publicationAllowed) return { error: PREVIEW_PUBLICATION_REVOKED, status: 409 };
    if (!this.opts.store.previewLeaseMatches(id, leaseToken)) return { error: PREVIEW_LEASE_INVALID, status: 409 };
    if (task.status !== "running") return { error: PREVIEW_LEASE_INVALID, status: 409 };
    this.opts.store.renewPreviewLeases(task.nodeId ?? "", [id], this.now() + PREVIEW_LEASE_MS);
    if (progress != null) this.opts.store.updatePreviewTask(id, { updatedAt: this.now() });
    return { ok: true };
  }

  complete(id: string, leaseToken: string): { ok: true } | { cancelled: true } | { error: string; status: number } {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return { error: "That preview task does not exist.", status: 404 };
    if (task.status === "cancelled" || !task.publicationAllowed) {
      return { error: PREVIEW_PUBLICATION_REVOKED, status: 409 };
    }
    if (task.status === "ready") {
      this.opts.store.releasePreviewReservations(id);
      return { ok: true };
    }
    if (!this.opts.store.previewLeaseMatches(id, leaseToken)) return { error: PREVIEW_LEASE_INVALID, status: 409 };
    if (task.status !== "running") return { error: PREVIEW_LEASE_INVALID, status: 409 };
    this.opts.store.updatePreviewTask(id, {
      status: "ready",
      waitReason: null,
      leaseToken: null,
      leaseUntil: null,
      error: null,
      updatedAt: this.now(),
    });
    this.opts.store.releasePreviewReservations(id);
    return { ok: true };
  }

  fail(id: string, leaseToken: string, error: string): { ok: true } | { cancelled: true } | { error: string; status: number } {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return { error: "That preview task does not exist.", status: 404 };
    if (task.status === "cancelled") {
      this.opts.store.releasePreviewReservations(id);
      return { cancelled: true };
    }
    if (!this.opts.store.previewLeaseMatches(id, leaseToken)) {
      return { error: PREVIEW_LEASE_INVALID, status: 409 };
    }
    this.opts.store.updatePreviewTask(id, {
      status: "failed",
      error,
      waitReason: null,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: this.now(),
    });
    this.opts.store.releasePreviewReservations(id);
    return { ok: true };
  }

  revokeAndCancel(reviewId: string): void {
    const now = this.now();
    this.opts.store.revokePreviewPublication(reviewId, now);
    this.opts.store.cancelPreviewTasksForReview(reviewId, now);
  }

  async withdrawAndWait(reviewId: string): Promise<void> {
    this.revokeAndCancel(reviewId);
    const now = this.now();
    const deadline = this.opts.store.readerWaitDeadline(reviewId, now, PREVIEW_LEASE_SAFETY_MARGIN_MS);
    const sleep = this.opts.sleep ?? defaultSleep;
    while (this.opts.store.reservationsForReview(reviewId).length > 0) {
      if (this.now() >= deadline) {
        for (const row of this.opts.store.reservationsForReview(reviewId)) {
          this.opts.store.releasePreviewReservations(row.taskId);
        }
        break;
      }
      await sleep(25);
    }
  }

  forgetReview(reviewId: string): void {
    this.opts.store.deletePreviewTasksForReview(reviewId);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      this.expire();
      this.refreshQueuedWaitReasons();
      const localId = this.localNodeId();
      const local = this.opts.store.getNode(localId);
      if (!local?.enabled || !nodeCanPreview(local)) return;
      if (this.localRunning.size >= Math.max(1, local.concurrency)) return;
      const docs = this.claimForNode(localId, 1);
      for (const doc of docs) void this.runLocal(doc);
    } catch (error) {
      if (this.stopped || isClosedDb(error)) return;
      throw error;
    }
  }

  private async runLocal(doc: RemotePreviewDocument): Promise<void> {
    if (this.localRunning.has(doc.id)) return;
    this.localRunning.add(doc.id);
    const renderer = this.opts.renderer ?? stubPreviewRenderer;
    try {
      const result = await renderer(doc, {
        isCancelled: () => this.opts.store.getPreviewTask(doc.id)?.status === "cancelled",
        onProgress: (progress) => {
          void this.progress(doc.id, doc.leaseToken, progress);
        },
        registerChild: () => undefined,
      });
      const latest = this.opts.store.getPreviewTask(doc.id);
      if (!latest || latest.status === "cancelled" || !latest.publicationAllowed) {
        this.opts.store.releasePreviewReservations(doc.id);
        return;
      }
      if (result.ok) this.complete(doc.id, doc.leaseToken);
      else this.fail(doc.id, doc.leaseToken, result.error);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The preview failed.";
      this.fail(doc.id, doc.leaseToken, message);
    } finally {
      this.localRunning.delete(doc.id);
    }
  }

  private nextKindForNode(nodeId: string): PreviewAdmissionKind | null {
    const previewWaiting = this.canAdmitPreviewOn(nodeId) && this.hasQueuedWork();
    const optimizeWaiting = this.hasQueuedOptimizeForNode(nodeId);
    return nextAdmissionKind({
      lastKind: this.opts.store.lastAdmissionKind(nodeId),
      previewWaiting,
      optimizeWaiting,
    });
  }

  private canAdmitPreviewOn(nodeId: string): boolean {
    const node = this.opts.store.getNode(nodeId);
    if (!node?.enabled || !nodeCanPreview(node)) return false;
    if (!nodeIsOnline(node.lastSeen, this.now()) && nodeId !== this.localNodeId()) return false;
    if (this.opts.store.runningPreviewCountOnNode(nodeId) >= PREVIEW_MAX_PER_NODE) return false;
    if (this.opts.store.runningPreviewCount() >= PREVIEW_MAX_GLOBAL) return false;
    const admission = admitNodeWork({
      decision: this.opts.playback?.nodeAdmission(nodeId) ?? PLAYBACK_ALLOWED,
      runningCount: this.opts.store.runningCountOnNode(nodeId),
      concurrency: node.concurrency,
    });
    return admission.allowed;
  }

  private hasCapablePreviewNode(now: number): boolean {
    return this.opts.store.listNodes().some(
      (node) => node.enabled && nodeCanPreview(node) && (nodeIsOnline(node.lastSeen, now) || node.id === this.localNodeId()),
    );
  }

  private hasQueuedOptimizeForNode(nodeId: string): boolean {
    const node = this.opts.store.getNode(nodeId);
    for (const job of this.opts.store.listJobs()) {
      if (job.status !== "queued") continue;
      if (job.assignedNodeId && job.assignedNodeId !== nodeId) continue;
      if (!job.assignedNodeId && node && !nodeCanEncode(node, encodeNeedFromPlan("video" in job.plan ? job.plan : null))) continue;
      return true;
    }
    return false;
  }

  private refreshQueuedWaitReasons(): void {
    const now = this.now();
    const blocked = new Set(this.opts.playback?.blockedNodeIds() ?? []);
    const nodes = this.opts.store.listNodes().map((node) => ({
      ...node,
      runningCount: this.opts.store.runningCountOnNode(node.id),
      previewRunning: this.opts.store.runningPreviewCountOnNode(node.id),
      preview: node.preview ?? null,
    }));
    for (const task of this.opts.store.queuedPreviewTasks()) {
      const review = this.opts.store.getReview(task.reviewId);
      if (!review) {
        this.opts.store.updatePreviewTask(task.id, { status: "expired", error: PREVIEW_REVIEW_GONE, updatedAt: now });
        continue;
      }
      let reason: PreviewWaitReason = "node";
      if (this.opts.isMutating?.(canonicalFilePath(review.sourcePath)) || this.opts.isMutating?.(canonicalFilePath(review.sidecarPath))) {
        reason = "input_lock";
      } else if (this.opts.cacheFits && !this.opts.cacheFits()) {
        reason = "cache_capacity";
      } else if (this.opts.store.runningPreviewCount() >= PREVIEW_MAX_GLOBAL) {
        reason = "node";
      } else {
        const open = pickOpenPreviewNode(nodes, now, blocked);
        if (!open) {
          const capable = nodes.filter((node) => node.enabled && nodeCanPreview(node) && nodeIsOnline(node.lastSeen, now));
          reason = capable.length > 0 && capable.every((node) => blocked.has(node.id)) ? "playback" : "node";
        } else {
          continue;
        }
      }
      if (task.waitReason !== reason) this.opts.store.updatePreviewTask(task.id, { waitReason: reason, updatedAt: now });
    }
  }

  private localNodeId(): string {
    return this.opts.localNodeId?.() ?? this.opts.store.localNodeId();
  }

  private now(): number {
    return this.opts.clock?.() ?? Date.now();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isClosedDb(error: unknown): boolean {
  return error instanceof TypeError && String(error.message).includes("database connection is not open");
}

export function publicPreviewStatus(task: PreviewTask, nodeName: string | null): {
  id: string;
  reviewId: string;
  status: PreviewTaskStatus;
  waitReason: PreviewWaitReason | null;
  nodeId: string | null;
  nodeName: string | null;
  error: string | null;
} {
  return {
    id: task.id,
    reviewId: task.reviewId,
    status: task.status,
    waitReason: task.waitReason,
    nodeId: task.nodeId,
    nodeName,
    error: task.error,
  };
}
