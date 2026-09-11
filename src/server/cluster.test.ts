import { describe, expect, it } from "vitest";
import {
  clusterHasAv1,
  encodeNeedFromPlan,
  nodeCanEncode,
  nodeHardwareLabel,
  nodeIsOnline,
  nodeRoleLabel,
  NODE_STALE_MS,
  parseClusterClaim,
  parseClusterHeartbeat,
  parseClusterHello,
  parseHardwareInfo,
  parseNodeRole,
  parseRemoteComplete,
  parseRemoteProgress,
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
      hello: { nodeId: "worker-1", name: "5090", version: "0.2.18", hardware: { ...hardware, videotoolbox: false, vaapiDevice: undefined, gpuName: undefined }, concurrency: 2 },
    });
    expect(parseClusterHello({ name: "5090" }).ok).toBe(false);
    expect(parseClusterHeartbeat({
      nodeId: "worker-1",
      hardware,
      currentJobId: "job-9",
      runningJobIds: ["job-9", 12],
    })).toMatchObject({
      ok: true,
      beat: { nodeId: "worker-1", currentJobId: "job-9", runningJobIds: ["job-9"], concurrency: 1 },
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
});
