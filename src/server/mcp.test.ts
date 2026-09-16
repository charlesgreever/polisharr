import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { encodeDraftFromArgs, MCP_AUTH_ERROR, MCP_MASTER_ONLY, mcpToolNames } from "./mcp.ts";
import type { HardwareInfo } from "./types.ts";

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function setup(role: "standalone" | "master" | "worker" = "standalone") {
  const dir = mkdtempSync(join(tmpdir(), "opt-"));
  mkdirSync(join(dir, "review"), { recursive: true });
  const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373", POLISHARR_ROLE: role });
  const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null };
  const created = createApp({
    env,
    hardware: async () => hw,
    readable: async () => true,
    probe: async () => ({
      format: { duration: "3600" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", channels: 6, tags: { language: "eng" }, index: 1 },
      ],
    }),
    fetch: (async (url: string) => {
      if (String(url).includes("/movie")) {
        return new Response(JSON.stringify([{
          id: 10,
          title: "American Underdog",
          path: "/mnt/nas/movies/underdog.mkv",
          sizeOnDisk: 8_000_000_000,
          movieFile: { path: "/mnt/nas/movies/underdog.mkv", size: 8_000_000_000, quality: { quality: { name: "Bluray-1080p" } } },
        }]));
      }
      if (String(url).includes("system/status")) return new Response(JSON.stringify({ appName: "Radarr", version: "5" }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    optimizer: async (req) => ({
      sidecarPath: join(dir, "review", "sidecar.mkv"),
      output: { ...req.report, videoCodec: "hevc", sizeBytes: 3_000_000_000, sizePerHourGb: 3 },
    }),
  });
  return { app: created, store: created.store, dir };
}

async function ready() {
  const ctx = await setup();
  const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
  const headers = { cookie: cookie(setupRes) };
  await ctx.app.app.request("/api/integrations", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "radarr", name: "Radarr", url: "http://radarr:7878", apiKey: "k", enabled: true }),
  });
  await ctx.app.app.request("/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ languageConfirmed: true, preferredLanguage: "eng", reviewPath: join(ctx.dir, "review") }),
  });
  const minted = (await (await ctx.app.app.request("/api/settings/mcp-token", { method: "POST", headers })).json()) as { token: string };
  await ctx.app.app.request("/api/library/refresh", { method: "POST", headers });
  await ctx.app.inspectPending();
  ctx.app.jobs.stop();
  return { ...ctx, headers, token: minted.token };
}

async function call(app: ReturnType<typeof createApp>["app"], token: string | null, method: string, params?: unknown, id: number | null = 1) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function tool(app: ReturnType<typeof createApp>["app"], token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await call(app, token, "tools/call", { name, arguments: args });
  const body = await res.json() as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
  const text = body.result?.content?.[0]?.text;
  return { status: res.status, isError: Boolean(body.result?.isError), data: text ? JSON.parse(text) as Record<string, unknown> : {}, rpcError: body.error?.message };
}

