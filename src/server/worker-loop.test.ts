import { describe, expect, it } from "vitest";
import {
  CLUSTER_NOT_MASTER,
  CLUSTER_WRONG_TOKEN,
  PREVIEW_LEASE_MS,
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_SDR_1080P_PROFILE,
} from "./cluster.ts";
import { joinMasterPath, WorkerLoop } from "./worker-loop.ts";
import type { HardwareInfo } from "./types.ts";

const hw: HardwareInfo = { backend: "cuda", cuda: true, vaapi: false, av1: true, reason: null };

function loop(over: Partial<ConstructorParameters<typeof WorkerLoop>[0]> & { fetch?: typeof fetch } = {}) {
  return new WorkerLoop({
    nodeId: "worker-1",
    name: "5090",
    version: "0.2.18",
    masterUrl: "http://192.168.1.10:7373",
    token: "secret",
    hardware: async () => hw,
    concurrency: () => 1,
    fetch: over.fetch ?? (async () => new Response("{}", { status: 500 })),
    ...over,
  });
}

describe("worker loop", () => {
  it("stays idle without a master URL or token", async () => {
    const worker = loop({ masterUrl: null, token: null });
    await worker.tick();
    expect(worker.snapshot()).toMatchObject({
      status: "misconfigured",
      registered: false,
    });
    expect(worker.snapshot().detail).toContain("POLISHARR_MASTER_URL");
  });

  it("hellos then heartbeats on later ticks", async () => {
    const calls: string[] = [];
    const worker = loop({
      fetch: (async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    await worker.tick();
    await worker.tick();
    expect(calls[0]).toBe("http://192.168.1.10:7373/api/cluster/hello");
    expect(calls).toContain("http://192.168.1.10:7373/api/cluster/heartbeat");
    expect(calls.some((url) => url.includes("/api/cluster/claim"))).toBe(false);
    expect(worker.snapshot().status).toBe("connected");
    expect(worker.snapshot().detail).toContain("http://192.168.1.10:7373");
  });

  it("does not send a token in the status sentence when the master rejects it", async () => {
    const worker = loop({
      fetch: (async () => new Response(JSON.stringify({ error: CLUSTER_WRONG_TOKEN }), { status: 401 })) as typeof fetch,
    });
    await worker.tick();
    expect(worker.snapshot().status).toBe("rejected");
    expect(worker.snapshot().detail).toBe(CLUSTER_WRONG_TOKEN);
    expect(JSON.stringify(worker.snapshot())).not.toContain("secret");
  });

  it("re-hellos after the master forgets the node", async () => {
    const calls: string[] = [];
    const worker = loop({
      fetch: (async (url) => {
        const path = String(url);
        calls.push(path);
        if (path.endsWith("/heartbeat")) return new Response(JSON.stringify({ error: "That node is not registered." }), { status: 404 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    await worker.tick();
    await worker.tick();
    await worker.tick();
    expect(calls.filter((path) => path.endsWith("/hello")).length).toBeGreaterThanOrEqual(2);
  });

  it("stays idle when the master is unreachable", async () => {
    const worker = loop({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await worker.tick();
    expect(worker.snapshot().status).toBe("unreachable");
    expect(worker.snapshot().detail).toContain("Encodes stay idle");
  });

  it("treats a standalone master URL as rejected, not a join", async () => {
    const worker = loop({
      fetch: (async () => new Response(JSON.stringify({ error: CLUSTER_NOT_MASTER }), { status: 404 })) as typeof fetch,
    });
    await worker.tick();
    expect(worker.snapshot().status).toBe("rejected");
    expect(worker.snapshot().detail).toBe(CLUSTER_NOT_MASTER);
  });

  it("builds hello and heartbeat URLs on the master origin", () => {
    expect(joinMasterPath("http://192.168.1.10:7373", "/api/cluster/hello")).toBe("http://192.168.1.10:7373/api/cluster/hello");
    expect(joinMasterPath("not a url", "/api/cluster/hello")).toBeNull();
  });

  it("advertises preview capability and claims preview documents without calling the optimizer", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    let optimized = false;
    let rendered = 0;
    const worker = loop({
      optimizer: async () => {
        optimized = true;
        throw new Error("Preview work must not use the optimize-job runner.");
      },
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
      previewCapability: async () => ({
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        h264Encoder: "h264_nvenc",
        profiles: [PREVIEW_SDR_1080P_PROFILE],
      }),
      previewRenderer: async () => {
        rendered += 1;
        return { ok: true as const };
      },
      fetch: (async (url, init) => {
        const path = String(url);
        calls.push(path);
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        if (path.endsWith("/api/cluster/hello") || path.endsWith("/api/cluster/heartbeat")) {
          return new Response(JSON.stringify({ ok: true, concurrency: 1 }), { status: 200 });
        }
        if (path.endsWith("/api/cluster/previews/claim")) {
          return new Response(JSON.stringify({
            previews: [{
              kind: "preview",
              protocolVersion: PREVIEW_PROTOCOL_VERSION,
              id: "prv-1",
              leaseToken: "tok",
              leaseUntil: 31_000,
              reviewId: "rev-1",
              sourcePath: "/a.mkv",
              sidecarPath: "/b.mkv",
              request: { startMs: 0, durationMs: 15_000, originalAudioIndex: null, sidecarAudioIndex: null },
              profileId: PREVIEW_SDR_1080P_PROFILE,
              nodeId: "worker-1",
            }],
          }), { status: 200 });
        }
        if (path.endsWith("/api/cluster/claim")) {
          return new Response(JSON.stringify({ jobs: [{ kind: "preview", id: "prv-1", leaseToken: "tok" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((url) => url.includes("/api/cluster/previews/claim"))).toBe(true);
    expect((bodies[0] as { preview?: { h264Encoder?: string } }).preview?.h264Encoder).toBe("h264_nvenc");
    expect(optimized).toBe(false);
    expect(rendered).toBe(1);
  });

  it("fails a claimed preview when the document cannot be parsed instead of leaving the lease running", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const worker = loop({
      previewCapability: async () => ({
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        h264Encoder: "h264_nvenc",
        profiles: [PREVIEW_SDR_1080P_PROFILE],
      }),
      previewRenderer: async () => ({ ok: true as const }),
      fetch: (async (url, init) => {
        const path = String(url);
        calls.push(path);
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        if (path.endsWith("/api/cluster/hello") || path.endsWith("/api/cluster/heartbeat")) {
          return new Response(JSON.stringify({ ok: true, concurrency: 1 }), { status: 200 });
        }
        if (path.endsWith("/api/cluster/previews/claim")) {
          return new Response(JSON.stringify({
            previews: [{
              kind: "preview",
              id: "prv-bad",
              leaseToken: "tok-bad",
              leaseUntil: 31_000,
              reviewId: "rev-1",
              sourcePath: "/a.mkv",
              sidecarPath: "/b.mkv",
              nodeId: "worker-1",
            }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((url) => url.endsWith("/api/cluster/previews/prv-bad/fail"))).toBe(true);
    expect(bodies.some((body) => (
      body
      && typeof body === "object"
      && (body as { leaseToken?: string }).leaseToken === "tok-bad"
      && typeof (body as { error?: string }).error === "string"
    ))).toBe(true);
  });

  it("kills preview children when the master stays disconnected past the local lease deadline", async () => {
    let now = 0;
    let killed = false;
    const worker = loop({
      monotonic: () => now,
      previewCapability: async () => ({
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        h264Encoder: "h264_nvenc",
        profiles: [PREVIEW_SDR_1080P_PROFILE],
      }),
      previewRenderer: async (_task, control) => {
        control.registerChild({
          kill: () => {
            killed = true;
            return true;
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ok: true as const };
      },
      fetch: (async (url) => {
        const path = String(url);
        if (path.endsWith("/hello")) return new Response(JSON.stringify({ ok: true, concurrency: 1 }), { status: 200 });
        if (path.endsWith("/previews/claim")) {
          return new Response(JSON.stringify({
            previews: [{
              kind: "preview",
              protocolVersion: PREVIEW_PROTOCOL_VERSION,
              id: "prv-1",
              leaseToken: "tok",
              leaseUntil: PREVIEW_LEASE_MS,
              reviewId: "rev-1",
              sourcePath: "/a.mkv",
              sidecarPath: "/b.mkv",
              request: { startMs: 0, durationMs: 15_000, originalAudioIndex: null, sidecarAudioIndex: null },
              profileId: PREVIEW_SDR_1080P_PROFILE,
              nodeId: "worker-1",
            }],
          }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    now = PREVIEW_LEASE_MS + 1;
    await worker.tick();
    expect(killed).toBe(true);
  });
});
