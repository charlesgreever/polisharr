export const MCP_PROTOCOL = "2025-03-26";
export const MCP_AUTH_ERROR = "That MCP token is not valid.";
export const MCP_MASTER_ONLY = "MCP is only available on the Polisharr that runs the library UI.";
export const MCP_KEEP_CONFIRM = "KEEP";
export const MCP_DISCARD_CONFIRM = "DISCARD";
export const MCP_LIST_LIMIT = 20;

export type JsonRpcId = string | number | null;
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
};

export type McpToolResult = Record<string, unknown>;

export type McpHost = {
  version: string;
  searchTitles: (query: string) => McpToolResult[];
  getTitle: (itemId: string) => McpToolResult;
  listSuggestions: (query: string) => McpToolResult[];
  listJobs: () => McpToolResult[];
  listNodes: () => McpToolResult[];
  listReview: () => McpToolResult[];
  previewPlan: (args: Record<string, unknown>) => McpToolResult;
  queueSuggestion: (itemId: string) => McpToolResult;
  addStereo: (itemId: string) => McpToolResult;
  queueEncode: (args: Record<string, unknown>) => McpToolResult;
  cancelJob: (jobId: string) => McpToolResult;
  keepReview: (reviewId: string, confirm: string) => Promise<McpToolResult>;
  discardReview: (reviewId: string, confirm: string) => Promise<McpToolResult>;
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, host: McpHost) => McpToolResult | Promise<McpToolResult>;
};

const TOOLS: ToolDef[] = [
  {
    name: "search_titles",
    description: "Search Radarr movies and Sonarr episodes by title, show, quality, or instance name. Call get_title on a hit before queueing work so 1080p and 4K copies are not mixed up.",
    inputSchema: objectSchema({ query: { type: "string", description: "Title words to match." } }, ["query"]),
    run: (args, host) => ({ items: host.searchTitles(stringArg(args, "query")) }),
  },
  {
    name: "get_title",
    description: "Read one library title: file name, size, codec, tracks, open suggestion, and pending Review sidecar if any. Does not invent a plan for an unread file.",
    inputSchema: objectSchema({ itemId: { type: "string" } }, ["itemId"]),
    run: (args, host) => host.getTitle(stringArg(args, "itemId")),
  },
  {
    name: "list_suggestions",
    description: "List open Suggestions, optionally filtered by the same search words as the Suggestions page.",
    inputSchema: objectSchema({ query: { type: "string" } }),
    run: (args, host) => ({ items: host.listSuggestions(optionalString(args, "query")) }),
  },
  {
    name: "list_jobs",
    description: "List waiting, running, and recent finished encode jobs with node name, progress, and error.",
    inputSchema: objectSchema({}),
    run: (_args, host) => ({ items: host.listJobs() }),
  },
  {
    name: "list_nodes",
    description: "List encode nodes: name, online, enabled, hardware label, and current job.",
    inputSchema: objectSchema({}),
    run: (_args, host) => ({ items: host.listNodes() }),
  },
  {
    name: "list_review",
    description: "List pending Review sidecars: title, original size, sidecar size, and status.",
    inputSchema: objectSchema({}),
    run: (_args, host) => ({ items: host.listReview() }),
  },
  {
    name: "preview_plan",
    description: "Dry-run a custom encode plan for one title. Returns reasons, warnings, and estimated bytes. Does not queue work. Prefer this before queue_encode when the operator names a target size.",
    inputSchema: encodeSchema(),
    run: (args, host) => host.previewPlan(args),
  },
  {
    name: "queue_suggestion",
    description: "Queue the current automatic suggestion for one title as a sidecar. Fails if there is no open suggestion or a sidecar is already pending. The library file does not change until Keep.",
    inputSchema: objectSchema({ itemId: { type: "string" } }, ["itemId"]),
    run: (args, host) => host.queueSuggestion(stringArg(args, "itemId")),
  },
  {
    name: "add_stereo",
    description: "Offer an AAC stereo track on Suggestions for one title that has no stereo yet. If stereo already exists, reports that nothing changed.",
    inputSchema: objectSchema({ itemId: { type: "string" } }, ["itemId"]),
    run: (args, host) => host.addStereo(stringArg(args, "itemId")),
  },
  {
    name: "queue_encode",
    description: "Queue a custom sidecar encode. Pass targetGb or targetBytes for a size target, or quality for encoder quality. quality wins if both are set. Default codec follows the title or house encode target. Default write is sidecar. Call get_title first.",
    inputSchema: encodeSchema(),
    run: (args, host) => host.queueEncode(args),
  },
  {
    name: "cancel_job",
    description: "Cancel one waiting or running job by id.",
    inputSchema: objectSchema({ jobId: { type: "string" } }, ["jobId"]),
    run: (args, host) => host.cancelJob(stringArg(args, "jobId")),
  },
  {
    name: "keep_review",
    description: "Replace the library file with a finished Review sidecar through Radarr or Sonarr. confirm must be the exact word KEEP. This is not implied by queue_encode.",
    inputSchema: objectSchema({
      reviewId: { type: "string" },
      confirm: { type: "string", description: `Must be ${MCP_KEEP_CONFIRM}.` },
    }, ["reviewId", "confirm"]),
    run: (args, host) => host.keepReview(stringArg(args, "reviewId"), stringArg(args, "confirm")),
  },
  {
    name: "discard_review",
    description: "Delete a Review sidecar and leave the original library file. confirm must be the exact word DISCARD.",
    inputSchema: objectSchema({
      reviewId: { type: "string" },
      confirm: { type: "string", description: `Must be ${MCP_DISCARD_CONFIRM}.` },
    }, ["reviewId", "confirm"]),
    run: (args, host) => host.discardReview(stringArg(args, "reviewId"), stringArg(args, "confirm")),
  },
];

