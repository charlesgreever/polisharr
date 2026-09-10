import type { HardwareInfo } from "./types.ts";

export type NodeRole = "standalone" | "master" | "worker";

export type ClusterNode = {
  id: string;
  name: string;
  role: NodeRole;
  lastSeen: number;
  hardware: HardwareInfo;
  concurrency: number;
  enabled: boolean;
  version: string;
  currentJobId: string | null;
};

export function parseNodeRole(value: unknown): NodeRole {
  return value === "master" || value === "worker" ? value : "standalone";
}

export function parseHardwareInfo(value: unknown): HardwareInfo {
  const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const backend = raw.backend === "cuda" || raw.backend === "vaapi" ? raw.backend : "none";
  return {
    backend,
    cuda: raw.cuda === true,
    vaapi: raw.vaapi === true,
    av1: raw.av1 === true,
    reason: typeof raw.reason === "string" ? raw.reason : backend === "none" ? "No hardware encoder is visible." : null,
    vaapiDevice: typeof raw.vaapiDevice === "string" ? raw.vaapiDevice : raw.vaapiDevice === null ? null : undefined,
    gpuName: typeof raw.gpuName === "string" ? raw.gpuName : raw.gpuName === null ? null : undefined,
  };
}

export function nodeHardwareLabel(hardware: HardwareInfo): string {
  if (hardware.backend === "cuda") {
    return hardware.av1 ? "NVIDIA GPU, AV1 encoder listed" : "NVIDIA GPU, AV1 encoder not listed";
  }
  if (hardware.backend === "vaapi") {
    return hardware.av1 ? "Intel or AMD GPU, AV1 encoder listed" : "Intel or AMD GPU, AV1 encoder not listed";
  }
  return hardware.reason ?? "No hardware encoder is visible.";
}

export function nodeRoleLabel(role: NodeRole, thisNode: boolean): string {
  if (role === "master") return thisNode ? "Master (this UI and library)" : "Master";
  if (role === "worker") return thisNode ? "Worker (this container)" : "Worker";
  return thisNode ? "This machine" : "Standalone";
}

export const HEARTBEAT_MS = 10_000;
export const NODE_STALE_MS = 60_000;
export const LEASE_MS = 30_000;

export const CLUSTER_WRONG_TOKEN = "The cluster token is wrong.";
export const CLUSTER_NOT_MASTER = "This Polisharr is not accepting workers. Set POLISHARR_ROLE=master on the always-on host.";
export const CLUSTER_UNKNOWN_NODE = "That node is not registered.";
export const WORKER_MANAGE_ERROR = "This container is a worker. Open the master to manage the library.";

export function nodeIsOnline(lastSeen: number, now: number): boolean {
  return now - lastSeen <= NODE_STALE_MS;
}

export type EncodeNeed = "copy" | "hevc" | "av1";

export function encodeNeedFromPlan(plan: { video?: { kind?: string; codec?: string } } | null | undefined): EncodeNeed {
  if (!plan?.video || plan.video.kind === "copy") return "copy";
  return plan.video.codec === "av1" ? "av1" : "hevc";
}

export function nodeCanEncode(node: { enabled?: boolean; hardware: HardwareInfo }, need: EncodeNeed): boolean {
  if (need === "copy") return true;
  if (node.hardware.backend === "none") return false;
  if (need === "av1") return node.hardware.av1 === true;
  return true;
}

export function clusterHasAv1(nodes: Array<{ enabled: boolean; lastSeen: number; hardware: HardwareInfo }>, now: number): boolean {
  return nodes.some((node) => node.enabled && nodeIsOnline(node.lastSeen, now) && node.hardware.av1);
}

export function clusterHasHardware(nodes: Array<{ enabled: boolean; lastSeen: number; hardware: HardwareInfo }>, now: number): boolean {
  return nodes.some((node) => node.enabled && nodeIsOnline(node.lastSeen, now) && node.hardware.backend !== "none");
}

export type ClusterHello = {
  nodeId: string;
  name: string;
  version: string;
  hardware: HardwareInfo;
  concurrency: number;
};

export type ClusterHeartbeat = {
  nodeId: string;
  hardware: HardwareInfo;
  concurrency: number;
  currentJobId: string | null;
  runningJobIds: string[];
};

