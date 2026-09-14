import {
  CLUSTER_NOT_MASTER,
  CLUSTER_UNKNOWN_NODE,
  CLUSTER_WRONG_TOKEN,
  HEARTBEAT_MS,
  PREVIEW_LEASE_MS,
  PREVIEW_LEASE_RENEW_MIN_MS,
  PREVIEW_TIMEOUT_MS,
  nodeCanPreview,
  parseRemotePreviewDocument,
  type ClusterHello,
  type PreviewCapability,
  type RemoteJobDocument,
  type RemotePreviewDocument,
} from "./cluster.ts";
import type { HardwareInfo, InspectionReport } from "./types.ts";
import { CancelledError, isExecutablePlan, removeReviewArtifact, resolvePlan, type Optimizer } from "./optimize.ts";
import type { PreviewRenderer } from "./review-previews.ts";

export type WorkerJoinStatus = "misconfigured" | "connecting" | "connected" | "unreachable" | "rejected";

export type WorkerJoinState = {
  status: WorkerJoinStatus;
  detail: string;
  masterUrl: string | null;
  registered: boolean;
  currentJobId: string | null;
};

export type WorkerLoopOptions = {
  nodeId: string;
  name: string;
  version: string;
  masterUrl: string | null;
  token: string | null;
  hardware: () => Promise<HardwareInfo>;
  concurrency: () => number;
  fetch: typeof fetch;
  intervalMs?: number;
  optimizer?: Optimizer;
  tools?: { ffmpeg: string; ffprobe: string; mkvmerge: string };
  previewCapability?: () => Promise<PreviewCapability | null>;
  previewRenderer?: PreviewRenderer;
  monotonic?: () => number;
  watchdogMs?: number;
};

type Inflight = {
  cancelled: boolean;
  sidecarPath: string | null;
  leaseToken: string;
};

type PreviewInflight = {
  cancelled: boolean;
  leaseToken: string;
  deadline: number;
  lastRenew: number;
  started: number;
  children: Array<{ kill: (signal?: NodeJS.Signals | number) => boolean | void }>;
  disconnected: boolean;
};

export class WorkerLoop {
  private timer: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private registered = false;
  private status: WorkerJoinStatus = "connecting";
  private detail = "";
  private inflight = new Map<string, Inflight>();
  private previewInflight = new Map<string, PreviewInflight>();
  private slots: number | null = null;
  private previewCap: PreviewCapability | null = null;

  constructor(private readonly opts: WorkerLoopOptions) {
    if (!opts.masterUrl || !opts.token) {
      this.status = "misconfigured";
      this.detail = "Set POLISHARR_MASTER_URL and POLISHARR_CLUSTER_TOKEN so this worker can join the master.";
    } else {
      this.status = "connecting";
      this.detail = `Joining the master at ${opts.masterUrl}.`;
    }
  }

  snapshot(): WorkerJoinState {
    const currentJobId = [...this.inflight.keys()][0] ?? null;
    return {
      status: this.status,
      detail: this.detail,
      masterUrl: this.opts.masterUrl,
      registered: this.registered,
      currentJobId,
    };
  }

