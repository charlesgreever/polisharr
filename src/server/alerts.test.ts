import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { AlertService, DEFAULT_ALERT_PREFS, type AlertGateway, type AlertState } from "./alerts.ts";
import { loadEnv } from "./env.ts";
import { JobService } from "./jobs.ts";
import { Store } from "./store.ts";
import type { SmtpAccount } from "./smtp.ts";
import type { ReviewItem } from "./types.ts";

const MINUTE = 60_000;
const ZONE = "UTC";

function gateway(pending = { count: 0, flagged: 0 }): {
  gateway: AlertGateway;
  state: () => AlertState;
  setUrl: (url: string | null) => void;
  setSmtp: (account: SmtpAccount | null) => void;
  setDiscord: (url: string | null) => void;
} {
  let state: AlertState = {
    prefs: { ...DEFAULT_ALERT_PREFS, reviewUrl: "http://192.168.1.10:7373" },
    outbox: [],
    lastError: null,
    lastReminderDay: null,
  };
  let url: string | null = "http://hooks.test/notify";
  let account: SmtpAccount | null = null;
  let discord: string | null = null;
  const port: AlertGateway = {
    load: () => state,
    save: (next) => {
      state = next;
    },
    webhook: () => (url ? { url, token: "secret-token" } : null),
    pendingReviews: () => pending,
    smtp: () => account,
    hasSmtpPassword: () => Boolean(account?.password),
    discord: () => discord,
  };
  return {
    gateway: port,
    state: () => state,
    setUrl: (next) => {
      url = next;
    },
    setSmtp: (next: SmtpAccount | null) => {
      account = next;
    },
    setDiscord: (next: string | null) => {
      discord = next;
    },
  };
}

function review(title: string, flagged = false) {
  return {
    title,
    sourceBytes: 8_000_000_000,
    finishedBytes: 3_000_000_000,
    sizePerHourGb: flagged ? 9 : 3,
    flagged,
    nodeName: "4070",
  };
}

function posted(calls: Array<{ url: string; init?: RequestInit }>): unknown[] {
  return calls.map((call) => JSON.parse(String(call.init?.body ?? "{}")));
}

