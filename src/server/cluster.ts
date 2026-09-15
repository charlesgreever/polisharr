import type { HardwareInfo, PreviewH264Encoder, PreviewRequest } from "./types.ts";

export type { PreviewRequest };

export type NodeRole = "standalone" | "master" | "worker";

export const PREVIEW_PROTOCOL_VERSION = 1;
export const PREVIEW_SDR_1080P_PROFILE = "sdr-1080p-h264";
export const PREVIEW_LEASE_MS = 30_000;
export const PREVIEW_LEASE_RENEW_MIN_MS = 10_000;
export const PREVIEW_LEASE_SAFETY_MARGIN_MS = 5_000;
export const PREVIEW_TIMEOUT_MS = 5 * 60_000;
export const PREVIEW_MAX_PER_NODE = 1;
export const PREVIEW_MAX_GLOBAL = 2;

export type PreviewCapability = {
  protocolVersion: number;
  h264Encoder: PreviewH264Encoder | null;
  profiles: string[];
};

export const NO_PREVIEW_CAPABILITY: PreviewCapability = {
  protocolVersion: PREVIEW_PROTOCOL_VERSION,
  h264Encoder: null,
  profiles: [],
};

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
  preview?: PreviewCapability | null;
};

export function parseNodeRole(value: unknown): NodeRole {
  return value === "master" || value === "worker" ? value : "standalone";
}

export function parseHardwareInfo(value: unknown): HardwareInfo {
  const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const backend = raw.backend === "cuda" || raw.backend === "vaapi" || raw.backend === "videotoolbox" ? raw.backend : "none";
  return {
    backend,
    cuda: raw.cuda === true,
    vaapi: raw.vaapi === true,
    videotoolbox: raw.videotoolbox === true || backend === "videotoolbox",
    av1: raw.av1 === true,
    reason: typeof raw.reason === "string" ? raw.reason : backend === "none" ? "No hardware encoder is visible." : null,
    vaapiDevice: typeof raw.vaapiDevice === "string" ? raw.vaapiDevice : raw.vaapiDevice === null ? null : undefined,
    gpuName: typeof raw.gpuName === "string" ? raw.gpuName : raw.gpuName === null ? null : undefined,
    qsv: raw.qsv === true,
  };
}