export function mcpToolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}

export async function handleMcpJsonRpc(body: unknown, host: McpHost): Promise<{ status: number; payload: JsonRpcResponse | null }> {
  const req = parseRpc(body);
  if (!req.ok) return { status: 200, payload: rpcError(null, -32600, req.error) };
  if (req.notification) {
    return { status: 202, payload: null };
  }
  try {
    const result = await dispatch(req.method, req.params, host);
    return { status: 200, payload: { jsonrpc: "2.0", id: req.id, result } };
  } catch (error) {
    const message = error instanceof McpToolError ? error.message : "The MCP request failed.";
    const code = error instanceof McpToolError ? error.code : -32603;
    return { status: 200, payload: rpcError(req.id, code, message) };
  }
}

export function encodeDraftFromArgs(args: Record<string, unknown>): {
  ok: true;
  draft: {
    video: { mode: "size"; targetBytes: number; codec?: "hevc" | "av1"; downscale1080p?: boolean }
      | { mode: "quality"; quality: number; codec?: "hevc" | "av1"; downscale1080p?: boolean };
    writeMode: "sidecar" | "direct";
  };
  targetBytes?: number;
} | { ok: false; error: string } {
  const downscale1080p = args.downscale1080p === true;
  const codec = args.codec === "hevc" || args.codec === "av1" ? args.codec : undefined;
  const writeMode = args.writeMode === "direct" ? "direct" : "sidecar";
  const quality = asFiniteNumber(args.quality);
  if (quality != null) {
    return { ok: true, draft: { video: { mode: "quality", quality, codec, downscale1080p }, writeMode } };
  }
  const targetGb = asFiniteNumber(args.targetGb);
  const explicitBytes = asFiniteNumber(args.targetBytes);
  const targetBytes = explicitBytes != null
    ? Math.round(explicitBytes)
    : targetGb != null
      ? Math.round(targetGb * 1024 ** 3)
      : null;
  if (targetBytes == null) {
    return { ok: false, error: "Pass targetGb, targetBytes, or quality." };
  }
  return {
    ok: true,
    draft: { video: { mode: "size", targetBytes, codec, downscale1080p }, writeMode },
    targetBytes,
  };
}

class McpToolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

async function dispatch(method: string, params: Record<string, unknown>, host: McpHost): Promise<unknown> {
  if (method === "initialize") {
    return {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "polisharr", version: host.version },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") {
    return {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  }
  if (method === "tools/call") {
    const name = stringArg(params, "name");
    const args = record(params.arguments);
    const tool = TOOLS.find((row) => row.name === name);
    if (!tool) throw new McpToolError(-32601, "That MCP tool is not available.");
    const data = await tool.run(args, host);
    const failed = data.ok === false && typeof data.error === "string";
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      isError: failed,
    };
  }
  throw new McpToolError(-32601, "That MCP method is not available.");
}

function parseRpc(body: unknown):
  | { ok: true; notification: true }
  | { ok: true; notification: false; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "The MCP request is invalid." };
  const raw = body as Record<string, unknown>;
  if (raw.jsonrpc !== "2.0" || typeof raw.method !== "string" || !raw.method) {
    return { ok: false, error: "The MCP request is invalid." };
  }
  if (raw.id === undefined) return { ok: true, notification: true };
  const id = raw.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    return { ok: false, error: "The MCP request is invalid." };
  }
  return { ok: true, notification: false, id, method: raw.method, params: record(raw.params) };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function encodeSchema(): Record<string, unknown> {
  return objectSchema({
    itemId: { type: "string" },
    targetGb: { type: "number", description: "Target file size in gigabytes (1024^3 bytes)." },
    targetBytes: { type: "number" },
    quality: { type: "number", description: "Encoder quality. If set, size fields are ignored." },
    codec: { type: "string", enum: ["hevc", "av1"] },
    downscale1080p: { type: "boolean" },
    writeMode: { type: "string", enum: ["sidecar", "direct"] },
    assignedNodeId: { type: "string" },
  }, ["itemId"]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new McpToolError(-32602, `The ${key} value is required.`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