export function parseClusterHello(value: unknown): { ok: true; hello: ClusterHello } | { ok: false; error: string } {
  const raw = record(value);
  const nodeId = trimString(raw.nodeId);
  if (!nodeId) return { ok: false, error: "A node id is required." };
  const name = trimString(raw.name);
  if (!name) return { ok: false, error: "A node name is required." };
  const version = trimString(raw.version) || "unknown";
  const concurrency = parseConcurrency(raw.concurrency);
  if (concurrency == null) return { ok: false, error: "The concurrency value is invalid." };
  return {
    ok: true,
    hello: {
      nodeId,
      name,
      version,
      hardware: parseHardwareInfo(raw.hardware),
      concurrency,
    },
  };
}

export function parseClusterHeartbeat(value: unknown): { ok: true; beat: ClusterHeartbeat } | { ok: false; error: string } {
  const raw = record(value);
  const nodeId = trimString(raw.nodeId);
  if (!nodeId) return { ok: false, error: "A node id is required." };
  const concurrency = parseConcurrency(raw.concurrency);
  if (concurrency == null) return { ok: false, error: "The concurrency value is invalid." };
  const runningJobIds = Array.isArray(raw.runningJobIds)
    ? raw.runningJobIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const currentJobId = typeof raw.currentJobId === "string" && raw.currentJobId.trim()
    ? raw.currentJobId.trim()
    : null;
  return {
    ok: true,
    beat: {
      nodeId,
      hardware: parseHardwareInfo(raw.hardware),
      concurrency,
      currentJobId,
      runningJobIds,
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type RemoteJobDocument = {
  id: string;
  leaseToken: string;
  sourcePath: string;
  reviewDir: string;
  plan: unknown;
  report: unknown;
  target: "hevc" | "av1";
  conservative: boolean;
  writeMode: "sidecar" | "direct";
  nodeId: string;
};

export function parseClusterClaim(value: unknown): { ok: true; nodeId: string; freeSlots: number } | { ok: false; error: string } {
  const raw = record(value);
  const nodeId = trimString(raw.nodeId);
  if (!nodeId) return { ok: false, error: "A node id is required." };
  const freeSlots = raw.freeSlots === undefined ? 1 : raw.freeSlots;
  if (typeof freeSlots !== "number" || !Number.isSafeInteger(freeSlots) || freeSlots < 0 || freeSlots > 16) {
    return { ok: false, error: "The freeSlots value is invalid." };
  }
  return { ok: true, nodeId, freeSlots };
}

export function parseRemoteProgress(value: unknown): { ok: true; leaseToken: string; phase: string | null; progress: number | null; log: string } | { ok: false; error: string } {
  const raw = record(value);
  const leaseToken = trimString(raw.leaseToken);
  if (!leaseToken) return { ok: false, error: "A lease token is required." };
  const phase = trimString(raw.phase) || null;
  if (raw.progress !== undefined && (typeof raw.progress !== "number" || !Number.isFinite(raw.progress))) {
    return { ok: false, error: "Progress is invalid." };
  }
  return {
    ok: true,
    leaseToken,
    phase,
    progress: typeof raw.progress === "number" ? Math.min(1, Math.max(0, raw.progress)) : null,
    log: typeof raw.log === "string" ? raw.log : "",
  };
}

export function parseRemoteComplete(value: unknown): { ok: true; leaseToken: string; sidecarPath: string; output: Record<string, unknown> } | { ok: false; error: string } {
  const raw = record(value);
  const leaseToken = trimString(raw.leaseToken);
  const sidecarPath = trimString(raw.sidecarPath);
  if (!leaseToken) return { ok: false, error: "A lease token is required." };
  if (!sidecarPath) return { ok: false, error: "A sidecar path is required." };
  const output = raw.output !== null && typeof raw.output === "object" && !Array.isArray(raw.output)
    ? (raw.output as Record<string, unknown>)
    : null;
  if (!output) return { ok: false, error: "An output probe is required." };
  return { ok: true, leaseToken, sidecarPath, output };
}

export function parseRemoteFail(value: unknown): { ok: true; leaseToken: string; error: string } | { ok: false; error: string } {
  const raw = record(value);
  const leaseToken = trimString(raw.leaseToken);
  if (!leaseToken) return { ok: false, error: "A lease token is required." };
  const error = trimString(raw.error) || "The job failed.";
  return { ok: true, leaseToken, error };
}

function parseConcurrency(value: unknown): number | null {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 16) return null;
  return value;
}