  start(): void {
    void this.tick();
    const intervalMs = this.opts.intervalMs ?? HEARTBEAT_MS;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    const watchdogMs = this.opts.watchdogMs ?? 1_000;
    this.watchdog = setInterval(() => void this.watchPreviewLeases(), watchdogMs);
    this.watchdog.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    for (const job of this.inflight.values()) job.cancelled = true;
    for (const preview of this.previewInflight.values()) {
      preview.cancelled = true;
      this.killPreviewChildren(preview);
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
      await this.watchPreviewLeases();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    if (!this.opts.masterUrl || !this.opts.token) return;
    if (this.registered) {
      const runningJobIds = [...this.inflight.keys()];
      const preview = await this.currentPreviewCapability();
      const beat = await this.postJson<{ cancelJobIds?: unknown; cancelPreviewIds?: unknown; concurrency?: unknown }>("/api/cluster/heartbeat", {
        nodeId: this.opts.nodeId,
        hardware: await this.opts.hardware(),
        concurrency: this.opts.concurrency(),
        currentJobId: runningJobIds[0] ?? null,
        runningJobIds,
        preview,
        runningPreviewIds: [...this.previewInflight.keys()],
      });
      if (beat.ok) {
        this.status = "connected";
        this.detail = `Joined the master at ${this.opts.masterUrl}.`;
        this.readSlots(beat.data.concurrency);
        const cancelIds = Array.isArray(beat.data.cancelJobIds)
          ? beat.data.cancelJobIds.filter((id): id is string => typeof id === "string")
          : [];
        for (const id of cancelIds) this.markCancelled(id);
        const cancelPreviewIds = Array.isArray(beat.data.cancelPreviewIds)
          ? beat.data.cancelPreviewIds.filter((id): id is string => typeof id === "string")
          : [];
        for (const id of cancelPreviewIds) this.markPreviewCancelled(id);
        await this.claimWork();
        return;
      }
      if (beat.status === 401) {
        this.registered = false;
        this.status = "rejected";
        this.detail = CLUSTER_WRONG_TOKEN;
        return;
      }
      if (beat.status === 404) {
        this.registered = false;
      } else {
        this.status = "unreachable";
        this.detail = `Cannot reach the master at ${this.opts.masterUrl}. Encodes stay idle until it is reachable.`;
        this.markPreviewsDisconnected();
        return;
      }
    }
    const hello = await this.postJson<{ concurrency?: unknown }>("/api/cluster/hello", await this.helloBody());
    if (hello.ok) {
      this.registered = true;
      this.status = "connected";
      this.detail = `Joined the master at ${this.opts.masterUrl}.`;
      this.readSlots(hello.data.concurrency);
      await this.claimWork();
      return;
    }
    this.registered = false;
    if (hello.status === 401) {
      this.status = "rejected";
      this.detail = CLUSTER_WRONG_TOKEN;
      return;
    }
    if (hello.status === 404) {
      this.status = "rejected";
      this.detail = hello.error || CLUSTER_NOT_MASTER;
      return;
    }
    this.status = "unreachable";
    this.detail = `Cannot reach the master at ${this.opts.masterUrl}. Encodes stay idle until it is reachable.`;
    this.markPreviewsDisconnected();
  }

  private async claimWork(): Promise<void> {
    if (this.advertisesPreview()) {
      await this.claimPreviews();
    }
    if (!this.opts.optimizer || !this.opts.tools) return;
    const freeSlots = this.freeSlots();
    if (freeSlots <= 0) return;
    const claimed = await this.postJson<{ jobs?: unknown }>("/api/cluster/claim", {
      nodeId: this.opts.nodeId,
      freeSlots,
    });
    if (!claimed.ok || !Array.isArray(claimed.data.jobs)) return;
    for (const raw of claimed.data.jobs) {
      const job = raw as RemoteJobDocument;
      if (!job || typeof job.id !== "string" || typeof job.leaseToken !== "string") continue;
      if ((job as { kind?: unknown }).kind === "preview") continue;
      if (this.inflight.has(job.id) || this.previewInflight.has(job.id)) continue;
      this.inflight.set(job.id, { cancelled: false, sidecarPath: null, leaseToken: job.leaseToken });
      void this.runJob(job);
    }
  }

  private async claimPreviews(): Promise<void> {
    if (!this.opts.previewRenderer) return;
    const freeSlots = this.freeSlots();
    if (freeSlots <= 0) return;
    const fetchStarted = this.monotonic();
    const claimed = await this.postJson<{ previews?: unknown }>("/api/cluster/previews/claim", {
      nodeId: this.opts.nodeId,
      freeSlots,
    });
    const elapsed = this.monotonic() - fetchStarted;
    if (!claimed.ok || !Array.isArray(claimed.data.previews)) return;
    for (const raw of claimed.data.previews) {
      const parsed = parseRemotePreviewDocument(raw);
      if (!parsed.ok) continue;
      const preview = parsed.preview;
      if (this.previewInflight.has(preview.id) || this.inflight.has(preview.id)) continue;
      const remaining = Math.max(0, PREVIEW_LEASE_MS - elapsed);
      this.previewInflight.set(preview.id, {
        cancelled: false,
        leaseToken: preview.leaseToken,
        deadline: this.monotonic() + remaining,
        lastRenew: this.monotonic(),
        started: this.monotonic(),
        children: [],
        disconnected: false,
      });
      void this.runPreview(preview);
    }
  }

  private async runJob(job: RemoteJobDocument): Promise<void> {
    const optimizer = this.opts.optimizer;
    const tools = this.opts.tools;
    if (!optimizer || !tools) return;
    const slot = this.inflight.get(job.id);
    if (!slot) return;
    try {
      const hardware = await this.opts.hardware();
      const plan = isExecutablePlan(job.plan) ? resolvePlan(job.plan, job.writeMode) : undefined;
      const result = await optimizer({
        sourcePath: job.sourcePath,
        reviewDir: job.reviewDir,
        plan,
        report: job.report as InspectionReport,
        target: job.target,
        backend: hardware.backend,
        vaapiDevice: hardware.vaapiDevice,
        qsv: hardware.qsv === true,
        ffmpeg: tools.ffmpeg,
        ffprobe: tools.ffprobe,
        mkvmerge: tools.mkvmerge,
        conservative: job.conservative,
        jobId: job.id,
        nodeId: this.opts.nodeId,
        onPhase: (phase, progress) => {
          void this.postJson(`/api/cluster/jobs/${job.id}/progress`, {
            leaseToken: slot.leaseToken,
            phase,
            progress,
          });
        },
        onLog: (text) => {
          void this.postJson(`/api/cluster/jobs/${job.id}/progress`, {
            leaseToken: slot.leaseToken,
            log: text,
          });
        },
        isCancelled: () => Boolean(this.inflight.get(job.id)?.cancelled),
      });
      slot.sidecarPath = result.sidecarPath;
      if (slot.cancelled || this.inflight.get(job.id)?.cancelled) {
        await removeReviewArtifact(result.sidecarPath);
        return;
      }
      const done = await this.postJson(`/api/cluster/jobs/${job.id}/complete`, {
        leaseToken: slot.leaseToken,
        sidecarPath: result.sidecarPath,
        output: result.output,
      });
      if (!done.ok && done.status === 409) await removeReviewArtifact(result.sidecarPath);
    } catch (error) {
      if (error instanceof CancelledError || slot.cancelled) {
        if (slot.sidecarPath) await removeReviewArtifact(slot.sidecarPath);
        return;
      }
      const message = error instanceof Error ? error.message : "The job failed.";
      await this.postJson(`/api/cluster/jobs/${job.id}/fail`, {
        leaseToken: slot.leaseToken,
        error: message,
      });
    } finally {
      this.inflight.delete(job.id);
    }
  }

  private readSlots(value: unknown): void {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 16) this.slots = value;
  }

