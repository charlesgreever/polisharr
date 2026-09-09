import type { ClusterNode } from "./api";

export type EncodeNeed = "copy" | "hevc" | "av1";

export function encodeNeedFromPlan(plan: { video?: { kind?: string; codec?: string } } | null | undefined): EncodeNeed {
  if (!plan?.video || plan.video.kind === "copy") return "copy";
  return plan.video.codec === "av1" ? "av1" : "hevc";
}

export function encodeNeedFromAfterCodec(codec: string | null | undefined): EncodeNeed {
  if (codec === "av1") return "av1";
  if (codec === "hevc") return "hevc";
  return "copy";
}

export function nodeCanEncode(node: ClusterNode, need: EncodeNeed): boolean {
  if (need === "copy") return true;
  if (node.hardware.backend === "none") return false;
  if (need === "av1") return node.hardware.av1 === true;
  return true;
}

export function capableEncodeNodes(nodes: ClusterNode[], need: EncodeNeed): ClusterNode[] {
  return nodes.filter((node) => nodeCanEncode(node, need));
}

export function encodeNodeOptionLabel(node: ClusterNode): string {
  const flags = [
    node.online ? null : "offline",
    node.enabled ? null : "drained",
  ].filter((flag): flag is string => Boolean(flag));
  return flags.length > 0 ? `${node.name} (${flags.join(", ")})` : node.name;
}