describe("MCP agent access", () => {
  const apps: Array<{ store: { close: () => void }; app: { jobs: { stop: () => void }; previews?: { stop: () => void }; workerLoop?: { stop: () => void }; playbackMonitor?: { stop: () => Promise<void> } } }> = [];
  afterEach(async () => {
    for (const a of apps) {
      a.app.jobs.stop();
      a.app.previews?.stop();
      a.app.workerLoop?.stop();
      await a.app.playbackMonitor?.stop();
      a.store.close();
    }
    apps.length = 0;
  });

  it("mints an MCP token once and never echoes it on settings", async () => {
    const ctx = await setup();
    apps.push(ctx);
    const setupRes = await ctx.app.app.request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username: "ada", password: "secret12" }) });
    const headers = { cookie: cookie(setupRes) };
    const minted = (await (await ctx.app.app.request("/api/settings/mcp-token", { method: "POST", headers })).json()) as { token: string };
    expect(minted.token).toMatch(/^[a-f0-9]{48}$/);
    const settings = (await (await ctx.app.app.request("/api/settings", { headers })).json()) as { hasMcpToken: boolean };
    expect(settings.hasMcpToken).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(minted.token);
    const rotated = (await (await ctx.app.app.request("/api/settings/mcp-token", { method: "POST", headers })).json()) as { token: string };
    expect(rotated.token).not.toBe(minted.token);
    const old = await call(ctx.app.app, minted.token, "initialize");
    expect(old.status).toBe(401);
  });

  it("rejects MCP without a token using one generic error", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const res = await call(ctx.app.app, null, "initialize");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: MCP_AUTH_ERROR });
  });

  it("does not serve MCP on a worker", async () => {
    const ctx = await setup("worker");
    apps.push(ctx);
    ctx.store.setMcpTokenHash("abc");
    const res = await ctx.app.app.request("/mcp", { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: MCP_MASTER_ONLY });
  });

  it("lists tools and searches titles with a valid token", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const init = await call(ctx.app.app, ctx.token, "initialize");
    expect(init.status).toBe(200);
    const listed = await call(ctx.app.app, ctx.token, "tools/list");
    const tools = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((row) => row.name)).toEqual(mcpToolNames());
    const found = await tool(ctx.app.app, ctx.token, "search_titles", { query: "Underdog" });
    expect(found.isError).toBe(false);
    const items = found.data.items as Array<{ itemId: string; displayTitle: string; codec: string }>;
    expect(items[0]?.displayTitle).toMatch(/Underdog/);
    expect(items[0]?.codec).toBe("h264");
    expect(items[0]?.itemId).toBeTruthy();
  });

  it("describes an unread title without inventing a plan", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const itemId = ctx.store.listItems()[0]!.id;
    ctx.store.db.prepare("DELETE FROM inspections WHERE item_id = ?").run(itemId);
    const title = await tool(ctx.app.app, ctx.token, "get_title", { itemId });
    expect(title.data.unread).toBe(true);
    expect(title.data.suggestion).toBeNull();
    expect(title.data.codec).toBeNull();
  });

  it("lists jobs with node name and does not enqueue from read tools", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const itemId = ctx.store.listItems()[0]!.id;
    ctx.store.insertJob({
      id: "job-run",
      itemId,
      suggestionId: null,
      status: "running",
      phase: "transcoding",
      progress: 0.4,
      error: null,
      warning: null,
      runNow: false,
      createdAt: 1,
      plan: {},
    });
    ctx.store.updateJob("job-run", { nodeId: ctx.store.localNodeId() });
    const listed = await tool(ctx.app.app, ctx.token, "list_jobs");
    const job = (listed.data.items as Array<{ jobId: string; progress: number; status: string }>)[0];
    expect(job).toMatchObject({ jobId: "job-run", status: "running", progress: 0.4 });
    expect(ctx.store.listJobs().filter((row) => row.status === "queued")).toHaveLength(0);
  });

  it("queues an open suggestion and refuses a second queue", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const itemId = ctx.store.listItems()[0]!.id;
    const queued = await tool(ctx.app.app, ctx.token, "queue_suggestion", { itemId });
    expect(queued.data).toMatchObject({ ok: true });
    expect(queued.data.jobId).toBeTruthy();
    expect(ctx.store.getItem(itemId)?.path).toBe("/mnt/nas/movies/underdog.mkv");
    const again = await tool(ctx.app.app, ctx.token, "queue_suggestion", { itemId });
    expect(again.isError).toBe(true);
    expect(String(again.data.error)).toMatch(/already|pending|sidecar|job/i);
  });

  it("does not claim add stereo succeeded when stereo already exists", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const itemId = ctx.store.listItems()[0]!.id;
    const report = ctx.store.getInspection(itemId)!;
    ctx.store.saveInspection(itemId, {
      ...report,
      audio: [...report.audio, { index: 2, language: "eng", channels: 2, codec: "aac", title: "", untagged: false, commentary: false }],
    });
    const result = await tool(ctx.app.app, ctx.token, "add_stereo", { itemId });
    expect(result.isError).toBe(true);
    expect(result.data.error).toBe("This file already has a stereo track.");
  });

  it("cancels a queued job", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const itemId = ctx.store.listItems()[0]!.id;
    const queued = await tool(ctx.app.app, ctx.token, "queue_suggestion", { itemId });
    const cancelled = await tool(ctx.app.app, ctx.token, "cancel_job", { jobId: queued.data.jobId });
    expect(cancelled.data).toMatchObject({ ok: true });
    expect(ctx.store.getJob(String(queued.data.jobId))?.status).toBe("cancelled");
  });

  it("previews an 8 GB plan without creating a job, then queues it", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const itemId = ctx.store.listItems()[0]!.id;
    const preview = await tool(ctx.app.app, ctx.token, "preview_plan", { itemId, targetGb: 8 });
    expect(preview.data.ok).toBe(true);
    expect(preview.data.estimatedOutputBytes).toBe(8 * 1024 ** 3);
    expect(ctx.store.listJobs()).toHaveLength(0);
    const queued = await tool(ctx.app.app, ctx.token, "queue_encode", { itemId, targetGb: 8 });
    expect(queued.data.ok).toBe(true);
    const job = ctx.store.getJob(String(queued.data.jobId));
    expect(job?.plan).toMatchObject({ origin: "custom", writeMode: "sidecar" });
    expect(job?.plan && "video" in job.plan && job.plan.video && (job.plan.video as { targetBytes?: number }).targetBytes).toBe(8 * 1024 ** 3);
  });

  it("rejects an undersized encode and direct write when Settings use sidecar", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const itemId = ctx.store.listItems()[0]!.id;
    const tiny = await tool(ctx.app.app, ctx.token, "queue_encode", { itemId, targetBytes: 100 });
    expect(tiny.isError).toBe(true);
    expect(String(tiny.data.error)).toMatch(/1 MB/i);
    const av1 = await tool(ctx.app.app, ctx.token, "queue_encode", { itemId, targetGb: 4, codec: "av1" });
    expect(av1.isError).toBe(true);
    const direct = await tool(ctx.app.app, ctx.token, "queue_encode", { itemId, targetGb: 4, writeMode: "direct" });
    expect(direct.data.error).toBe("Direct write is off in Settings.");
  });

  it("keeps and discards Review items only with the confirm words", async () => {
    const ctx = await ready();
    apps.push(ctx);
    const item = ctx.store.listItems()[0]!;
    const sidecar = join(ctx.dir, "review", "keep-me.mkv");
    writeFileSync(sidecar, "sidecar");
    writeFileSync(item.path.startsWith("/mnt") ? join(ctx.dir, "orig.mkv") : item.path, "orig");
    ctx.store.insertReview({
      id: "rev-mcp",
      jobId: "job-mcp",
      itemId: item.id,
      displayTitle: "American Underdog",
      status: "pending",
      flagged: false,
      flagReason: null,
      sourcePath: item.path,
      sidecarPath: sidecar,
      source: { codec: "h264", quality: "HD", sizeBytes: 8, sizePerHourGb: 8, durationSec: 60, tracks: "1 audio / 0 subtitles" },
      sidecar: { codec: "hevc", quality: "HD", sizeBytes: 3, sizePerHourGb: 3, durationSec: 60, tracks: "1 audio / 0 subtitles" },
      error: null,
    });
    const refused = await tool(ctx.app.app, ctx.token, "keep_review", { reviewId: "rev-mcp", confirm: "yes" });
    expect(refused.data.error).toMatch(/KEEP/);
    expect(ctx.store.getReview("rev-mcp")?.status).toBe("pending");
    const discarded = await tool(ctx.app.app, ctx.token, "discard_review", { reviewId: "rev-mcp", confirm: "DISCARD" });
    expect(discarded.data.ok).toBe(true);
    expect(ctx.store.getReview("rev-mcp")).toBeUndefined();
  });
});

describe("MCP encode draft", () => {
  it("converts targetGb to bytes and prefers quality when both are set", () => {
    const size = encodeDraftFromArgs({ itemId: "x", targetGb: 8 });
    expect(size).toMatchObject({ ok: true, targetBytes: 8 * 1024 ** 3 });
    const quality = encodeDraftFromArgs({ itemId: "x", targetGb: 8, quality: 22 });
    expect(quality).toMatchObject({ ok: true, draft: { video: { mode: "quality", quality: 22 } } });
    expect(encodeDraftFromArgs({ itemId: "x" }).ok).toBe(false);
  });
});
