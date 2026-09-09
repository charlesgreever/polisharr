import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EncodeNodeSelect } from "./EncodeNodeSelect";
import type { ClusterNode } from "../api";

const nodes: ClusterNode[] = [
  {
    id: "homeserver",
    name: "homeserver",
    role: "master",
    roleLabel: "Master",
    thisNode: true,
    lastSeen: 1,
    hardware: { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null },
    hardwareLabel: "NVIDIA GPU, AV1 encoder not listed",
    concurrency: 1,
    enabled: true,
    version: "1",
    currentJobId: null,
    online: true,
  },
  {
    id: "5090",
    name: "5090",
    role: "worker",
    roleLabel: "Worker",
    thisNode: false,
    lastSeen: 1,
    hardware: { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null },
    hardwareLabel: "NVIDIA GPU, AV1 encoder listed",
    concurrency: 1,
    enabled: true,
    version: "1",
    currentJobId: null,
    online: true,
  },
];

describe("Encode node select", () => {
  it("labels the control Encode node and omits a HEVC-only GPU from an AV1 plan", () => {
    const html = renderToStaticMarkup(createElement(EncodeNodeSelect, {
      nodes,
      value: "5090",
      need: "av1",
      defaultNodeId: "homeserver",
      onChange: vi.fn(),
    }));
    expect(html).toContain("Encode node");
    expect(html).not.toContain("Encode target");
    expect(html).toContain("5090");
    expect(html).not.toContain("homeserver");
  });
});