  private markCancelled(id: string): void {
    const slot = this.inflight.get(id);
    if (slot) slot.cancelled = true;
  }

  private markPreviewCancelled(id: string): void {
    const slot = this.previewInflight.get(id);
    if (!slot) return;
    slot.cancelled = true;
    this.killPreviewChildren(slot);
  }

  private markPreviewsDisconnected(): void {
    for (const slot of this.previewInflight.values()) slot.disconnected = true;
  }

  private killPreviewChildren(slot: PreviewInflight): void {
    for (const child of slot.children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already have exited.
      }
    }
  }

  private freeSlots(): number {
    return Math.max(0, (this.slots ?? this.opts.concurrency()) - this.inflight.size - this.previewInflight.size);
  }

  private monotonic(): number {
    return this.opts.monotonic?.() ?? performance.now();
  }

  private advertisesPreview(): boolean {
    return nodeCanPreview({ preview: this.previewCap });
  }

  private async currentPreviewCapability(): Promise<PreviewCapability | null> {
    if (!this.opts.previewCapability) return null;
    this.previewCap = await this.opts.previewCapability();
    return this.previewCap;
  }

  private async runPreview(preview: RemotePreviewDocument): Promise<void> {
    const renderer = this.opts.previewRenderer;
    const slot = this.previewInflight.get(preview.id);
    if (!renderer || !slot) return;
    try {
      const result = await renderer(preview, {
        isCancelled: () => Boolean(this.previewInflight.get(preview.id)?.cancelled),
        onProgress: (progress) => {
          void this.renewPreview(preview.id, progress);
        },
        registerChild: (child) => {
          this.previewInflight.get(preview.id)?.children.push(child);
        },
      });
      const latest = this.previewInflight.get(preview.id);
      if (!latest || latest.cancelled || latest.disconnected) return;
      if (result.ok) {
        await this.postJson(`/api/cluster/previews/${preview.id}/complete`, { leaseToken: latest.leaseToken });
      } else {
        await this.postJson(`/api/cluster/previews/${preview.id}/fail`, { leaseToken: latest.leaseToken, error: result.error });
      }
    } catch (error) {
      const latest = this.previewInflight.get(preview.id);
      if (!latest || latest.cancelled) return;
      const message = error instanceof Error ? error.message : "The preview failed.";
      await this.postJson(`/api/cluster/previews/${preview.id}/fail`, { leaseToken: latest.leaseToken, error: message });
    } finally {
      this.previewInflight.delete(preview.id);
    }
  }

  private async renewPreview(id: string, progress: number | null): Promise<void> {
    const slot = this.previewInflight.get(id);
    if (!slot || slot.cancelled) return;
    const now = this.monotonic();
    if (progress == null && now - slot.lastRenew < PREVIEW_LEASE_RENEW_MIN_MS) return;
    const fetchStarted = this.monotonic();
    const done = await this.postJson<{ ok?: unknown; cancelled?: unknown }>(`/api/cluster/previews/${id}/progress`, {
      leaseToken: slot.leaseToken,
      progress,
    });
    const elapsed = this.monotonic() - fetchStarted;
    if (!done.ok) {
      if (done.status === 409) slot.cancelled = true;
      else slot.disconnected = true;
      if (slot.cancelled) this.killPreviewChildren(slot);
      return;
    }
    if (now - slot.lastRenew >= PREVIEW_LEASE_RENEW_MIN_MS) {
      slot.lastRenew = this.monotonic();
      slot.deadline = this.monotonic() + Math.max(0, PREVIEW_LEASE_MS - elapsed);
    }
  }

  private async watchPreviewLeases(): Promise<void> {
    const now = this.monotonic();
    for (const [id, slot] of this.previewInflight) {
      if (slot.cancelled) {
        this.killPreviewChildren(slot);
        continue;
      }
      if (now - slot.started > PREVIEW_TIMEOUT_MS) {
        slot.cancelled = true;
        this.killPreviewChildren(slot);
        continue;
      }
      if (slot.disconnected && now >= slot.deadline) {
        slot.cancelled = true;
        this.killPreviewChildren(slot);
        continue;
      }
      if (!slot.disconnected && now - slot.lastRenew >= PREVIEW_LEASE_RENEW_MIN_MS) {
        await this.renewPreview(id, null);
      }
    }
  }

  private async helloBody(): Promise<ClusterHello> {
    return {
      nodeId: this.opts.nodeId,
      name: this.opts.name,
      version: this.opts.version,
      hardware: await this.opts.hardware(),
      concurrency: this.opts.concurrency(),
      preview: await this.currentPreviewCapability(),
    };
  }

  private async postJson<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
    const url = joinMasterPath(this.opts.masterUrl ?? "", path);
    if (!url) {
      return { ok: false, status: 0, error: CLUSTER_NOT_MASTER };
    }
    try {
      const res = await this.opts.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as T & { error?: unknown };
      const error = typeof payload.error === "string" ? payload.error : "";
      if (res.ok) return { ok: true, data: payload };
      return { ok: false, status: res.status, error: error || (res.status === 404 ? CLUSTER_UNKNOWN_NODE : CLUSTER_WRONG_TOKEN) };
    } catch {
      return { ok: false, status: 0, error: "unreachable" };
    }
  }
}

export function joinMasterPath(masterUrl: string, path: string): string | null {
  try {
    const base = masterUrl.endsWith("/") ? masterUrl : `${masterUrl}/`;
    const url = new URL(path.replace(/^\//, ""), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}


