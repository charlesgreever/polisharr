import { unlink } from "node:fs/promises";
import {
  CLUSTER_NOT_MASTER,
  CLUSTER_UNKNOWN_NODE,
  CLUSTER_WRONG_TOKEN,
  HEARTBEAT_MS,
  type ClusterHello,
  type RemoteJobDocument,
} from "./cluster.ts";
import type { HardwareInfo, InspectionReport } from "./types.ts";
import { CancelledError, isExecutablePlan, resolvePlan, type Optimizer } from "./optimize.ts";

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
};

type Inflight = {
  cancelled: boolean;
  sidecarPath: string | null;
  leaseToken: string;
};

export class WorkerLoop {
  private timer: ReturnType<typeof setInterval> | undefined;
  private registered = false;
  private status: WorkerJoinStatus = "connecting";
  private detail = "";
  private inflight = new Map<string, Inflight>();
  private slots: number | null = null;

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
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const job of this.inflight.values()) job.cancelled = true;
  }

  async tick(): Promise<void> {
    if (!this.opts.masterUrl || !this.opts.token) return;
    if (this.registered) {
      const runningJobIds = [...this.inflight.keys()];
      const beat = await this.postJson<{ cancelJobIds?: unknown; concurrency?: unknown }>("/api/cluster/heartbeat", {
        nodeId: this.opts.nodeId,
        hardware: await this.opts.hardware(),
        concurrency: this.opts.concurrency(),
        currentJobId: runningJobIds[0] ?? null,
        runningJobIds,
      });
      if (beat.ok) {
        this.status = "connected";
        this.detail = `Joined the master at ${this.opts.masterUrl}.`;
        this.readSlots(beat.data.concurrency);
        const cancelIds = Array.isArray(beat.data.cancelJobIds)
          ? beat.data.cancelJobIds.filter((id): id is string => typeof id === "string")
          : [];
        for (const id of cancelIds) this.markCancelled(id);
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
  }

  private async claimWork(): Promise<void> {
    if (!this.opts.optimizer || !this.opts.tools) return;
    const freeSlots = Math.max(0, (this.slots ?? this.opts.concurrency()) - this.inflight.size);
    if (freeSlots <= 0) return;
    const claimed = await this.postJson<{ jobs?: unknown }>("/api/cluster/claim", {
      nodeId: this.opts.nodeId,
      freeSlots,
    });
    if (!claimed.ok || !Array.isArray(claimed.data.jobs)) return;
    for (const raw of claimed.data.jobs) {
      const job = raw as RemoteJobDocument;
      if (!job || typeof job.id !== "string" || typeof job.leaseToken !== "string") continue;
      if (this.inflight.has(job.id)) continue;
      this.inflight.set(job.id, { cancelled: false, sidecarPath: null, leaseToken: job.leaseToken });
      void this.runJob(job);
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
            phase: "transcoding",
            progress: 0,
            log: text,
          });
        },
        isCancelled: () => Boolean(this.inflight.get(job.id)?.cancelled),
      });
      slot.sidecarPath = result.sidecarPath;
      if (slot.cancelled || this.inflight.get(job.id)?.cancelled) {
        await safeUnlink(result.sidecarPath);
        return;
      }
      const done = await this.postJson(`/api/cluster/jobs/${job.id}/complete`, {
        leaseToken: slot.leaseToken,
        sidecarPath: result.sidecarPath,
        output: result.output,
      });
      if (!done.ok && done.status === 409) await safeUnlink(result.sidecarPath);
    } catch (error) {
      if (error instanceof CancelledError || slot.cancelled) {
        if (slot.sidecarPath) await safeUnlink(slot.sidecarPath);
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

  private async helloBody(): Promise<ClusterHello> {
    return {
      nodeId: this.opts.nodeId,
      name: this.opts.name,
      version: this.opts.version,
      hardware: await this.opts.hardware(),
      concurrency: this.opts.concurrency(),
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

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The sidecar may already be gone after cancel.
  }
}
