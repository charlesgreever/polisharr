import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
  type PreviewRenderPlan,
  type RemotePreviewDocument,
} from "./cluster.ts";
import { canonicalFilePath, readFileRevision, revisionsMatch } from "./file-revision.ts";
import { isIsoPath } from "./inspect.ts";
import {
  PREVIEW_CACHE_MAX_BYTES,
  PREVIEW_CACHE_TTL_MS,
  PREVIEW_MAX_STREAM_PINS,
  PREVIEW_MIN_DURATION_MS,
  PREVIEW_MISSING_STREAMS,
  PREVIEW_PAIR_INCOMPLETE,
  PREVIEW_PAIR_RESERVE_BYTES,
  PREVIEW_SHORT_DURATION,
  defaultPreviewAudio,
  matchedPreviewSize,
  mediaFromInspection,
  normalizePreviewInterval,
  ownedPreviewPath,
  previewCacheKey,
  previewColorDecision,
  previewFileName,
  publishedPairBytesSync,
  publishedPairValidSync,
  resolvePreviewAudioIndex,
  revisionKey,
  transformLabels,
  type PreviewMediaInfo,
  type PreviewRenderer,
  type PreviewRendererControl,
} from "./preview-render.ts";
import { previewDirBytes, previewPairDir, previewRoot, removePreviewPairDir, sweepUnownedPreviewDirs } from "./optimize.ts";
import type { Store } from "./store.ts";
import type {
  PreviewAdmissionKind,
  PreviewArtifact,
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
export const PREVIEW_CLIP_GONE = "That preview clip is gone.";
export const PREVIEW_CLIP_BUSY = "That preview is still generating.";
export const PREVIEW_STALE = "The original or finished copy changed. Request a new preview.";
export const PREVIEW_EVICT_PINNED = "That preview is still playing.";
export const PREVIEW_CACHE_CLEANUP_WARNING = "Polisharr could not delete a preview pair, so cache accounting still includes those bytes.";

export type { PreviewRenderer, PreviewRendererControl };

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
  probeMedia?: (path: string) => Promise<PreviewMediaInfo>;
  reviewPath?: () => string;
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
  private cacheReservations = new Map<string, number>();
  private streamPins = new Map<string, number>();
  private renderPlans = new Map<string, PreviewRenderPlan>();

  constructor(private readonly opts: PreviewServiceOptions) {}

  start(): void {
    const expired = this.opts.store.expirePreviewLeases(this.now());
    const interrupted = this.opts.store.recoverInterruptedPreviews();
    for (const id of [...expired, ...interrupted]) void this.discardPairFiles(id);
    void this.reconcileCache();
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
      const expired = this.opts.store.expirePreviewLeases(this.now());
      for (const id of expired) void this.discardPairFiles(id);
    } catch (error) {
      if (isClosedDb(error)) return;
      throw error;
    }
  }

  cacheUsage(): number {
    return this.cacheBytes();
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

  async request(
    reviewId: string,
    rawRequest: unknown = {},
  ): Promise<{ accepted: true; task: PreviewTask } | { error: string; status: number }> {
    const review = this.opts.store.getReview(reviewId);
    if (!review) return { error: PREVIEW_REVIEW_GONE, status: 404 };
    if (review.status === "keeping" || review.status === "discarding") {
      return { error: PREVIEW_REVIEW_BUSY, status: 409 };
    }
    const parsed = parsePreviewRequest(rawRequest);
    if (isIsoPath(review.sourcePath) || isIsoPath(review.sidecarPath)) {
      return this.failClosed(reviewId, parsed, PREVIEW_ISO_UNAVAILABLE);
    }
    const media = await this.probePair(review.sourcePath, review.sidecarPath, review);
    if ("error" in media) return this.failClosed(reviewId, parsed, media.error);
    const commonDurationMs = Math.min(media.original.durationMs, media.finished.durationMs);
    if (commonDurationMs < PREVIEW_MIN_DURATION_MS) {
      return this.failClosed(reviewId, parsed, PREVIEW_SHORT_DURATION);
    }
    if (!media.original.hasVideo || !media.finished.hasVideo || media.original.audio.length === 0 || media.finished.audio.length === 0) {
      return this.failClosed(reviewId, parsed, PREVIEW_MISSING_STREAMS);
    }
    const color = previewColorDecision(media.original, media.finished);
    if (!color.ok) return this.failClosed(reviewId, parsed, color.error);
    const interval = normalizePreviewInterval(parsed, commonDurationMs);
    if (!interval.ok) return { error: interval.error, status: 400 };
    const fallback = defaultPreviewAudio(media.original.audio, media.finished.audio);
    const originalAudioIndex = resolvePreviewAudioIndex(media.original.audio, parsed.originalAudioIndex, fallback.originalAudioIndex);
    const sidecarAudioIndex = resolvePreviewAudioIndex(media.finished.audio, parsed.sidecarAudioIndex, fallback.sidecarAudioIndex);
    if (parsed.originalAudioIndex != null && originalAudioIndex == null) return { error: "That audio track is not on the original copy.", status: 400 };
    if (parsed.sidecarAudioIndex != null && sidecarAudioIndex == null) return { error: "That audio track is not on the finished copy.", status: 400 };
    if (originalAudioIndex == null || sidecarAudioIndex == null) {
      return this.failClosed(reviewId, parsed, PREVIEW_MISSING_STREAMS);
    }
    const sourceRevision = readFileRevision(review.sourcePath);
    const sidecarRevision = readFileRevision(review.sidecarPath);
    const request = { ...parsed, startMs: interval.startMs, durationMs: interval.durationMs, originalAudioIndex, sidecarAudioIndex };
    const cacheKey = previewCacheKey({
      reviewId,
      sourceRevision: revisionKey(sourceRevision),
      sidecarRevision: revisionKey(sidecarRevision),
      startMs: interval.startMs,
      durationMs: interval.durationMs,
      originalAudioIndex,
      sidecarAudioIndex,
    });
    const reusable = this.opts.store.findReusablePreview(reviewId, cacheKey);
    if (reusable) {
      if (reusable.status === "ready" && !this.pairStillValid(reusable)) {
        this.expirePair(reusable.id, "The cached preview is no longer valid.");
      } else {
        this.touch(reusable.id);
        return { accepted: true, task: this.opts.store.getPreviewTask(reusable.id)! };
      }
    }
    const size = matchedPreviewSize(media.original, media.finished);
    const labels = transformLabels({ size, color: "sdr" });
    const artifact: PreviewArtifact = {
      originalClipId: randomUUID(),
      finishedClipId: randomUUID(),
      originalFile: previewFileName("original"),
      finishedFile: previewFileName("finished"),
      interval: { startMs: interval.startMs, durationMs: interval.durationMs },
      originalAudioIndex,
      sidecarAudioIndex,
      originalVideoIndex: media.original.videoIndex,
      sidecarVideoIndex: media.finished.videoIndex,
      width: size.original.width,
      height: size.original.height,
      finishedWidth: size.finished.width,
      finishedHeight: size.finished.height,
      labels,
    };
    const id = randomUUID();
    const now = this.now();
    this.renderPlans.set(id, {
      cacheDir: this.pairDir(id),
      startMs: interval.startMs,
      durationMs: interval.durationMs,
      originalVideoIndex: media.original.videoIndex,
      sidecarVideoIndex: media.finished.videoIndex,
      originalAudioIndex,
      sidecarAudioIndex,
      originalWidth: size.original.width,
      originalHeight: size.original.height,
      finishedWidth: size.finished.width,
      finishedHeight: size.finished.height,
    });
    if (!this.hasCapablePreviewNode(now)) {
      this.opts.store.insertPreviewTask({
        id,
        reviewId,
        status: "failed",
        error: NO_PREVIEW_NODE,
        request,
        sourceRevision,
        sidecarRevision,
        cacheKey,
        artifact,
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
      cacheKey,
      artifact,
      createdAt: now,
    });
    this.refreshQueuedWaitReasons();
    void this.tick();
    return { accepted: true, task: this.opts.store.getPreviewTask(id)! };
  }

  cancel(id: string): { ok: true } | { error: string; status: number } {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return { error: "That preview task does not exist.", status: 404 };
    if (task.status === "ready") return this.evict(id);
    if (task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
      return { error: "Finished preview tasks cannot be cancelled.", status: 409 };
    }
    const now = this.now();
    this.opts.store.updatePreviewTask(id, { status: "cancelled", waitReason: null, updatedAt: now });
    this.opts.store.releasePreviewReservations(id);
    this.releaseReservation(id);
    void this.discardPairFiles(id);
    return { ok: true };
  }

  evict(id: string): { ok: true } | { error: string; status: number } {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return { error: "That preview task does not exist.", status: 404 };
    if (task.status !== "ready") return { error: "Only an idle cached preview can be removed.", status: 409 };
    if ((this.streamPins.get(id) ?? 0) > 0) return { error: PREVIEW_EVICT_PINNED, status: 409 };
    this.expirePair(id, null);
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
    if (!this.cacheHasRoom()) {
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
    this.reserveCache(claimed.id);
    const leaseUntil = claimed.leaseUntil ?? this.now() + PREVIEW_LEASE_MS;
    const render = this.renderPlans.get(claimed.id) ?? this.planFromTask(claimed);
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
      cacheDir: this.pairDir(claimed.id),
      render,
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
      void this.discardPairFiles(id);
      return { error: PREVIEW_PUBLICATION_REVOKED, status: 409 };
    }
    if (task.status === "ready") {
      this.opts.store.releasePreviewReservations(id);
      return { ok: true };
    }
    if (!this.opts.store.previewLeaseMatches(id, leaseToken) || task.status !== "running") {
      void this.discardPairFiles(id);
      return { error: PREVIEW_LEASE_INVALID, status: 409 };
    }
    const dir = this.pairDir(id);
    if (!publishedPairValidSync(dir)) {
      this.fail(id, leaseToken, PREVIEW_PAIR_INCOMPLETE);
      return { error: PREVIEW_PAIR_INCOMPLETE, status: 409 };
    }
    const now = this.now();
    const bytes = publishedPairBytesSync(dir);
    this.opts.store.updatePreviewTask(id, {
      status: "ready",
      waitReason: null,
      leaseToken: null,
      leaseUntil: null,
      error: null,
      bytes,
      expiresAt: now + PREVIEW_CACHE_TTL_MS,
      lastUsedAt: now,
      updatedAt: now,
    });
    this.opts.store.releasePreviewReservations(id);
    this.cacheReservations.set(id, bytes);
    return { ok: true };
  }

  fail(id: string, leaseToken: string, error: string): { ok: true } | { cancelled: true } | { error: string; status: number } {
    const task = this.opts.store.getPreviewTask(id);
    if (!task) return { error: "That preview task does not exist.", status: 404 };
    if (task.status === "cancelled") {
      this.opts.store.releasePreviewReservations(id);
      void this.discardPairFiles(id);
      return { cancelled: true };
    }
    if (!this.opts.store.previewLeaseMatches(id, leaseToken)) {
      if (task.status !== "ready") void this.discardPairFiles(id);
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
    this.releaseReservation(id);
    void this.discardPairFiles(id);
    return { ok: true };
  }

  revokeAndCancel(reviewId: string): void {
    const now = this.now();
    this.opts.store.revokePreviewPublication(reviewId, now);
    this.opts.store.cancelPreviewTasksForReview(reviewId, now);
    this.invalidateReviewPairs(reviewId);
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
    this.invalidateReviewPairs(reviewId);
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
        isCancelled: () => {
          const status = this.opts.store.getPreviewTask(doc.id)?.status;
          return status === "cancelled" || status === "failed";
        },
        onProgress: (progress) => {
          void this.progress(doc.id, doc.leaseToken, progress);
        },
        registerChild: () => undefined,
      });
      const latest = this.opts.store.getPreviewTask(doc.id);
      if (!latest || latest.status === "cancelled" || latest.status === "failed" || !latest.publicationAllowed) {
        this.opts.store.releasePreviewReservations(doc.id);
        void this.discardPairFiles(doc.id);
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
      } else if (!this.cacheHasRoom()) {
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

  openClip(
    reviewId: string,
    previewId: string,
    side: string,
  ): { path: string; size: number; release: () => void } | { error: string; status: number } {
    if (side !== "original" && side !== "finished") return { error: PREVIEW_CLIP_GONE, status: 404 };
    const review = this.opts.store.getReview(reviewId);
    if (!review) return { error: PREVIEW_REVIEW_GONE, status: 404 };
    const task = this.opts.store.getPreviewTask(previewId);
    if (!task || task.reviewId !== reviewId) return { error: "That preview task does not exist.", status: 404 };
    if (task.status === "queued" || task.status === "running") return { error: PREVIEW_CLIP_BUSY, status: 409 };
    if (task.status !== "ready" || !task.publicationAllowed) return { error: PREVIEW_CLIP_GONE, status: 404 };
    if (!this.pairStillValid(task)) {
      this.expirePair(task.id, PREVIEW_STALE);
      return { error: PREVIEW_STALE, status: 409 };
    }
    const root = previewRoot(this.reviewDir());
    const owned = ownedPreviewPath(root, join(this.pairDir(task.id), previewFileName(side)));
    if (!owned) return { error: PREVIEW_CLIP_GONE, status: 404 };
    const totalPins = [...this.streamPins.values()].reduce((sum, count) => sum + count, 0);
    if (totalPins >= PREVIEW_MAX_STREAM_PINS) return { error: "Too many preview clips are open.", status: 429 };
    this.streamPins.set(task.id, (this.streamPins.get(task.id) ?? 0) + 1);
    this.touch(task.id);
    let released = false;
    return {
      path: owned,
      size: statSync(owned).size,
      release: () => {
        if (released) return;
        released = true;
        const next = (this.streamPins.get(task.id) ?? 1) - 1;
        if (next <= 0) this.streamPins.delete(task.id);
        else this.streamPins.set(task.id, next);
      },
    };
  }

  private failClosed(
    reviewId: string,
    request: ReturnType<typeof parsePreviewRequest>,
    error: string,
  ): { accepted: true; task: PreviewTask } {
    const id = randomUUID();
    const now = this.now();
    this.opts.store.insertPreviewTask({
      id,
      reviewId,
      status: "failed",
      error,
      request,
      createdAt: now,
    });
    return { accepted: true, task: this.opts.store.getPreviewTask(id)! };
  }

  private async probePair(
    sourcePath: string,
    sidecarPath: string,
    review: { itemId: string; source: { durationSec: number }; sidecar: { durationSec: number } },
  ): Promise<{ original: PreviewMediaInfo; finished: PreviewMediaInfo } | { error: string }> {
    try {
      if (this.opts.probeMedia) {
        return { original: await this.opts.probeMedia(sourcePath), finished: await this.opts.probeMedia(sidecarPath) };
      }
      const report = this.opts.store.getInspection(review.itemId);
      if (!report) return { error: PREVIEW_MISSING_STREAMS };
      return {
        original: mediaFromInspection(report, review.source.durationSec),
        finished: mediaFromInspection(report, review.sidecar.durationSec),
      };
    } catch {
      return { error: PREVIEW_MISSING_STREAMS };
    }
  }

  private pairDir(taskId: string): string {
    return previewPairDir(this.reviewDir(), taskId);
  }

  private reviewDir(): string {
    return this.opts.reviewPath?.() ?? this.opts.store.getSettings().reviewPath;
  }

  private cacheHasRoom(): boolean {
    if (this.opts.cacheFits) return this.opts.cacheFits();
    this.evictIdle();
    return this.cacheBytes() + PREVIEW_PAIR_RESERVE_BYTES <= PREVIEW_CACHE_MAX_BYTES;
  }

  private cacheBytes(): number {
    const stored = this.opts.store.previewCacheBytes();
    let reserved = 0;
    for (const [id, bytes] of this.cacheReservations) {
      const task = this.opts.store.getPreviewTask(id);
      if (task?.status === "ready" || (task?.bytes ?? 0) > 0) continue;
      reserved += bytes;
    }
    return stored + reserved + this.unownedPreviewDiskBytes();
  }

  private reserveCache(taskId: string): void {
    this.evictIdle();
    this.cacheReservations.set(taskId, PREVIEW_PAIR_RESERVE_BYTES);
  }

  private releaseReservation(taskId: string): void {
    this.cacheReservations.delete(taskId);
  }

  private evictIdle(): void {
    const now = this.now();
    for (const task of this.opts.store.readyPreviewTasks()) {
      if ((this.streamPins.get(task.id) ?? 0) > 0) continue;
      if (task.expiresAt != null && task.expiresAt <= now) this.expirePair(task.id, null);
    }
    if (this.opts.cacheFits) return;
    while (this.cacheBytes() + PREVIEW_PAIR_RESERVE_BYTES > PREVIEW_CACHE_MAX_BYTES) {
      const idle = this.opts.store.readyPreviewTasks().find((task) => (this.streamPins.get(task.id) ?? 0) === 0);
      if (!idle) break;
      this.expirePair(idle.id, null);
    }
  }

  private expirePair(id: string, error: string | null): void {
    this.opts.store.updatePreviewTask(id, {
      status: "expired",
      error,
      waitReason: null,
      expiresAt: null,
      updatedAt: this.now(),
    });
    this.releaseReservation(id);
    void this.discardPairFiles(id);
  }

  private touch(id: string): void {
    this.opts.store.updatePreviewTask(id, { lastUsedAt: this.now(), updatedAt: this.now() });
  }

  private pairStillValid(task: PreviewTask): boolean {
    const review = this.opts.store.getReview(task.reviewId);
    if (!review) return false;
    if (task.sourceRevision && !revisionsMatch(task.sourceRevision, readFileRevision(review.sourcePath))) return false;
    if (task.sidecarRevision && !revisionsMatch(task.sidecarRevision, readFileRevision(review.sidecarPath))) return false;
    return publishedPairValidSync(this.pairDir(task.id));
  }

  private async discardPairFiles(id: string): Promise<void> {
    this.renderPlans.delete(id);
    this.releaseReservation(id);
    const dir = this.pairDir(id);
    try {
      const onDisk = previewDirBytes(dir);
      const task = this.opts.store.getPreviewTask(id);
      if (onDisk > 0 && (task?.bytes ?? 0) < onDisk) {
        this.opts.store.updatePreviewTask(id, { bytes: onDisk, updatedAt: this.now() });
      }
      const gone = await removePreviewPairDir(dir);
      if (gone) {
        if ((this.opts.store.getPreviewTask(id)?.bytes ?? 0) > 0) {
          this.opts.store.updatePreviewTask(id, { bytes: 0, updatedAt: this.now() });
        }
        return;
      }
      const leftover = previewDirBytes(dir);
      if (leftover <= 0) return;
      this.opts.store.updatePreviewTask(id, { bytes: leftover, updatedAt: this.now() });
      console.error(`${PREVIEW_CACHE_CLEANUP_WARNING} ${leftover} bytes remain in ${dir}.`);
    } catch (error) {
      if (isClosedDb(error)) return;
      throw error;
    }
  }

  private invalidateReviewPairs(reviewId: string): void {
    for (const task of this.opts.store.listPreviewTasks(reviewId)) {
      this.releaseReservation(task.id);
      if (task.status === "ready") {
        this.opts.store.updatePreviewTask(task.id, { status: "expired", updatedAt: this.now() });
      }
      void this.discardPairFiles(task.id);
    }
  }

  private async reconcileCache(): Promise<void> {
    const root = previewRoot(this.reviewDir());
    const owned = new Set<string>();
    try {
      for (const task of this.opts.store.listPreviewTasks()) {
        if (task.status === "running") {
          owned.add(task.id);
          continue;
        }
        if (task.status === "ready" && publishedPairValidSync(this.pairDir(task.id))) {
          owned.add(task.id);
          continue;
        }
        if (task.status === "ready") this.expirePair(task.id, "The cached preview is no longer valid.");
      }
      const leftover = await sweepUnownedPreviewDirs(root, owned);
      for (const id of leftover) {
        const bytes = previewDirBytes(this.pairDir(id));
        if (bytes <= 0) continue;
        const task = this.opts.store.getPreviewTask(id);
        if (task) this.opts.store.updatePreviewTask(id, { bytes, updatedAt: this.now() });
        console.error(`${PREVIEW_CACHE_CLEANUP_WARNING} ${bytes} bytes remain in ${this.pairDir(id)}.`);
      }
      for (const task of this.opts.store.listPreviewTasks()) {
        if (owned.has(task.id) || existsSync(this.pairDir(task.id))) continue;
        if (task.bytes > 0) this.opts.store.updatePreviewTask(task.id, { bytes: 0, updatedAt: this.now() });
      }
    } catch (error) {
      if (isClosedDb(error)) return;
      throw error;
    }
  }

  private unownedPreviewDiskBytes(): number {
    const root = previewRoot(this.reviewDir());
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return 0;
    }
    const known = new Set(this.opts.store.listPreviewTasks().map((task) => task.id));
    let total = 0;
    for (const name of names) {
      if (known.has(name)) continue;
      total += previewDirBytes(join(root, name));
    }
    return total;
  }

  private planFromTask(task: PreviewTask): PreviewRenderPlan | null {
    const artifact = task.artifact;
    if (!artifact) return null;
    return {
      cacheDir: this.pairDir(task.id),
      startMs: artifact.interval.startMs,
      durationMs: artifact.interval.durationMs,
      originalVideoIndex: artifact.originalVideoIndex ?? 0,
      sidecarVideoIndex: artifact.sidecarVideoIndex ?? 0,
      originalAudioIndex: artifact.originalAudioIndex,
      sidecarAudioIndex: artifact.sidecarAudioIndex,
      originalWidth: artifact.width,
      originalHeight: artifact.height,
      finishedWidth: artifact.finishedWidth,
      finishedHeight: artifact.finishedHeight,
    };
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
  interval: { startMs: number; durationMs: number } | null;
  tracks: { originalAudioIndex: number | null; sidecarAudioIndex: number | null };
  clips: { original: string; finished: string } | null;
  transform: PreviewArtifact["labels"] | null;
} {
  const ready = task.status === "ready" && task.artifact;
  return {
    id: task.id,
    reviewId: task.reviewId,
    status: task.status,
    waitReason: task.waitReason,
    nodeId: task.nodeId,
    nodeName,
    error: task.error,
    interval: task.artifact?.interval ?? { startMs: task.request.startMs, durationMs: task.request.durationMs },
    tracks: {
      originalAudioIndex: task.artifact?.originalAudioIndex ?? task.request.originalAudioIndex,
      sidecarAudioIndex: task.artifact?.sidecarAudioIndex ?? task.request.sidecarAudioIndex,
    },
    clips: ready
      ? { original: task.artifact!.originalClipId, finished: task.artifact!.finishedClipId }
      : null,
    transform: task.artifact?.labels ?? null,
  };
}