describe("alert delivery", () => {
  it("sends one webhook after two Review finishes inside the digest window", async () => {
    let now = Date.UTC(2026, 0, 2, 15, 0, 0);
    const { gateway: port } = gateway();
    const alerts = new AlertService(port, () => now, ZONE);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok");
    }) as typeof fetch;

    alerts.noteReview(review("Arrival"), now);
    alerts.noteReview(review("Blade Runner", true), now + 10 * MINUTE);
    await alerts.flush(fetchImpl);
    expect(calls).toHaveLength(0);

    now += 15 * MINUTE;
    await alerts.flush(fetchImpl);
    expect(calls).toHaveLength(0);

    now = Date.UTC(2026, 0, 2, 15, 0, 0) + 25 * MINUTE;
    await alerts.flush(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://hooks.test/notify");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer secret-token",
    });
    expect(posted(calls)[0]).toMatchObject({
      event: "review-ready",
      title: "2 files are waiting in Review",
      count: 2,
      flagged: 1,
      reviewUrl: "http://192.168.1.10:7373",
      error: null,
      titles: ["Arrival", "Blade Runner"],
    });
  });

  it("holds a Review notice until quiet hours end", async () => {
    let now = Date.UTC(2026, 0, 2, 23, 30, 0);
    const { gateway: port, state } = gateway();
    state().prefs = { ...state().prefs, quietEnabled: true, quietStart: "23:00", quietEnd: "07:00" };
    const alerts = new AlertService(port, () => now, ZONE);
    const calls: string[] = [];
    const fetchImpl = (async () => {
      calls.push("sent");
      return new Response("ok");
    }) as typeof fetch;
    alerts.noteReview(review("Dune"), now);
    now = Date.UTC(2026, 0, 3, 6, 50, 0);
    await alerts.flush(fetchImpl);
    expect(calls).toHaveLength(0);
    now = Date.UTC(2026, 0, 3, 7, 0, 0);
    await alerts.flush(fetchImpl);
    expect(calls).toHaveLength(1);
  });

  it("keeps the notice when the webhook refuses it", async () => {
    let now = Date.UTC(2026, 0, 2, 12, 0, 0);
    const { gateway: port, state } = gateway();
    const alerts = new AlertService(port, () => now, ZONE);
    alerts.noteFailure({ title: "Heat", error: "Device creation failed.", nodeName: "homeserverarc" }, now);
    let status = 500;
    await alerts.flush((async () => new Response("no", { status })) as typeof fetch);
    expect(state().lastError).toBe("The webhook returned HTTP 500.");
    expect(state().outbox).toHaveLength(1);
    status = 200;
    await alerts.flush((async () => new Response("ok", { status })) as typeof fetch);
    expect(state().outbox).toHaveLength(0);
    expect(state().lastError).toBeNull();
  });

  it("sends one daily reminder while Review still has files", async () => {
    let now = Date.UTC(2026, 0, 2, 8, 0, 0);
    const { gateway: port, state } = gateway({ count: 4, flagged: 2 });
    const alerts = new AlertService(port, () => now, ZONE);
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("ok");
    }) as typeof fetch;
    await alerts.flush(fetchImpl);
    await alerts.flush(fetchImpl);
    expect(calls).toEqual([
      expect.objectContaining({
        event: "still-waiting",
        title: "4 files are waiting in Review",
        count: 4,
        flagged: 2,
      }),
    ]);
    expect(state().lastReminderDay).toBe("2026-01-02");
  });

  it("leaves a pending Review row in place when delivery fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-alert-review-"));
    const store = new Store(join(dir, "polisharr.db"));
    const frame = { codec: "hevc", quality: "HD", sizeBytes: 8, sizePerHourGb: 1, durationSec: 100, tracks: "1 audio / 0 subtitles" };
    const row: ReviewItem = {
      id: "rev-1",
      jobId: "job-1",
      itemId: "item-1",
      displayTitle: "Heat",
      status: "pending",
      flagged: false,
      flagReason: null,
      sourcePath: join(dir, "heat.mkv"),
      sidecarPath: join(dir, "heat.polisharr.mkv"),
      source: frame,
      sidecar: frame,
      error: null,
    };
    store.insertReview(row);
    const { gateway: port } = gateway();
    const alerts = new AlertService(port, () => Date.UTC(2026, 0, 2, 12, 0, 0), ZONE);
    alerts.noteReview(review("Heat"), Date.UTC(2026, 0, 2, 12, 0, 0));
    await alerts.flush((async () => new Response("no", { status: 502 })) as typeof fetch);
    expect(store.getReview("rev-1")?.status).toBe("pending");
    expect(store.getReview("rev-1")?.sourcePath).toBe(row.sourcePath);
    store.close();
  });

  it("sends a direct write on its own without waiting for the Review digest", async () => {
    let now = Date.UTC(2026, 0, 2, 15, 0, 0);
    const { gateway: port } = gateway();
    const alerts = new AlertService(port, () => now, ZONE);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok");
    }) as typeof fetch;
    alerts.noteReview(review("Arrival"), now);
    alerts.noteDirectWrite({ title: "Dune", sourceBytes: 8_000_000_000, finishedBytes: 3_000_000_000 }, now);
    await alerts.flush(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(posted(calls)[0]).toMatchObject({ event: "direct-write", title: "Dune", count: 1 });
  });

  it("sends a Review notice that was queued before a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-alert-restart-"));
    const dbPath = join(dir, "polisharr.db");
    let now = Date.UTC(2026, 0, 2, 15, 0, 0);
    const first = new Store(dbPath);
    const alerts = new AlertService(persisted(first), () => now, ZONE);
    alerts.replacePrefs({ ...DEFAULT_ALERT_PREFS, reviewUrl: "http://192.168.1.10:7373" });
    alerts.noteReview(review("Arrival"), now);
    first.close();

    now += 15 * MINUTE;
    const reopened = new Store(dbPath);
    const again = new AlertService(persisted(reopened), () => now, ZONE);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await again.flush((async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok");
    }) as typeof fetch);
    expect(posted(calls)).toEqual([
      expect.objectContaining({
        event: "review-ready",
        title: "Arrival",
        count: 1,
        titles: ["Arrival"],
      }),
    ]);
    reopened.close();
  });
});

function persisted(store: Store): AlertGateway {
  return {
    load: () => store.loadAlertState(),
    save: (state) => store.saveAlertState(state),
    webhook: () => ({ url: "http://hooks.test/notify", token: "secret-token" }),
    pendingReviews: () => store.reviewAlertSummary(),
  };
}