export function nodeHardwareLabel(hardware: HardwareInfo): string {
  if (hardware.backend === "cuda") {
    return hardware.av1 ? "NVIDIA GPU, AV1 encoder listed" : "NVIDIA GPU, AV1 encoder not listed";
  }
  if (hardware.backend === "vaapi") {
    return hardware.av1 ? "Intel or AMD GPU, AV1 encoder listed" : "Intel or AMD GPU, AV1 encoder not listed";
  }
  if (hardware.backend === "videotoolbox") {
    return hardware.av1 ? "Apple media engine, AV1 encoder listed" : "Apple media engine, AV1 encoder not listed";
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

export const ANY_OPEN_NODE_ID = "any";

export function isAnyOpenNode(id: string | null | undefined): boolean {
  return id === ANY_OPEN_NODE_ID;
}

export function pickOpenEncodeNode(
  nodes: Array<{
    id: string;
    name: string;
    enabled: boolean;
    lastSeen: number;
    concurrency: number;
    runningCount: number;
    hardware: HardwareInfo;
  }>,
  need: EncodeNeed,
  now: number,
  preferredId?: string,
  excludedIds?: Iterable<string>,
): { id: string; name: string } | null {
  const excluded = new Set(excludedIds ?? []);
  const capable = nodes.filter(
    (node) => !excluded.has(node.id) && node.enabled && nodeIsOnline(node.lastSeen, now) && nodeCanEncode(node, need),
  );
  if (capable.length === 0) return null;
  const preferred = preferredId && !isAnyOpenNode(preferredId) ? preferredId : "";
  capable.sort((left, right) => {
    if (left.runningCount !== right.runningCount) return left.runningCount - right.runningCount;
    const freeLeft = left.concurrency - left.runningCount;
    const freeRight = right.concurrency - right.runningCount;
    if (freeRight !== freeLeft) return freeRight - freeLeft;
    if (preferred && left.id === preferred && right.id !== preferred) return -1;
    if (preferred && right.id === preferred && left.id !== preferred) return 1;
    return left.name.localeCompare(right.name);
  });
  return capable[0] ? { id: capable[0].id, name: capable[0].name } : null;
}

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

export function poolSpreadLimit(freeSlots: number, pool: number, peerFreeSlots: number): number {
  if (freeSlots <= 0 || pool <= 0) return 0;
  if (peerFreeSlots <= 0) return Math.min(freeSlots, pool);
  if (pool <= freeSlots + peerFreeSlots) return 1;
  return Math.min(freeSlots, pool);
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
  preview: PreviewCapability | null;
};

export type ClusterHeartbeat = {
  nodeId: string;
  hardware: HardwareInfo;
  concurrency: number;
  currentJobId: string | null;
  runningJobIds: string[];
  preview: PreviewCapability | null;
  runningPreviewIds: string[];
};

export type PreviewRenderPlan = {
  cacheDir: string;
  startMs: number;
  durationMs: number;
  originalVideoIndex: number;
  sidecarVideoIndex: number;
  originalAudioIndex: number;
  sidecarAudioIndex: number;
  originalWidth: number;
  originalHeight: number;
  finishedWidth: number;
  finishedHeight: number;
  tonemap?: boolean;
};

export type RemotePreviewDocument = {
  kind: "preview";
  protocolVersion: number;
  id: string;
  leaseToken: string;
  leaseUntil: number;
  reviewId: string;
  sourcePath: string;
  sidecarPath: string;
  request: PreviewRequest;
  profileId: string;
  nodeId: string;
  cacheDir: string;
  render: PreviewRenderPlan | null;
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
      preview: parsePreviewCapability(raw.preview),
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
      preview: parsePreviewCapability(raw.preview),
      runningPreviewIds: Array.isArray(raw.runningPreviewIds)
        ? raw.runningPreviewIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [],
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

export function parsePreviewCapability(value: unknown): PreviewCapability | null {
  if (value == null) return null;
  const raw = record(value);
  if (raw.protocolVersion !== PREVIEW_PROTOCOL_VERSION) return null;
  const encoder = raw.h264Encoder;
  const h264Encoder =
    encoder === "h264_nvenc" || encoder === "h264_vaapi" || encoder === "h264_videotoolbox" ? encoder : null;
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.filter((id): id is string => id === PREVIEW_SDR_1080P_PROFILE)
    : [];
  if (!h264Encoder || profiles.length === 0) return { ...NO_PREVIEW_CAPABILITY };
  return { protocolVersion: PREVIEW_PROTOCOL_VERSION, h264Encoder, profiles };
}

export function nodeCanPreview(node: { enabled?: boolean; preview?: PreviewCapability | null }): boolean {
  if (node.enabled === false) return false;
  const cap = node.preview;
  return Boolean(cap?.h264Encoder && cap.protocolVersion === PREVIEW_PROTOCOL_VERSION && cap.profiles.includes(PREVIEW_SDR_1080P_PROFILE));
}

export function pickOpenPreviewNode(
  nodes: Array<{
    id: string;
    name: string;
    enabled: boolean;
    lastSeen: number;
    concurrency: number;
    runningCount: number;
    previewRunning: number;
    preview: PreviewCapability | null | undefined;
  }>,
  now: number,
  excludedIds?: Iterable<string>,
): { id: string; name: string } | null {
  const excluded = new Set(excludedIds ?? []);
  const capable = nodes.filter(
    (node) =>
      !excluded.has(node.id)
      && node.enabled
      && nodeIsOnline(node.lastSeen, now)
      && nodeCanPreview(node)
      && node.previewRunning < PREVIEW_MAX_PER_NODE
      && node.runningCount < node.concurrency,
  );
  if (capable.length === 0) return null;
  capable.sort((left, right) => {
    if (left.runningCount !== right.runningCount) return left.runningCount - right.runningCount;
    const freeLeft = left.concurrency - left.runningCount;
    const freeRight = right.concurrency - right.runningCount;
    if (freeRight !== freeLeft) return freeRight - freeLeft;
    return left.name.localeCompare(right.name);
  });
  return capable[0] ? { id: capable[0].id, name: capable[0].name } : null;
}

export function parsePreviewRequest(value: unknown): PreviewRequest {
  const raw = record(value);
  const startMs = finiteNumber(raw.startMs);
  const durationMs = finiteNumber(raw.durationMs);
  const preset = raw.preset;
  return {
    startMs: startMs != null && startMs >= 0 ? startMs : 0,
    durationMs: durationMs != null && durationMs > 0 ? durationMs : 15_000,
    originalAudioIndex: integerOrNull(raw.originalAudioIndex),
    sidecarAudioIndex: integerOrNull(raw.sidecarAudioIndex),
    preset: preset === "start" || preset === "middle" || preset === "end" || preset === "custom" ? preset : null,
  };
}

export function parseRemotePreviewDocument(
  value: unknown,
): { ok: true; preview: RemotePreviewDocument } | { ok: false; error: string } {
  const raw = record(value);
  if (raw.kind !== "preview") return { ok: false, error: "That payload is not a preview task." };
  const id = trimString(raw.id);
  const leaseToken = trimString(raw.leaseToken);
  const reviewId = trimString(raw.reviewId);
  const sourcePath = trimString(raw.sourcePath);
  const sidecarPath = trimString(raw.sidecarPath);
  const nodeId = trimString(raw.nodeId);
  const profileId = trimString(raw.profileId) || PREVIEW_SDR_1080P_PROFILE;
  const leaseUntil = finiteNumber(raw.leaseUntil);
  if (!id || !leaseToken || !reviewId || !sourcePath || !sidecarPath || !nodeId) {
    return { ok: false, error: "A preview task is missing required fields." };
  }
  if (leaseUntil == null) return { ok: false, error: "A preview lease deadline is required." };
  if (raw.protocolVersion !== PREVIEW_PROTOCOL_VERSION) {
    return { ok: false, error: "This worker does not speak this preview protocol." };
  }
  return {
    ok: true,
    preview: {
      kind: "preview",
      protocolVersion: PREVIEW_PROTOCOL_VERSION,
      id,
      leaseToken,
      leaseUntil,
      reviewId,
      sourcePath,
      sidecarPath,
      request: parsePreviewRequest(raw.request),
      profileId,
      nodeId,
      cacheDir: trimString(raw.cacheDir),
      render: parsePreviewRenderPlan(raw.render),
    },
  };
}

function parsePreviewRenderPlan(value: unknown): PreviewRenderPlan | null {
  const raw = record(value);
  const cacheDir = trimString(raw.cacheDir);
  const startMs = finiteNumber(raw.startMs);
  const durationMs = finiteNumber(raw.durationMs);
  const originalVideoIndex = integerOrNull(raw.originalVideoIndex);
  const sidecarVideoIndex = integerOrNull(raw.sidecarVideoIndex);
  const originalAudioIndex = integerOrNull(raw.originalAudioIndex);
  const sidecarAudioIndex = integerOrNull(raw.sidecarAudioIndex);
  const originalWidth = integerOrNull(raw.originalWidth);
  const originalHeight = integerOrNull(raw.originalHeight);
  const finishedWidth = integerOrNull(raw.finishedWidth);
  const finishedHeight = integerOrNull(raw.finishedHeight);
  if (
    !cacheDir
    || startMs == null
    || durationMs == null
    || originalVideoIndex == null
    || sidecarVideoIndex == null
    || originalAudioIndex == null
    || sidecarAudioIndex == null
    || originalWidth == null
    || originalHeight == null
    || finishedWidth == null
    || finishedHeight == null
  ) {
    return null;
  }
  return {
    cacheDir,
    startMs,
    durationMs,
    originalVideoIndex,
    sidecarVideoIndex,
    originalAudioIndex,
    sidecarAudioIndex,
    originalWidth,
    originalHeight,
    finishedWidth,
    finishedHeight,
    tonemap: raw.tonemap === true,
  };
}

export function parsePreviewProgress(
  value: unknown,
): { ok: true; leaseToken: string; progress: number | null; log: string } | { ok: false; error: string } {
  const raw = record(value);
  const leaseToken = trimString(raw.leaseToken);
  if (!leaseToken) return { ok: false, error: "A lease token is required." };
  if (raw.progress != null && (typeof raw.progress !== "number" || !Number.isFinite(raw.progress))) {
    return { ok: false, error: "Progress is invalid." };
  }
  return {
    ok: true,
    leaseToken,
    progress: typeof raw.progress === "number" ? Math.min(1, Math.max(0, raw.progress)) : null,
    log: typeof raw.log === "string" ? raw.log : "",
  };
}

export function parsePreviewComplete(value: unknown): { ok: true; leaseToken: string } | { ok: false; error: string } {
  const raw = record(value);
  const leaseToken = trimString(raw.leaseToken);
  if (!leaseToken) return { ok: false, error: "A lease token is required." };
  if (raw.sidecarPath != null || raw.output != null || raw.plan != null) {
    return { ok: false, error: "Preview completion cannot carry optimize-job fields." };
  }
  return { ok: true, leaseToken };
}

export function parsePreviewFail(value: unknown): { ok: true; leaseToken: string; error: string } | { ok: false; error: string } {
  const raw = record(value);
  const leaseToken = trimString(raw.leaseToken);
  if (!leaseToken) return { ok: false, error: "A lease token is required." };
  const error = trimString(raw.error) || "The preview failed.";
  return { ok: true, leaseToken, error };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}
