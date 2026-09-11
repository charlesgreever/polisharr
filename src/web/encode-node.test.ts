import { describe, expect, it } from "vitest";
import { bulkEncodeNeed, capableEncodeNodes, encodeNeedFromAfterCodec, encodeNeedFromPlan, encodeNodeOptionLabel, nodeCanEncode } from "./encode-node";
import type { ClusterNode } from "./api";

function node(over: Partial<ClusterNode> & Pick<ClusterNode, "id" | "name" | "hardware">): ClusterNode {
  return {
    role: "worker",
    roleLabel: "Worker",
    thisNode: false,
    lastSeen: 1,
    hardwareLabel: "NVIDIA GPU",
    concurrency: 1,
    enabled: true,
    version: "1",
    currentJobId: null,
    online: true,
    ...over,
  };
}

describe("encode node picker", () => {
  it("does not call the machine picker Encode target", () => {
    expect(encodeNeedFromPlan({ video: { kind: "size", codec: "av1" } })).toBe("av1");
    expect(encodeNeedFromAfterCodec("av1")).toBe("av1");
    const hevcOnly = node({
      id: "intel",
      name: "intel",
      hardware: { backend: "vaapi", cuda: false, vaapi: true, av1: false, reason: null },
    });
    const gpu = node({
      id: "5090",
      name: "5090",
      hardware: { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null },
    });
    expect(nodeCanEncode(hevcOnly, "av1")).toBe(false);
    expect(capableEncodeNodes([hevcOnly, gpu], "av1").map((row) => row.id)).toEqual(["5090"]);
    expect(encodeNodeOptionLabel({ ...hevcOnly, online: false, enabled: false })).toBe("intel (offline, drained)");
    expect(encodeNodeOptionLabel({
      ...hevcOnly,
      name: "MacBook Pro",
      online: false,
      hardware: { backend: "none", cuda: false, vaapi: false, av1: false, reason: null },
    })).toBe("MacBook Pro (offline, no encoder)");
    expect(bulkEncodeNeed(["hevc", "av1"])).toBe("hevc");
    expect(bulkEncodeNeed(["av1", "av1"])).toBe("av1");
    expect(bulkEncodeNeed([])).toBe("hevc");
  });
});
