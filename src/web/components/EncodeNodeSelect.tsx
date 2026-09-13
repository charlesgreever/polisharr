import { FIELD_CONTROL } from "../settings-copy";
import type { ClusterNode } from "../api";
import { ANY_OPEN_NODE_ID, capableEncodeNodes, encodeNodeOptionLabel, nodeCanEncode, type EncodeNeed } from "../encode-node";

export function EncodeNodeSelect({
  nodes,
  value,
  need,
  defaultNodeId,
  disabled,
  onChange,
}: {
  nodes: ClusterNode[];
  value: string;
  need: EncodeNeed;
  defaultNodeId?: string;
  disabled?: boolean;
  onChange: (nodeId: string) => void;
}) {
  if (nodes.length <= 1) return null;
  const capable = capableEncodeNodes(nodes, need);
  const selected = value === ANY_OPEN_NODE_ID || capable.some((node) => node.id === value) ? value : capable[0]?.id ?? ANY_OPEN_NODE_ID;
  return (
    <label className="block min-w-[12rem] text-sm">
      <span className="mb-1 block font-medium text-muted">Encode node</span>
      <select
        className={FIELD_CONTROL}
        value={selected}
        disabled={disabled || capable.length === 0}
        aria-label="Encode node"
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={ANY_OPEN_NODE_ID}>Any open node</option>
        {nodes.map((node) => (
          <option key={node.id} value={node.id} disabled={!nodeCanEncode(node, need)}>
            {encodeNodeOptionLabel(node)}{node.id === defaultNodeId ? " (house default)" : ""}
          </option>
        ))}
      </select>
      {capable.length === 0 && (
        <span className="help mt-1 block">
          {need === "av1"
            ? "No encode node can run AV1 right now."
            : "No encode node can run this plan right now."}
        </span>
      )}
    </label>
  );
}
