import { describe, expect, it } from "vitest";
import { CLUSTER_NOT_MASTER, CLUSTER_WRONG_TOKEN } from "./cluster.ts";
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
});