describe("alert settings HTTP", () => {
  it("saves a webhook without echoing the URL and sends a test", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-alert-http-"));
    const calls: Array<{ url: string; body: string }> = [];
    const env = loadEnv({ CONFIG_DIR: dir, PORT: "7373" });
    const created = createApp({
      env,
      hardware: async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null }),
      readable: async () => true,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response("ok");
      }) as typeof fetch,
    });
    created.jobs.stop();
    created.alerts.stop();
    const unsigned = await created.app.request("/api/alerts/test", { method: "POST" });
    expect(unsigned.status).toBe(401);
    const setup = await created.app.request("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "secret12" }),
    });
    const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
    const headers = { cookie, "content-type": "application/json" };
    const saved = await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        alerts: {
          reviewUrl: "http://192.168.1.10:7373",
          webhookUrl: "http://hooks.test/notify",
          webhookToken: "secret-token",
        },
      }),
    });
    expect(saved.status).toBe(200);
    const listed = await created.app.request("/api/settings", { headers });
    const body = await listed.json() as { alerts: { hasWebhookUrl: boolean; hasWebhookToken: boolean; reviewUrl: string } };
    expect(body.alerts.hasWebhookUrl).toBe(true);
    expect(body.alerts.hasWebhookToken).toBe(true);
    expect(body.alerts.reviewUrl).toBe("http://192.168.1.10:7373");
    expect(JSON.stringify(body)).not.toContain("hooks.test");
    expect(JSON.stringify(body)).not.toContain("secret-token");
    const test = await created.app.request("/api/alerts/test", { method: "POST", headers });
    expect(test.status).toBe(200);
    expect(calls.some((call) => call.url === "http://hooks.test/notify" && call.body.includes("Polisharr test"))).toBe(true);
    const discordSaved = await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ alerts: { discordUrl: "https://discord.test/api/webhooks/1/secret" } }),
    });
    expect(discordSaved.status).toBe(200);
    const afterDiscord = await created.app.request("/api/settings", { headers });
    const discordBody = await afterDiscord.json() as { alerts: { hasDiscordWebhook: boolean } };
    expect(discordBody.alerts.hasDiscordWebhook).toBe(true);
    expect(JSON.stringify(discordBody)).not.toContain("discord.test");
    const discordTest = await created.app.request("/api/alerts/test-discord", { method: "POST", headers });
    expect(discordTest.status).toBe(200);
    expect(calls.some((call) => call.url === "https://discord.test/api/webhooks/1/secret" && call.body.includes("Polisharr test"))).toBe(true);
    const rejected = await created.app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ alerts: { webhookUrl: "file:///tmp/hook" } }),
    });
    expect(rejected.status).toBe(400);
    created.alerts.stop();
    created.store.close();
  });
});

