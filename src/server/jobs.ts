import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import type { Store } from "./store.ts";
import type { HardwareInfo, InspectionReport, Job, JobPhase, ReviewItem, Settings, Suggestion } from "./types.ts";
import { displayTitle } from "./titles.ts";
import type { Optimizer } from "./optimize.ts";
import { CancelledError, isExecutablePlan, planFromSuggestion, removeReviewArtifact, resolvePlan } from "./optimize.ts";
import { aggressiveTargetBytes, missedOutputTarget } from "./size-budget.ts";
import { classifyInterruptedKeep, KEEP_INTERRUPTED, SIDECAR_GONE } from "./review-recovery.ts";
import { clearStagedBackup, promote, promotedPath, recoverStagedReplace, type PromoteInput, type PromoteResult } from "./promote.ts";
import { assignProfile, PROFILE_NAMES } from "./arr-profiles.ts";
import { effectiveWriteMode, profileAssignmentEligible } from "./types.ts";
import { isoInspectionLooksStale, normalizeInspection } from "./inspect.ts";
import { refreshAndRenameArr } from "./arr.ts";
import { encodeNeedFromPlan, LEASE_MS, nodeCanEncode, type RemoteJobDocument } from "./cluster.ts";
import { encodeApiLabel } from "./hardware.ts";
import { isArrSearchOnly } from "./arr-search.ts";

export type EnqueueOptions = {
  runNow?: boolean;
  writeMode?: import("./types.ts").WriteMode;
  assignedNodeId?: string;
};

export type JobServiceOptions = {
  store: Store;
  optimizer: Optimizer;
  clock?: () => number;
  hardware: () => Promise<HardwareInfo>;
  tools: { ffmpeg: string; ffprobe: string; mkvmerge: string };
  decrypt: (packed: string) => string;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  reinspectChangedItem: (itemId: string, oldPath: string) => Promise<{ ok: true } | { ok: false; warning: string }>;
  inspectOne?: (itemId: string) => Promise<{ ok: true; report: InspectionReport } | { ok: false; warning: string }>;
  promote?: (input: PromoteInput) => Promise<PromoteResult>;
  localNodeId?: () => string;
};

export const SHARED_FILE_BUSY = "This file is already in the queue or Review. Another episode uses the same file.";

