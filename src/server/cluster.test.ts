import { describe, expect, it } from "vitest";
import {
  clusterHasAv1,
  encodeNeedFromPlan,
  nodeCanEncode,
  nodeCanPreview,
  nodeHardwareLabel,
  nodeIsOnline,
  nodeRoleLabel,
  parsePreviewCapability,
  parsePreviewComplete,
  parsePreviewProgress,
  parseRemotePreviewDocument,
  pickOpenEncodeNode,
  pickOpenPreviewNode,
  poolSpreadLimit,
  NODE_STALE_MS,
  parseClusterClaim,
  parseClusterHeartbeat,
  parseClusterHello,
  parseHardwareInfo,
  parseNodeRole,
  parseRemoteComplete,
  parseRemoteProgress,
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_SDR_1080P_PROFILE,
} from "./cluster.ts";

describe("cluster node identity", () => {
  it("treats missing or unknown roles as standalone so existing deploys keep one process", () => {
    expect(parseNodeRole(undefined)).toBe("standalone");
    expect(parseNodeRole("")).toBe("standalone");
    expect(parseNodeRole("replica")).toBe("standalone");
    expect(parseNodeRole("master")).toBe("master");
    expect(parseNodeRole("worker")).toBe("worker");
  });

  it("parses a stored hardware probe without inventing CUDA", () => {
    expect(parseHardwareInfo({ backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null })).toEqual({
      backend: "cuda",
      cuda: true,
      vaapi: false,
      videotoolbox: false,
      av1: true,
      reason: null,
      vaapiDevice: undefined,
      gpuName: undefined,
      qsv: false,
    });
    expect(parseHardwareInfo({ backend: "videotoolbox", videotoolbox: true, av1: false })).toMatchObject({
      backend: "videotoolbox",
      videotoolbox: true,
      cuda: false,
    });
    expect(parseHardwareInfo("nope")).toMatchObject({ backend: "none", cuda: false, av1: false });
  });

  it("names hardware in everyday words", () => {
    expect(nodeHardwareLabel({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null })).toBe(
      "NVIDIA GPU, AV1 encoder not listed",
    );
    expect(nodeHardwareLabel({ backend: "vaapi", cuda: false, vaapi: true, av1: true, reason: null })).toBe(
      "Intel or AMD GPU, AV1 encoder listed",
    );
    expect(nodeHardwareLabel({ backend: "videotoolbox", cuda: false, vaapi: false, videotoolbox: true, av1: false, reason: null })).toBe(
      "Apple media engine, AV1 encoder not listed",
    );
    expect(nodeHardwareLabel({ backend: "none", cuda: false, vaapi: false, av1: false, reason: "ffmpeg is not available." })).toBe(
      "ffmpeg is not available.",
    );
  });

  it("labels this process without calling a worker the UI", () => {
    expect(nodeRoleLabel("standalone", true)).toBe("This machine");
    expect(nodeRoleLabel("master", true)).toBe("Master (this UI and library)");
    expect(nodeRoleLabel("worker", false)).toBe("Worker");
  });

  it("hides AV1 from a HEVC-only GPU and never offers CPU encode", () => {
    const hevcOnly = { enabled: true, hardware: { backend: "cuda" as const, cuda: true, vaapi: false, av1: false, reason: null } };
    const av1Node = { enabled: true, hardware: { backend: "cuda" as const, cuda: true, vaapi: false, av1: true, reason: null } };
    const none = { enabled: true, hardware: { backend: "none" as const, cuda: false, vaapi: false, av1: false, reason: null } };
    expect(encodeNeedFromPlan({ video: { kind: "copy" } })).toBe("copy");
    expect(encodeNeedFromPlan({ video: { kind: "size", codec: "av1" } })).toBe("av1");
    expect(nodeCanEncode(hevcOnly, "av1")).toBe(false);
    expect(nodeCanEncode(hevcOnly, "hevc")).toBe(true);
    expect(nodeCanEncode(av1Node, "av1")).toBe(true);
    expect(nodeCanEncode(none, "hevc")).toBe(false);
    expect(nodeCanEncode(none, "copy")).toBe(true);
    expect(clusterHasAv1([{ ...av1Node, lastSeen: 1, enabled: true }], 1)).toBe(true);
    expect(clusterHasAv1([{ ...av1Node, lastSeen: 1, enabled: true }], 1 + NODE_STALE_MS + 1)).toBe(false);
  });

  it("picks the capable online node with the most free slots", () => {
    const hevc = {
      id: "intel",
      name: "deskmini",
      enabled: true,
      lastSeen: 1_000,
      concurrency: 4,
      runningCount: 0,
      hardware: { backend: "vaapi" as const, cuda: false, vaapi: true, av1: false, reason: null },
    };
    const gpu = {
      id: "5090",
      name: "5090",
      enabled: true,
      lastSeen: 1_000,
      concurrency: 2,
      runningCount: 2,
      hardware: { backend: "cuda" as const, cuda: true, vaapi: false, av1: true, reason: null },
    };
    const mac = {
      id: "mac",
      name: "MacBook Pro",
      enabled: true,
      lastSeen: 1_000,
      concurrency: 4,
      runningCount: 1,
      hardware: { backend: "videotoolbox" as const, cuda: false, vaapi: false, videotoolbox: true, av1: false, reason: null },
    };
    expect(pickOpenEncodeNode([gpu, mac, hevc], "hevc", 1_000)?.id).toBe("intel");
    expect(pickOpenEncodeNode([gpu, mac, hevc], "av1", 1_000)?.id).toBe("5090");
    expect(pickOpenEncodeNode([{ ...gpu, lastSeen: 1, enabled: true, runningCount: 1 }, { ...mac, lastSeen: 1 + 120_000 }], "av1", 1_000)?.id).toBe("5090");
    expect(pickOpenEncodeNode([{ ...gpu, lastSeen: 1, enabled: false }], "av1", 1_000)).toBeNull();
    expect(pickOpenEncodeNode(
      [{ ...mac, runningCount: 0 }, { ...hevc, runningCount: 0 }],
      "hevc",
      1_000,
      "intel",
    )?.id).toBe("intel");
    expect(pickOpenEncodeNode([gpu, mac, hevc], "hevc", 1_000, undefined, ["intel"])?.id).toBe("mac");
    expect(pickOpenEncodeNode(
      [{ ...hevc, runningCount: 1 }, { ...mac, runningCount: 0 }],
      "hevc",
      1_000,
    )?.id).toBe("mac");
  });

  it("spreads leftover pool jobs when they would fit in parallel, and fills a GPU when the queue is still deep", () => {
    expect(poolSpreadLimit(4, 5, 7)).toBe(1);
    expect(poolSpreadLimit(4, 200, 7)).toBe(4);
    expect(poolSpreadLimit(4, 2, 0)).toBe(2);
    expect(poolSpreadLimit(1, 3, 4)).toBe(1);
    expect(poolSpreadLimit(2, 3, 7)).toBe(1);
    expect(poolSpreadLimit(0, 5, 7)).toBe(0);
    expect(poolSpreadLimit(4, 0, 7)).toBe(0);
  });

  it("treats a node as offline after the stale window", () => {
    expect(nodeIsOnline(1_000, 1_000 + NODE_STALE_MS)).toBe(true);
    expect(nodeIsOnline(1_000, 1_000 + NODE_STALE_MS + 1)).toBe(false);
  });

  it("parses hello and heartbeat payloads and rejects a missing node id", () => {
    const hardware = { backend: "cuda" as const, cuda: true, vaapi: false, av1: false, reason: null };
    expect(parseClusterHello({
      nodeId: " worker-1 ",
      name: "5090",
      version: "0.2.18",
      hardware,
      concurrency: 2,
    })).toEqual({
      ok: true,
      hello: { nodeId: "worker-1", name: "5090", version: "0.2.18", hardware: { ...hardware, videotoolbox: false, vaapiDevice: undefined, gpuName: undefined, qsv: false }, concurrency: 2, preview: null },
    });
    expect(parseClusterHello({ name: "5090" }).ok).toBe(false);
    expect(parseClusterHeartbeat({
      nodeId: "worker-1",
      hardware,
      currentJobId: "job-9",
      runningJobIds: ["job-9", 12],
    })).toMatchObject({
      ok: true,
      beat: { nodeId: "worker-1", currentJobId: "job-9", runningJobIds: ["job-9"], concurrency: 1, preview: null, runningPreviewIds: [] },
    });
    expect(parseClusterClaim({ nodeId: "worker-1", freeSlots: 2 })).toEqual({ ok: true, nodeId: "worker-1", freeSlots: 2 });
    expect(parseRemoteComplete({
      leaseToken: "tok",
      sidecarPath: "/review/out.mkv",
      output: { videoCodec: "hevc", sizeBytes: 3 },
    })).toMatchObject({ ok: true, sidecarPath: "/review/out.mkv" });
    expect(parseRemoteComplete({ leaseToken: "tok" }).ok).toBe(false);
    expect(parseRemoteProgress({ leaseToken: "tok", log: "frame=1\n" })).toEqual({
      ok: true,
      leaseToken: "tok",
      phase: null,
      progress: null,
      log: "frame=1\n",
    });
    expect(parseRemoteProgress({ leaseToken: "tok", phase: "transcoding", progress: 0.4 }).ok).toBe(true);
  });

  it("treats missing preview capability as none so old workers keep receiving ordinary jobs", () => {
    expect(parsePreviewCapability(undefined)).toBeNull();
    expect(parsePreviewCapability({ protocolVersion: PREVIEW_PROTOCOL_VERSION, h264Encoder: null, profiles: [] })).toEqual({
      protocolVersion: PREVIEW_PROTOCOL_VERSION,
      h264Encoder: null,
      profiles: [],
    });
    expect(nodeCanPreview({ preview: null })).toBe(false);
    expect(nodeCanPreview({
      preview: { protocolVersion: PREVIEW_PROTOCOL_VERSION, h264Encoder: "h264_nvenc", profiles: [PREVIEW_SDR_1080P_PROFILE] },
    })).toBe(true);
  });

  it("treats omitted or null preview progress as a lease heartbeat", () => {
    expect(parsePreviewProgress({ leaseToken: "tok" })).toEqual({ ok: true, leaseToken: "tok", progress: null, log: "" });
    expect(parsePreviewProgress({ leaseToken: "tok", progress: null })).toEqual({
      ok: true,
      leaseToken: "tok",
      progress: null,
      log: "",
    });
    expect(parsePreviewProgress({ leaseToken: "tok", progress: Number.NaN }).ok).toBe(false);
  });

  it("rejects optimize-job fields on preview completion and requires a preview kind", () => {
    expect(parsePreviewComplete({ leaseToken: "tok", sidecarPath: "/review/out.mkv", output: {} }).ok).toBe(false);
    expect(parseRemotePreviewDocument({
      id: "job-1",
      leaseToken: "tok",
      sourcePath: "/a.mkv",
      reviewDir: "/review",
    }).ok).toBe(false);
    expect(parseRemotePreviewDocument({
      kind: "preview",
      protocolVersion: PREVIEW_PROTOCOL_VERSION,
      id: "prv-1",
      leaseToken: "tok",
      leaseUntil: 2_000,
      reviewId: "rev-1",
      sourcePath: "/a.mkv",
      sidecarPath: "/b.mkv",
      nodeId: "worker-1",
      profileId: PREVIEW_SDR_1080P_PROFILE,
      request: { startMs: 1000, durationMs: 15_000 },
    }).ok).toBe(true);
  });

  it("picks any capable preview node and ignores ordinary job pinning", () => {
    const worker = {
      id: "worker-1",
      name: "5090",
      enabled: true,
      lastSeen: 1_000,
      concurrency: 2,
      runningCount: 0,
      previewRunning: 0,
      preview: { protocolVersion: PREVIEW_PROTOCOL_VERSION, h264Encoder: "h264_nvenc" as const, profiles: [PREVIEW_SDR_1080P_PROFILE] },
    };
    const old = { ...worker, id: "old", name: "old", preview: null };
    expect(pickOpenPreviewNode([old, worker], 1_000)?.id).toBe("worker-1");
    expect(pickOpenPreviewNode([{ ...worker, previewRunning: 1 }], 1_000)).toBeNull();
  });
});