describe("email delivery", () => {
  it("sends one email after two Review finishes inside the digest window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-alert-mail-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", join(dir, "key.pem"),
      "-out", join(dir, "cert.pem"),
      "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ]);
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const key = readFileSync(join(dir, "key.pem"), "utf8");
    const received: string[] = [];
    const server = createTlsServer({ key, cert }, (socket: TLSSocket) => {
      socket.write("220 localhost ESMTP\r\n");
      let mode: "line" | "data" = "line";
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          if (mode === "data") {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            received.push(buf.slice(0, end));
            buf = buf.slice(end + 5);
            mode = "line";
            socket.write("250 OK\r\n");
            continue;
          }
          const nl = buf.indexOf("\r\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (upper.startsWith("AUTH")) socket.write("235 OK\r\n");
          else if (upper === "DATA") {
            socket.write("354 Go\r\n");
            mode = "data";
          } else if (upper.startsWith("QUIT")) socket.write("221 Bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    let now = Date.UTC(2026, 0, 2, 15, 0, 0);
    const harness = gateway();
    harness.setUrl(null);
    harness.setSmtp({
      host: "127.0.0.1",
      port,
      security: "tls",
      username: "ada",
      password: "app-password",
      from: "polisharr@example.com",
      to: "ada@example.com",
      ca: cert,
    });
    const alerts = new AlertService(harness.gateway, () => now, ZONE);
    alerts.noteReview(review("Arrival"), now);
    alerts.noteReview(review("Blade Runner", true), now + 10 * MINUTE);
    now = Date.UTC(2026, 0, 2, 15, 0, 0) + 25 * MINUTE;
    await alerts.flush((async () => new Response("ok")) as typeof fetch);
    server.close();
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("Arrival");
    expect(received[0]).toContain("Blade Runner");
    expect(received[0]).toContain("2 files are waiting in Review");
    expect(received[0]).not.toContain("app-password");
  });
});

describe("Discord delivery", () => {
  it("posts one embed for two Review finishes", async () => {
    let now = Date.UTC(2026, 0, 2, 15, 0, 0);
    const harness = gateway();
    harness.setUrl(null);
    harness.setDiscord("https://discord.test/api/webhooks/1/secret");
    const alerts = new AlertService(harness.gateway, () => now, ZONE);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    alerts.noteReview(review("Arrival"), now);
    alerts.noteReview(review("Blade Runner", true), now + 10 * MINUTE);
    now = Date.UTC(2026, 0, 2, 15, 0, 0) + 25 * MINUTE;
    await alerts.flush((async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok");
    }) as typeof fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.test/api/webhooks/1/secret");
    const body = posted(calls)[0] as { embeds: Array<{ title: string; description: string; url: string; footer: { text: string } }> };
    expect(body.embeds[0]).toMatchObject({
      title: "2 files are waiting in Review",
      url: "http://192.168.1.10:7373",
      footer: { text: "4070" },
    });
    expect(body.embeds[0]?.description).toContain("Arrival");
    expect(body.embeds[0]?.description).toContain("Blade Runner");
    expect(body.embeds[0]?.description).toContain("Missed the size target.");
  });
});

describe("job failure notices", () => {
  it("keeps a failed job when the failure notice cannot be delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-alert-job-"));
    const store = new Store(join(dir, "polisharr.db"));
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    const hardware = { backend: "cuda" as const, cuda: true, vaapi: false, av1: false, reason: null };
    store.upsertNode({
      id: "4070", name: "4070", role: "worker", lastSeen: now, hardware, concurrency: 1, enabled: true, version: "1", currentJobId: null,
    });
    store.saveSettings({ ...store.getSettings(), reviewPath: dir, offPeakEnabled: false, defaultEncodeNodeId: "4070" });
    const instanceId = store.upsertInstance({ kind: "radarr", name: "Radarr", url: "http://radarr", secret: null, enabled: true });
    const itemId = `${instanceId}:movie:9`;
    store.upsertItem({
      id: itemId, instanceId, arrId: 9, arrSeriesId: null, arrEpisodeFileId: null, type: "movie",
      title: "Heat", showTitle: null, season: null, episode: null, episodeTitle: null,
      path: join(dir, "heat.mkv"), sizeBytes: 8, quality: "HD", resolution: "1080", profile: "HD",
      tags: [], posterRemoteUrl: null, sizeExempt: false,
    });
    const harness = gateway();
    const alerts = new AlertService(harness.gateway, () => now, ZONE);
    const jobs = new JobService({
      store,
      optimizer: async () => { throw new Error("must not encode"); },
      clock: () => now,
      hardware: async () => hardware,
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
      decrypt: () => "",
      fetch: (async () => new Response("{}")) as typeof fetch,
      reinspectChangedItem: async () => ({ ok: true }),
      alerts,
    });
    const suggestion = {
      id: "s1",
      itemId,
      actions: ["add_stereo" as const],
      reasons: ["Add stereo."],
      warning: null,
      category: "movie1080p" as const,
      estimatedSavingsBytes: null,
      now: { codec: "hevc", quality: "HD", sizeBytes: 8, sizePerHourGb: 1 },
      after: { codec: "hevc", quality: null, sizeBytes: null, sizePerHourGb: null },
      dismissed: false,
      keepAudio: [1],
      stripAudio: [],
      keepSubs: [],
      stripSubs: [],
    };
    const queued = jobs.enqueue(itemId, suggestion, { writeMode: "sidecar" as const, assignedNodeId: "4070" });
    expect("id" in queued).toBe(true);
    if (!("id" in queued)) return;
    const claimed = store.claimQueuedJobs("4070", 1, now, 60_000);
    expect(jobs.failRemote(queued.id, claimed[0]!.leaseToken, "Device creation failed.")).toEqual({ ok: true });
    expect(store.getJob(queued.id)?.status).toBe("failed");
    await alerts.flush((async () => new Response("no", { status: 500 })) as typeof fetch);
    expect(store.getJob(queued.id)?.status).toBe("failed");
    expect(store.getJob(queued.id)?.error).toBe("Device creation failed.");
    expect(harness.state().lastError).toBe("The webhook returned HTTP 500.");
    store.close();
  });
});