export class JobService {
  private running = new Set<string>();
  private cancelled = new Set<string>();
  private keepRunning = 0;
  private keepWaiters: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: JobServiceOptions) {}

  start(): void {
    this.opts.store.recoverInterruptedJobs(this.now(), this.localNodeId());
    void this.recoverInterruptedKeeps();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 500);
  }

  private localNodeId(): string {
    return this.opts.localNodeId?.() ?? this.opts.store.localNodeId();
  }

  private reviewProvenance(job: Job): Pick<ReviewItem, "nodeName" | "encodeApi" | "gpuName" | "encodeMs"> {
    const node = this.opts.store.getNode(job.nodeId ?? job.assignedNodeId ?? "")
      ?? this.opts.store.getNode(this.localNodeId());
    return {
      nodeName: node?.name ?? null,
      encodeApi: encodeApiLabel(node?.hardware.backend),
      gpuName: node?.hardware.gpuName ?? null,
      encodeMs: job.startedAt != null ? Math.max(0, this.now() - job.startedAt) : null,
    };
  }

  assignedNodeId(override?: string): string {
    const local = this.localNodeId();
    if (override) return override;
    const stored = this.opts.store.getSettings().defaultEncodeNodeId;
    if (stored && (this.opts.store.getNode(stored) || stored === local)) return stored;
    return local;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  enqueue(
    itemId: string,
    suggestion: Suggestion,
    runNowOrOpts: boolean | EnqueueOptions = false,
  ): { id: string } | { error: string; status: number } {
    const item = this.opts.store.getItem(itemId);
    if (!item) return { error: "That title is not in the library.", status: 404 };
    const busy = this.enqueueLock(item);
    if (busy) return busy;
    if (isArrSearchOnly(suggestion.actions)) {
      return {
        error: "This title needs a Radarr or Sonarr search, not an encode. Open the title page to confirm.",
        status: 400,
      };
    }
    const options = typeof runNowOrOpts === "boolean" ? { runNow: runNowOrOpts } : runNowOrOpts;
    const id = randomUUID();
    const locked = options.writeMode !== undefined;
    const writeMode = options.writeMode ?? this.opts.store.getSettings().writeMode;
    const plan = { ...planFromSuggestion(suggestion, writeMode), writeModeLocked: locked };
    const assignedNodeId = this.assignedNodeId(options.assignedNodeId);
    const incapable = this.rejectIncapableNode(assignedNodeId, plan);
    if (incapable) return incapable;
    this.opts.store.insertJob({
      id,
      itemId,
      suggestionId: suggestion.id,
      status: "queued",
      phase: "queued",
      progress: 0,
      error: null,
      warning: suggestion.warning,
      runNow: Boolean(options.runNow),
      createdAt: this.now(),
      writeMode,
      plan,
      assignedNodeId,
    });
    void this.tick();
    return { id };
  }

  enqueueCustom(
    itemId: string,
    plan: import("./types.ts").ExecutablePlan,
    runNowOrOpts: boolean | EnqueueOptions = false,
  ): { id: string } | { error: string; status: number } {
    const item = this.opts.store.getItem(itemId);
    if (!item) return { error: "That title is not in the library.", status: 404 };
    const busy = this.enqueueLock(item);
    if (busy) return busy;
    this.dismissOpenSuggestionsForItem(item);
    const options = typeof runNowOrOpts === "boolean" ? { runNow: runNowOrOpts } : runNowOrOpts;
    const assignedNodeId = this.assignedNodeId(options.assignedNodeId);
    const incapable = this.rejectIncapableNode(assignedNodeId, plan);
    if (incapable) return incapable;
    const id = randomUUID();
    this.opts.store.insertJob({
      id,
      itemId,
      suggestionId: null,
      status: "queued",
      phase: "queued",
      progress: 0,
      error: null,
      warning: plan.warning,
      runNow: Boolean(options.runNow),
      createdAt: this.now(),
      writeMode: plan.writeMode,
      promoteError: null,
      plan,
      assignedNodeId,
    });
    void this.tick();
    return { id };
  }

  reassign(id: string, nodeId: string): { ok: true } | { error: string; status: number } {
    const job = this.opts.store.getJob(id);
    if (!job) return { error: "That job does not exist.", status: 404 };
    if (job.status === "running" || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return { error: "Move a waiting job, not one that is already encoding.", status: 409 };
    }
    const node = this.opts.store.getNode(nodeId);
    if (!node) return { error: "That encode node is not registered.", status: 400 };
    const plan = isExecutablePlan(job.plan) ? resolvePlan(job.plan, job.writeMode) : planFromSuggestion(job.plan, job.writeMode);
    const incapable = this.rejectIncapableNode(nodeId, plan);
    if (incapable) return incapable;
    this.opts.store.setJobAssignedNode(id, nodeId);
    return { ok: true };
  }

  private rejectIncapableNode(nodeId: string, plan: { video?: { kind?: string; codec?: string } }): { error: string; status: number } | undefined {
    const node = this.opts.store.getNode(nodeId);
    if (!node) return undefined;
    if (nodeCanEncode(node, encodeNeedFromPlan(plan))) return undefined;
    return { error: "That encode node cannot run this plan.", status: 400 };
  }

  private enqueueLock(item: NonNullable<ReturnType<Store["getItem"]>>): { error: string; status: number } | undefined {
    if (this.opts.store.pendingReviewForItem(item.id)) {
      return { error: "This title already has a sidecar waiting in Review.", status: 409 };
    }
    if (this.opts.store.activeJobForItem(item.id)) {
      return { error: "This title already has an active job.", status: 409 };
    }
    const pathReview = this.opts.store.pendingReviewForPath(item.path, item.instanceId);
    if (pathReview && pathReview.itemId !== item.id) {
      return { error: SHARED_FILE_BUSY, status: 409 };
    }
    const pathJob = this.opts.store.activeJobForPath(item.path, item.instanceId);
    if (pathJob && pathJob.itemId !== item.id) {
      return { error: SHARED_FILE_BUSY, status: 409 };
    }
    return undefined;
  }

  private dismissOpenSuggestionsForItem(item: NonNullable<ReturnType<Store["getItem"]>>): void {
    for (const row of this.opts.store.itemsForPath(item.path, item.instanceId)) {
      const open = this.opts.store.openSuggestionForItem(row.id);
      if (open) this.opts.store.dismissSuggestion(open.id);
    }
  }

  cancel(id: string): { ok: true } | { error: string; status: number } {
    const job = this.opts.store.getJob(id);
    if (!job) return { error: "That job does not exist.", status: 404 };
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return { error: "Finished jobs cannot be cancelled.", status: 409 };
    }
    this.cancelled.add(id);
    this.opts.store.updateJob(id, { status: "cancelled", phase: "idle", error: "Cancelled." });
    this.opts.store.addHistory(job.itemId, "cancelled", 0, this.now());
    return { ok: true };
  }

  cancelAll(): { cancelled: number } {
    const ids = this.opts.store.cancelActiveJobs(this.now());
    for (const id of ids) this.cancelled.add(id);
    return { cancelled: ids.length };
  }

  remove(id: string): { ok: true } | { error: string; status: number } {
    const result = this.opts.store.removeFinishedJob(id);
    if (result === "missing") return { error: "That job does not exist.", status: 404 };
    if (result === "active") return { error: "Cancel this job before removing it from Queue.", status: 409 };
    return { ok: true };
  }

  clearFinished(): { removed: number } {
    return { removed: this.opts.store.clearFinishedJobs() };
  }

  claimForNode(nodeId: string, freeSlots: number): RemoteJobDocument[] {
    this.applySchedule(this.opts.store.getSettings());
    this.opts.store.expireLeases(this.now());
    const claimed = this.opts.store.claimQueuedJobs(nodeId, freeSlots, this.now(), LEASE_MS);
    const settings = this.opts.store.getSettings();
    const docs: RemoteJobDocument[] = [];
    for (const job of claimed) {
      const doc = this.toRemoteDocument(job, job.leaseToken, settings);
      if (doc) docs.push(doc);
      else {
        this.opts.store.updateJob(job.id, {
          status: "failed",
          error: "This title has no completed inspection.",
          nodeId: null,
        });
      }
    }
    return docs;
  }

  progressRemote(
    id: string,
    leaseToken: string,
    phase: string | null,
    progress: number | null,
    log: string,
  ): { ok: true } | { cancelled: true } | { error: string; status: number } {
    const job = this.opts.store.getJob(id);
    if (!job) return { error: "That job does not exist.", status: 404 };
    if (job.status === "cancelled" || this.cancelled.has(id)) return { cancelled: true };
    if (!this.opts.store.leaseMatches(id, leaseToken)) return { error: "That job lease is not valid.", status: 409 };
    const logOnly = Boolean(log) && (progress == null || progress === 0);
    const nextPhase = logOnly || !phase ? job.phase : jobPhaseOr(phase, job.phase);
    const nextProgress = logOnly || progress == null ? job.progress : progress;
    this.opts.store.updateJob(id, { phase: nextPhase, progress: nextProgress });
    this.opts.store.renewNodeLeases(job.nodeId ?? "", [id], this.now() + LEASE_MS);
    if (log) this.opts.store.appendJobLog(id, log);
    return { ok: true };
  }

  async completeRemote(
    id: string,
    leaseToken: string,
    sidecarPath: string,
    outputRaw: Record<string, unknown>,
  ): Promise<{ ok: true } | { cancelled: true } | { error: string; status: number }> {
    const job = this.opts.store.getJob(id);
    if (!job) return { error: "That job does not exist.", status: 404 };
    if (job.status === "cancelled" || this.cancelled.has(id)) return { cancelled: true };
    if (!this.opts.store.leaseMatches(id, leaseToken)) return { error: "That job lease is not valid.", status: 409 };
    const item = this.opts.store.getItem(job.itemId);
    const report = this.opts.store.getInspection(job.itemId);
    if (!item || !report) return { error: "This title has no completed inspection.", status: 409 };
    const settings = this.opts.store.getSettings();
    const output = normalizeInspection(outputRaw, sidecarPath, Number(outputRaw.sizeBytes ?? 0));
    const resolved = resolvePlan(job.plan, job.writeMode);
    const writeMode = effectiveWriteMode(resolved, settings.writeMode);
    const plan = { ...resolved, writeMode };
    try {
      if (plan.writeMode === "direct") {
        const outcome = await this.promoteOutput(item, sidecarPath, report.sizeBytes, output.sizeBytes, plan);
        if (!outcome.replaced) {
          this.opts.store.updateJob(id, { status: "failed", error: outcome.error ?? "Direct write failed.", nodeId: null });
          this.opts.store.addHistory(item.id, "failed", 0, this.now());
          return { ok: true };
        }
        const synced = await this.syncLibraryFile(item, outcome.destPath, output.sizeBytes);
        const warning = appendWarning(outcome.warning, synced.warning);
        this.opts.store.updateJob(id, { status: "succeeded", phase: "idle", progress: 1, promoteError: warning, nodeId: job.nodeId });
        this.opts.store.addHistory(item.id, "kept", outcome.savedBytes, this.now());
        return { ok: true };
      }
      const targetBytes = plan.video.kind === "size" ? plan.video.targetBytes : null;
      const flagged = missedOutputTarget({
        outputBytes: output.sizeBytes,
        sourceBytes: report.sizeBytes,
        outputSizePerHourGb: output.sizePerHourGb,
        categoryCap: settings.sizeCaps[plan.category],
        targetBytes,
      });
      this.opts.store.insertReview({
        id: randomUUID(),
        jobId: id,
        itemId: item.id,
        displayTitle: displayTitle(item),
        status: "pending",
        flagged,
        flagReason: flagged ? "The sidecar missed the size target or is larger than the original." : null,
        sourcePath: item.path,
        sidecarPath,
        source: {
          codec: report.videoCodec,
          quality: item.quality,
          sizeBytes: report.sizeBytes,
          sizePerHourGb: report.sizePerHourGb,
          durationSec: report.durationSec,
          tracks: `${report.audio.length} audio / ${report.subtitles.length} subtitles`,
        },
        sidecar: {
          codec: output.videoCodec,
          quality: item.quality,
          sizeBytes: output.sizeBytes,
          sizePerHourGb: output.sizePerHourGb,
          durationSec: output.durationSec,
          tracks: `${output.audio.length} audio / ${output.subtitles.length} subtitles`,
        },
        error: null,
        ...this.reviewProvenance(job),
      });
      this.opts.store.updateJob(id, { status: "succeeded", phase: "idle", progress: 1, nodeId: job.nodeId });
      if (flagged) this.opts.store.addHistory(item.id, "flagged", 0, this.now());
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The job failed.";
      this.opts.store.updateJob(id, { status: "failed", error: message, nodeId: job.nodeId });
      this.opts.store.addHistory(item.id, "failed", 0, this.now());
      return { ok: true };
    }
  }

  failRemote(id: string, leaseToken: string, error: string): { ok: true } | { cancelled: true } | { error: string; status: number } {
    const job = this.opts.store.getJob(id);
    if (!job) return { error: "That job does not exist.", status: 404 };
    if (job.status === "cancelled" || this.cancelled.has(id)) return { cancelled: true };
    if (!this.opts.store.leaseMatches(id, leaseToken)) return { error: "That job lease is not valid.", status: 409 };
    this.opts.store.updateJob(id, { status: "failed", error, nodeId: job.nodeId });
    this.opts.store.addHistory(job.itemId, "failed", 0, this.now());
    return { ok: true };
  }

  private toRemoteDocument(
    job: NonNullable<ReturnType<Store["getJob"]>> & { leaseToken: string },
    leaseToken: string,
    settings: Settings,
  ): RemoteJobDocument | null {
    const item = this.opts.store.getItem(job.itemId);
    const report = this.opts.store.getInspection(job.itemId);
    if (!item || !report) return null;
    const resolved = resolvePlan(job.plan, job.writeMode);
    return {
      id: job.id,
      leaseToken,
      sourcePath: item.path,
      reviewDir: settings.reviewPath,
      plan: { ...resolved, writeMode: effectiveWriteMode(resolved, settings.writeMode) },
      report,
      target: this.opts.store.videoTargetForItem(item) ?? settings.videoTarget,
      conservative: settings.conservativeMode,
      writeMode: job.writeMode,
      nodeId: job.nodeId ?? this.localNodeId(),
    };
  }

  private async tick(): Promise<void> {
    try {
      const settings = this.opts.store.getSettings();
      this.applySchedule(settings);
      this.opts.store.expireLeases(this.now());
      const localId = this.localNodeId();
      const localNode = this.opts.store.getNode(localId);
      if (localNode && !localNode.enabled) return;
      const slots = Math.max(1, localNode?.concurrency ?? settings.concurrency);
      const capacity = slots - this.running.size;
      if (capacity <= 0) return;
      const next = this.opts.store
        .listJobs()
        .filter((j) => j.status === "queued" && assignedToNode(j.assignedNodeId, localId))
        .slice(0, capacity);
      for (const job of next) void this.run(job.id, settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`The job runner skipped a tick because ${message}`);
    }
  }

  private applySchedule(settings: Settings): void {
    const inWindow = !settings.offPeakEnabled || insideWindow(settings.offPeakStart, settings.offPeakEnd, new Date(this.now()));
    for (const job of this.opts.store.listJobs()) {
      if (job.status === "queued" && !inWindow && !job.runNow) {
        this.opts.store.updateJob(job.id, { status: "held", phase: "held" });
      }
      if (job.status === "held" && (inWindow || job.runNow)) {
        this.opts.store.updateJob(job.id, { status: "queued", phase: "queued" });
      }
    }
  }

  private async run(id: string, settings: Settings): Promise<void> {
    if (this.running.has(id) || this.cancelled.has(id)) return;
    const job = this.opts.store.getJob(id);
    if (!job) return;
    const item = this.opts.store.getItem(job.itemId);
    let report = this.opts.store.getInspection(job.itemId);
    if (item && this.opts.inspectOne && isoInspectionLooksStale(report, item.path)) {
      const relist = await this.opts.inspectOne(item.id);
      if (relist.ok) report = relist.report;
    }
    if (!item || !report) {
      this.opts.store.updateJob(id, { status: "failed", error: "This title has no completed inspection." });
      return;
    }
    this.running.add(id);
    this.opts.store.updateJob(id, {
      status: "running",
      phase: "muxing",
      progress: 0.05,
      nodeId: this.localNodeId(),
      startedAt: job.startedAt ?? this.now(),
    });
    try {
      const hardware = await this.opts.hardware();
      const resolved = resolvePlan(job.plan, job.writeMode);
      const writeMode = effectiveWriteMode(resolved, settings.writeMode);
      const plan = { ...resolved, writeMode };
      const result = await this.opts.optimizer({
        sourcePath: item.path,
        reviewDir: settings.reviewPath,
        suggestion: isExecutablePlan(job.plan) ? undefined : job.plan,
        plan,
        report,
        target: this.opts.store.videoTargetForItem(item) ?? settings.videoTarget,
        backend: hardware.backend,
        vaapiDevice: hardware.vaapiDevice,
        ffmpeg: this.opts.tools.ffmpeg,
        ffprobe: this.opts.tools.ffprobe,
        mkvmerge: this.opts.tools.mkvmerge,
        conservative: settings.conservativeMode,
        onPhase: (phase, progress) => {
          if (!this.cancelled.has(id)) this.opts.store.updateJob(id, { phase, progress });
        },
        onLog: (text) => this.opts.store.appendJobLog(id, text),
        isCancelled: () => this.cancelled.has(id),
        jobId: id,
        nodeId: this.localNodeId(),
      });
      if (this.cancelled.has(id)) {
        await removeReviewArtifact(result.sidecarPath);
        return;
      }
      if (plan.writeMode === "direct") {
        const destPath = promotedPath(item.path, plan);
        if (this.cancelled.has(id)) {
          await removeReviewArtifact(result.sidecarPath);
          return;
        }
        const outcome = await this.promoteOutput(item, result.sidecarPath, report.sizeBytes, result.output.sizeBytes, plan);
        if (this.cancelled.has(id) && !outcome.replaced) {
          await removeReviewArtifact(result.sidecarPath);
          await recoverStagedReplace(destPath);
          if (destPath !== item.path) await recoverStagedReplace(item.path);
          return;
        }
        if (!outcome.replaced) {
          await removeReviewArtifact(result.sidecarPath);
          this.opts.store.updateJob(id, { status: "failed", error: outcome.error ?? "Direct write failed." });
          this.opts.store.addHistory(item.id, "failed", 0, this.now());
          return;
        }
        const synced = await this.syncLibraryFile(item, outcome.destPath, result.output.sizeBytes);
        const warning = appendWarning(outcome.warning, synced.warning);
        this.opts.store.updateJob(id, { status: "succeeded", phase: "idle", progress: 1, promoteError: warning });
        this.opts.store.addHistory(item.id, "kept", outcome.savedBytes, this.now());
        return;
      }
      const targetBytes = plan.video.kind === "size" ? plan.video.targetBytes : null;
      const flagged = missedOutputTarget({
        outputBytes: result.output.sizeBytes,
        sourceBytes: report.sizeBytes,
        outputSizePerHourGb: result.output.sizePerHourGb,
        categoryCap: settings.sizeCaps[plan.category],
        targetBytes,
      });
      this.opts.store.insertReview({
        id: randomUUID(),
        jobId: id,
        itemId: item.id,
        displayTitle: displayTitle(item),
        status: "pending",
        flagged,
        flagReason: flagged ? "The sidecar missed the size target or is larger than the original." : null,
        sourcePath: item.path,
        sidecarPath: result.sidecarPath,
        source: {
          codec: report.videoCodec,
          quality: item.quality,
          sizeBytes: report.sizeBytes,
          sizePerHourGb: report.sizePerHourGb,
          durationSec: report.durationSec,
          tracks: `${report.audio.length} audio / ${report.subtitles.length} subtitles`,
        },
        sidecar: {
          codec: result.output.videoCodec,
          quality: item.quality,
          sizeBytes: result.output.sizeBytes,
          sizePerHourGb: result.output.sizePerHourGb,
          durationSec: result.output.durationSec,
          tracks: `${result.output.audio.length} audio / ${result.output.subtitles.length} subtitles`,
        },
        error: null,
        ...this.reviewProvenance(job),
      });
      this.opts.store.updateJob(id, { status: "succeeded", phase: "idle", progress: 1 });
      if (flagged) this.opts.store.addHistory(item.id, "flagged", 0, this.now());
    } catch (error) {
      if (error instanceof CancelledError || this.cancelled.has(id)) {
        this.opts.store.updateJob(id, { status: "cancelled", error: "Cancelled." });
      } else {
        const message = error instanceof Error ? error.message : "The job failed.";
        this.opts.store.updateJob(id, { status: "failed", error: message });
        this.opts.store.addHistory(item.id, "failed", 0, this.now());
      }
    } finally {
      this.running.delete(id);
    }
  }

  async recoverInterruptedKeeps(): Promise<void> {
    for (const review of this.opts.store.listReviews()) {
      if (review.status === "discarding") {
        await this.unlinkSidecarIfLast(review);
        this.opts.store.deleteReview(review.id);
        this.opts.store.addHistory(review.itemId, "discarded", 0, this.now());
        continue;
      }
      if (review.status !== "keeping") continue;
      if (!this.opts.store.getReview(review.id)) continue;
      const item = this.opts.store.getItem(review.itemId);
      const job = this.opts.store.getJob(review.jobId);
      const plan = job ? resolvePlan(job.plan, job.writeMode) : undefined;
      const destPath = item ? promotedPath(item.path, plan) : review.sourcePath;
      await recoverStagedReplace(destPath);
      if (destPath !== review.sourcePath) await recoverStagedReplace(review.sourcePath);
      const destBytes = await fileSize(destPath);
      const sourceBytesOnDisk = destPath === review.sourcePath ? destBytes : await fileSize(review.sourcePath);
      const kind = classifyInterruptedKeep({
        sidecarExists: await fileExists(review.sidecarPath),
        libraryBytes: destBytes ?? sourceBytesOnDisk,
        sourceBytes: review.source.sizeBytes ?? 0,
        sidecarBytes: review.sidecar.sizeBytes ?? 0,
      });
      if (kind === "complete") {
        await this.finalizeCompletedKeep(review, destPath);
        await clearStagedBackup(destPath);
        continue;
      }
      if (kind === "sidecar_gone") {
        this.opts.store.updateReview(review.id, { status: "pending", error: SIDECAR_GONE });
        continue;
      }
      this.opts.store.updateReview(review.id, { status: "pending", error: KEEP_INTERRUPTED });
    }
  }

  async keep(reviewId: string): Promise<{ accepted: true } | { error: string; status: number }> {
    const review = this.opts.store.getReview(reviewId);
    if (!review) return { error: "That review item is gone.", status: 404 };
    if (review.status === "keeping") return { error: "Keep is already running for this title.", status: 409 };
    if (this.opts.store.reviewsForSidecarPath(review.sidecarPath).some((row) => row.id !== reviewId && row.status === "keeping")) {
      return { error: "Keep is already running for this file.", status: 409 };
    }
    if (!(await fileExists(review.sidecarPath))) {
      this.opts.store.updateReview(reviewId, { status: "pending", error: SIDECAR_GONE });
      return { error: SIDECAR_GONE, status: 409 };
    }
    this.opts.store.updateReview(reviewId, { status: "keeping" });
    void this.performKeep(reviewId);
    return { accepted: true };
  }

  async keepPending(): Promise<{ accepted: number; skipped: number }> {
    let accepted = 0;
    let skipped = 0;
    for (const id of this.opts.store.pendingReviewIds()) {
      const result = await this.keep(id);
      if ("accepted" in result) accepted += 1;
      else skipped += 1;
    }
    return { accepted, skipped };
  }

  private async performKeep(reviewId: string): Promise<void> {
    const review = this.opts.store.getReview(reviewId);
    if (!review) return;
    const item = this.opts.store.getItem(review.itemId);
    if (!item) {
      this.opts.store.updateReview(reviewId, { status: "pending", error: "The library row disappeared." });
      return;
    }
    if (!(await fileExists(review.sidecarPath))) {
      this.opts.store.updateReview(reviewId, { status: "pending", error: SIDECAR_GONE });
      return;
    }
    const job = this.opts.store.getJob(review.jobId);
    const plan = job ? resolvePlan(job.plan, job.writeMode) : undefined;
    const outcome = await this.withKeepSlot(() =>
      this.promoteOutput(item, review.sidecarPath, review.source.sizeBytes ?? 0, review.sidecar.sizeBytes ?? 0, plan),
    );
    if (!outcome.replaced) {
      this.opts.store.updateReview(reviewId, { status: "pending", error: outcome.error });
      return;
    }
    this.opts.store.addHistory(item.id, "kept", outcome.savedBytes, this.now());
    const synced = await this.syncLibraryFile(item, outcome.destPath, review.sidecar.sizeBytes ?? item.sizeBytes);
    this.deleteReviewsForSidecar(review.sidecarPath);
    const warning = appendWarning(outcome.warning, synced.warning);
    if (warning && job) this.opts.store.updateJob(job.id, { promoteError: warning });
  }

  private async finalizeCompletedKeep(review: ReviewItem, destPath: string): Promise<void> {
    try {
      await removeReviewArtifact(review.sidecarPath);
    } catch {
      // Sidecar may already have been removed after a successful replace.
    }
    const saved = Math.max(0, (review.source.sizeBytes ?? 0) - (review.sidecar.sizeBytes ?? 0));
    this.opts.store.addHistory(review.itemId, "kept", saved, this.now());
    const item = this.opts.store.getItem(review.itemId);
    if (item) await this.syncLibraryFile(item, destPath, review.sidecar.sizeBytes ?? item.sizeBytes);
    else this.opts.store.updateItemFile(review.itemId, destPath, review.sidecar.sizeBytes ?? 0);
    this.deleteReviewsForSidecar(review.sidecarPath);
  }

  private async withKeepSlot<T>(work: () => Promise<T>): Promise<T> {
    const capacity = Math.max(1, this.opts.store.getSettings().concurrency);
    while (this.keepRunning >= capacity) {
      await new Promise<void>((resolve) => this.keepWaiters.push(resolve));
    }
    this.keepRunning += 1;
    try {
      return await work();
    } finally {
      this.keepRunning -= 1;
      this.keepWaiters.shift()?.();
    }
  }

  private async promoteOutput(
    item: NonNullable<ReturnType<Store["getItem"]>>,
    outputPath: string,
    sourceSize: number,
    outputSize: number,
    plan: ReturnType<typeof resolvePlan> | undefined,
  ) {
    const instance = this.opts.store.getInstance(item.instanceId);
    const players = this.opts.store
      .listInstances()
      .map((p) => this.opts.store.getInstance(p.id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.enabled && p.secret && (p.kind === "plex" || p.kind === "jellyfin")))
      .map((p) => ({
        kind: p.kind as "plex" | "jellyfin",
        url: p.url,
        token: this.opts.decrypt(p.secret ?? ""),
      }));
    const promoteFn = this.opts.promote ?? promote;
    const outcome = await promoteFn({
      item,
      outputPath,
      sourceSize,
      outputSize,
      plan,
      decrypt: this.opts.decrypt,
      fetch: this.opts.fetch,
      instance,
      players,
    });
    if (
      outcome.replaced &&
      plan &&
      profileAssignmentEligible({
        autoAssign: this.opts.store.getSettings().profileAutoAssign,
        sizeExempt: item.sizeExempt,
        plan,
      }) &&
      instance?.secret &&
      (instance.kind === "radarr" || instance.kind === "sonarr")
    ) {
      const extra = await assignProfile({
        kind: instance.kind,
        connection: { url: instance.url, apiKey: this.opts.decrypt(instance.secret) },
        movieId: instance.kind === "radarr" ? item.arrId : undefined,
        seriesId: instance.kind === "sonarr" ? (item.arrSeriesId ?? undefined) : undefined,
        profileName: PROFILE_NAMES[plan.category],
        currentQuality: item.quality,
        fetch: this.opts.fetch,
      });
      if (extra) outcome.warning = outcome.warning ? `${outcome.warning} ${extra}` : extra;
    }
    return outcome;
  }

  async requeueFlagged(reviewId: string): Promise<{ id: string } | { error: string; status: number }> {
    const review = this.opts.store.getReview(reviewId);
    if (!review) return { error: "That review item is gone.", status: 404 };
    if (review.status !== "pending") return { error: "Only a waiting sidecar can be encoded smaller.", status: 409 };
    if (!review.flagged) return { error: "Only a flagged sidecar can be encoded smaller.", status: 409 };
    const job = this.opts.store.getJob(review.jobId);
    const item = this.opts.store.getItem(review.itemId);
    if (!item) return { error: "That title is not in the library.", status: 404 };
    const previous = job ? resolvePlan(job.plan, job.writeMode) : undefined;
    const previousTarget = previous?.video.kind === "size"
      ? previous.video.targetBytes
      : review.sidecar.sizeBytes ?? 0;
    const targetBytes = aggressiveTargetBytes(previousTarget);
    const codec = previous?.video.kind === "size" || previous?.video.kind === "quality"
      ? previous.video.codec
      : this.opts.store.getSettings().videoTarget;
    const downscale1080p = previous?.video.kind === "size" || previous?.video.kind === "quality"
      ? previous.video.downscale1080p
      : false;
    const bitDepth = previous?.video.kind === "size" || previous?.video.kind === "quality"
      ? previous.video.bitDepth
      : 8;
    const discarded = await this.discard(reviewId);
    if ("error" in discarded) return discarded;
    return this.enqueueCustom(item.id, {
      origin: "custom",
      video: { kind: "size", codec, targetBytes, downscale1080p, bitDepth },
      audio: previous?.audio ?? [],
      subtitles: previous?.subtitles ?? [],
      container: "mkv",
      remuxInput: previous?.remuxInput,
      writeMode: "sidecar",
      warning: previous?.warning ?? null,
      reasons: ["Smaller encode after a missed size target."],
      estimatedOutputBytes: targetBytes,
      category: previous?.category ?? "movie1080p",
    });
  }

  async discard(reviewId: string): Promise<{ accepted: true } | { error: string; status: number }> {
    const review = this.opts.store.getReview(reviewId);
    if (!review) return { error: "That review item is gone.", status: 404 };
    this.opts.store.updateReview(reviewId, { status: "discarding" });
    await this.unlinkSidecarIfLast(review);
    this.opts.store.deleteReview(reviewId);
    this.opts.store.addHistory(review.itemId, "discarded", 0, this.now());
    return { accepted: true };
  }

  private async unlinkSidecarIfLast(review: ReviewItem): Promise<void> {
    const others = this.opts.store.reviewsForSidecarPath(review.sidecarPath).filter((row) => row.id !== review.id);
    if (others.length > 0) return;
    await removeReviewArtifact(review.sidecarPath);
  }

  private deleteReviewsForSidecar(sidecarPath: string): void {
    for (const row of this.opts.store.reviewsForSidecarPath(sidecarPath)) {
      this.opts.store.deleteReview(row.id);
    }
  }

  private async syncLibraryFile(
    item: NonNullable<ReturnType<Store["getItem"]>>,
    destPath: string,
    sizeBytes: number,
  ): Promise<{ warning: string | null }> {
    const oldPath = item.path;
    const siblings = this.opts.store.itemsForPath(item.path, item.instanceId);
    const targets = siblings.length > 0 ? siblings : [item];
    for (const sibling of targets) {
      this.opts.store.updateItemFile(sibling.id, destPath, sizeBytes);
      this.opts.store.markKeptSize(sibling.id, sizeBytes);
    }
    const warnings: string[] = [];
    const instance = this.opts.store.getInstance(item.instanceId);
    if (instance?.secret && (instance.kind === "radarr" || instance.kind === "sonarr")) {
      const renamed = await refreshAndRenameArr({
        kind: instance.kind,
        url: instance.url,
        apiKey: this.opts.decrypt(instance.secret),
        movieId: instance.kind === "radarr" ? item.arrId : undefined,
        seriesId: instance.kind === "sonarr" ? (item.arrSeriesId ?? undefined) : undefined,
        episodeFileId: item.arrEpisodeFileId,
        currentPath: destPath,
        fetch: this.opts.fetch,
        sleep: this.opts.sleep,
        now: this.opts.clock,
      });
      if (renamed.warning) warnings.push(renamed.warning);
      if (renamed.path && renamed.path !== destPath && await fileExists(renamed.path)) {
        for (const sibling of targets) {
          this.opts.store.updateItemFile(sibling.id, renamed.path, sizeBytes);
          this.opts.store.markKeptSize(sibling.id, sizeBytes);
        }
      }
    }
    for (const sibling of targets) {
      const result = await this.opts.reinspectChangedItem(sibling.id, oldPath);
      if (!result.ok) warnings.push(`The new file could not be inspected: ${result.warning}`);
    }
    return { warning: warnings.length > 0 ? warnings.join(" ") : null };
  }

  private now(): number {
    return this.opts.clock?.() ?? Date.now();
  }
}

export function assignedToNode(assignedNodeId: string | null | undefined, localNodeId: string): boolean {
  return !assignedNodeId || assignedNodeId === localNodeId;
}

function jobPhaseOr(value: string, fallback: JobPhase): JobPhase {
  if (
    value === "queued" || value === "held" || value === "paused" || value === "copying"
    || value === "muxing" || value === "creating_stereo" || value === "transcoding" || value === "finishing" || value === "idle"
  ) {
    return value;
  }
  return fallback;
}

export function insideWindow(start: string, end: string, now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s <= e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}



async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function appendWarning(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next) return current;
  return `${current} ${next}`;
}
