import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import argon2 from "argon2";
import { readAppVersion, type Env } from "./env.ts";
import { Store } from "./store.ts";
import { decryptSecret, encryptSecret, loadOrCreateSecret } from "./secrets.ts";
import { detectHardware, type HardwareProbe } from "./hardware.ts";
import { isLocalAddress, requestAddress } from "./net.ts";
import {
  testRadarr,
  testSonarr,
  trimUrl,
} from "./arr.ts";
import { buildSuggestion } from "./suggest.ts";
import { deleteArrFileAndSearch, soleNonPreferredAudio } from "./arr-search.ts";
import { displayTitle, matchesTitleSearch } from "./titles.ts";
import { JobService } from "./jobs.ts";
import { ffmpegOptimizer, isoRemuxInputs, toolLocaleEnv, type Optimizer } from "./optimize.ts";
import { isDolbyVisionProfile5, isIsoPath } from "./inspect.ts";
import {
  applyLanguageToReport,
  detectLanguageClip,
  languageDisplayName,
  languageLidProcessEnv,
  LID_MIN_PROBABILITY,
} from "./language-id.ts";
import { applySubtitleLanguageToReport, detectSubtitleLanguageSample } from "./subtitle-language-id.ts";
import { testJellyfin, testPlex } from "./notify.ts";
import { profilePreviews, syncProfiles } from "./arr-profiles.ts";
import { validateCustomPlan } from "./custom-plan.ts";
import type { ArrKind, CustomPlanDraft, HardwareInfo, PlayerKind, Settings, Suggestion } from "./types.ts";
import { parseAudioMix, parseVideoTarget } from "./types.ts";
import { createInspectionRunner } from "./inspection-runner.ts";
import { createLibraryReadModel } from "./library-read-model.ts";
import { shouldQueueNewImport } from "./auto-queue.ts";
import { updateSettings } from "./settings.ts";
import { LibrarySync, pathsOverlap } from "./library-sync.ts";
import { parseArrWebhook, presentedWebhookToken, webhookTokenMatches } from "./arr-webhook.ts";
import { parseSuggestionFilters } from "./suggestion-filters.ts";
import {
  CLUSTER_NOT_MASTER,
  CLUSTER_UNKNOWN_NODE,
  CLUSTER_WRONG_TOKEN,
  LEASE_MS,
  WORKER_MANAGE_ERROR,
  clusterHasAv1,
  clusterHasHardware,
  nodeHardwareLabel,
  nodeIsOnline,
  nodeRoleLabel,
  parseClusterClaim,
  parseClusterHeartbeat,
  parseClusterHello,
  parseRemoteComplete,
  parseRemoteFail,
  parseRemoteProgress,
  type ClusterNode,
} from "./cluster.ts";
import { WorkerLoop } from "./worker-loop.ts";

const execFileAsync = promisify(execFile);
const SESSION_TTL = 14 * 24 * 60 * 60 * 1000;
const GENERIC_LOGIN = "Username or password is wrong.";

function isBrowserForm(c: Context): boolean {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  return type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
}

async function readUserPass(c: Context): Promise<{ username?: string; password?: string }> {
  if (isBrowserForm(c)) {
    const body = await c.req.parseBody();
    return {
      username: typeof body.username === "string" ? body.username : undefined,
      password: typeof body.password === "string" ? body.password : undefined,
    };
  }
  return c.req.json<{ username?: string; password?: string }>();
}

export type AppOptions = {
  env: Env;
  store?: Store;
  fetch?: typeof fetch;
  hardware?: HardwareProbe;
  optimizer?: Optimizer;
  probe?: (path: string, size: number) => Promise<Record<string, unknown>>;
  listIso?: (path: string, size: number) => Promise<string>;
  clock?: () => number;
  readable?: (path: string) => Promise<boolean>;
  clientAddress?: (context: Context) => string | undefined;
  syncIntervalMs?: number;
  extractLanguageClip?: (args: string[]) => Promise<void>;
  runLanguageLid?: (clipPath: string) => Promise<string>;
  extractSubtitleSample?: (args: string[]) => Promise<string>;
  extractSubtitleSup?: (args: string[]) => Promise<void>;
  runPgsOcr?: (supPath: string) => Promise<string>;
  version?: string;
};

export function createApp(opts: AppOptions) {
  const version = opts.version ?? readAppVersion();
  const store = opts.store ?? new Store(opts.env.dbPath);
  const secret = loadOrCreateSecret(opts.env.secretPath);
  const httpFetch = opts.fetch ?? fetch;
  const hardware = opts.hardware ?? detectHardware(opts.env.ffmpeg);
  const inspections = createInspectionRunner({
    store,
    ffmpeg: opts.env.ffmpeg,
    ffprobe: opts.env.ffprobe,
    readable: opts.readable,
    probe: opts.probe,
    listIso: opts.listIso,
    recomputeSuggestion: afterInspect,
  });
  const optimizer = opts.optimizer ?? ffmpegOptimizer();
  const jobs = new JobService({
    store,
    optimizer,
    clock: opts.clock,
    hardware,
    tools: { ffmpeg: opts.env.ffmpeg, ffprobe: opts.env.ffprobe, mkvmerge: opts.env.mkvmerge },
    decrypt: (packed) => decryptSecret(secret, packed),
    fetch: httpFetch,
    reinspectChangedItem: inspections.reinspectChangedItem,
    inspectOne: inspections.inspectOne,
    localNodeId: () => store.localNodeId(),
  });
  const isWorker = opts.env.role === "worker";
  if (!isWorker) jobs.start();
  const sync = new LibrarySync({
    store,
    fetch: httpFetch,
    decrypt: (packed) => decryptSecret(secret, packed),
    inspectPending: inspections.inspectPending,
    intervalMs: opts.syncIntervalMs,
  });
  const library = createLibraryReadModel(store);
  const workerLoop = new WorkerLoop({
    nodeId: store.localNodeId(),
    name: opts.env.nodeName || localHostname(),
    version,
    masterUrl: opts.env.masterUrl,
    token: opts.env.clusterTokenEnv,
    hardware,
    concurrency: () => Math.max(1, store.getSettings().concurrency),
    fetch: httpFetch,
    optimizer,
    tools: { ffmpeg: opts.env.ffmpeg, ffprobe: opts.env.ffprobe, mkvmerge: opts.env.mkvmerge },
  });

  const app = new Hono();

  if (isWorker) {
    app.use("/api/*", async (c, next) => {
      const path = c.req.path;
      if (path === "/api/health" || path === "/api/ready" || path === "/api/auth/status" || path === "/api/worker") {
        await next();
        return;
      }
      return c.json({ error: WORKER_MANAGE_ERROR }, 409);
    });
  }

  const cookieOpts = { httpOnly: true, path: "/", sameSite: "Lax" as const };

  function clientAddress(c: Context): string | undefined {
    if (opts.clientAddress) return opts.clientAddress(c);
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  }

  async function currentUser(c: Context) {
    const sid = getCookie(c, "polisharr");
    if (sid) {
      const session = store.getSession(sid, opts.clock?.() ?? Date.now());
      if (session) return { userId: session.userId, sessionId: sid };
    }
    const settings = store.getSettings();
    const ip = requestAddress(clientAddress(c), c.req.header("x-forwarded-for"), opts.env.trustProxy);
    if (settings.localAuthBypass && isLocalAddress(ip) && store.userCount() > 0) {
      const user = store.onlyUser();
      if (user) return { userId: user.id, sessionId: "local" };
    }
    return null;
  }

  function firstRunState() {
    const settings = store.getSettings();
    const arrs = store.listInstances().filter((i) => i.kind === "radarr" || i.kind === "sonarr");
    return {
      hasAdmin: store.userCount() > 0,
      languageConfirmed: settings.languageConfirmed,
      hasReviewPath: Boolean(settings.reviewPath),
      hasArr: arrs.some((i) => i.enabled),
      complete: store.userCount() > 0 && settings.languageConfirmed && Boolean(settings.reviewPath) && arrs.some((i) => i.enabled),
    };
  }

  app.get("/api/health", (c) => c.json({ ok: true, service: "polisharr", version }));

  app.get("/api/ready", (c) => {
    const settings = store.getSettings();
    return c.json({
      ok: true,
      configDir: Boolean(opts.env.configDir),
      timezone: opts.env.tz,
      port: opts.env.port,
      ffmpeg: opts.env.ffmpeg,
      mkvmerge: opts.env.mkvmerge,
      firstRun: firstRunState(),
      languageConfirmed: settings.languageConfirmed,
    });
  });

  app.get("/api/auth/status", async (c) => {
    const user = await currentUser(c);
    return c.json({
      authenticated: Boolean(user),
      firstRun: firstRunState(),
      version,
      role: opts.env.role,
    });
  });

  app.post("/api/auth/setup", async (c) => {
    const html = isBrowserForm(c);
    if (store.userCount() > 0) {
      if (html) return c.redirect("/login?error=1", 303);
      return c.json({ error: "An administrator already exists." }, 409);
    }
    const body = await readUserPass(c);
    if (!body.username || !body.password) {
      if (html) return c.redirect("/login?error=1", 303);
      return c.json({ error: "Username and password are required." }, 400);
    }
    const hash = await argon2.hash(body.password, { type: argon2.argon2id });
    store.createUser(body.username, hash);
    const sid = store.createSession(store.onlyUser()!.id, SESSION_TTL, opts.clock?.() ?? Date.now());
    setCookie(c, "polisharr", sid, cookieOpts);
    if (html) return c.redirect("/", 303);
    return c.json({ ok: true });
  });

  app.post("/api/auth/login", async (c) => {
    const html = isBrowserForm(c);
    const body = await readUserPass(c);
    const user = body.username ? store.findUser(body.username) : undefined;
    const ok = user ? await argon2.verify(user.passwordHash, body.password ?? "") : false;
    if (!user || !ok) {
      if (html) return c.redirect("/login?error=1", 303);
      return c.json({ error: GENERIC_LOGIN }, 401);
    }
    const sid = store.createSession(user.id, SESSION_TTL, opts.clock?.() ?? Date.now());
    setCookie(c, "polisharr", sid, cookieOpts);
    if (html) return c.redirect("/", 303);
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", async (c) => {
    const sid = getCookie(c, "polisharr");
    if (sid) store.deleteSession(sid);
    deleteCookie(c, "polisharr", { path: "/" });
    return c.json({ ok: true });
  });

  const authed: MiddlewareHandler = async (c, next) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: "Sign in to continue." }, 401);
    await next();
  };

  app.use("/api/settings", authed);
  app.use("/api/settings/*", authed);
  app.use("/api/integrations", authed);
  app.use("/api/integrations/*", authed);
  app.use("/api/library/*", authed);
  app.use("/api/inspect/*", authed);
  app.use("/api/suggestions", authed);
  app.use("/api/suggestions/*", authed);
  app.use("/api/exclusions", authed);
  app.use("/api/exclusions/*", authed);
  app.use("/api/jobs", authed);
  app.use("/api/jobs/*", authed);
  app.use("/api/review", authed);
  app.use("/api/review/*", authed);
  app.use("/api/errors", authed);
  app.use("/api/history", authed);
  app.use("/api/home", authed);
  app.use("/api/work", authed);
  app.use("/api/search", authed);
  app.use("/api/hardware", authed);
  app.use("/api/nodes", authed);
  app.use("/api/nodes/*", authed);
  app.use("/api/auth/password", authed);
  app.use("/api/queue", authed);

  function gateOptimize(): string | null {
    const state = firstRunState();
    if (!state.hasAdmin) return "Create an administrator account first.";
    if (!state.languageConfirmed) return "Confirm your preferred language before optimize work.";
    if (!state.hasReviewPath) return "Set a review folder that is not inside a movie or show library.";
    if (!state.hasArr) return "Connect at least one enabled Radarr or Sonarr instance.";
    return null;
  }

  app.get("/api/hardware", async (c) => c.json(await hardware()));

  app.get("/api/nodes", async (c) => {
    const thisNode = await refreshLocalNode();
    return c.json(nodesPayload(thisNode.id));
  });

  app.put("/api/nodes/:id", async (c) => {
    const node = store.getNode(c.req.param("id"));
    if (!node) return c.json({ error: "That encode node is not registered." }, 404);
    const body = await readJson(c);
    const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    let concurrency = node.concurrency;
    if (raw.concurrency !== undefined) {
      if (typeof raw.concurrency !== "number" || !Number.isSafeInteger(raw.concurrency) || raw.concurrency < 1 || raw.concurrency > 16) {
        return c.json({ error: "Concurrent jobs on a node must be a whole number from 1 to 16." }, 400);
      }
      concurrency = raw.concurrency;
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      return c.json({ error: "Drain must be true or false." }, 400);
    }
    const enabled = raw.enabled === undefined ? node.enabled : raw.enabled;
    store.upsertNode({ ...node, concurrency, enabled });
    if (node.id === store.localNodeId() && concurrency !== store.getSettings().concurrency) {
      store.saveSettings({ ...store.getSettings(), concurrency });
    }
    return c.json({ ok: true, node: publicNode(store.getNode(node.id)!, store.localNodeId()) });
  });

  app.delete("/api/nodes/:id", async (c) => {
    const thisNode = await refreshLocalNode();
    const id = c.req.param("id");
    if (id === thisNode.id) {
      return c.json({ error: "This computer is the master. It cannot be removed." }, 400);
    }
    const node = store.getNode(id);
    if (!node) return c.json({ error: "That encode node is not registered." }, 404);
    const jobs = store.listJobs().filter((job) => job.assignedNodeId === id || job.nodeId === id);
    if (jobs.some((job) => job.status === "running")) {
      return c.json({ error: "Stop the running job on this node first." }, 409);
    }
    if (jobs.some((job) => job.status === "queued" || job.status === "held")) {
      return c.json({ error: "Move or cancel waiting jobs on this node first." }, 409);
    }
    if (store.getSettings().defaultEncodeNodeId === id) {
      store.saveSettings({ ...store.getSettings(), defaultEncodeNodeId: "" });
    }
    store.deleteNode(id);
    return c.json({ ok: true, ...nodesPayload(thisNode.id) });
  });

  app.get("/api/worker", async (c) => {
    if (!isWorker) return c.json({ error: "This container is not a worker." }, 404);
    const hardwareInfo = await hardware();
    const join = workerLoop.snapshot();
    return c.json({
      role: "worker" as const,
      name: opts.env.nodeName || localHostname(),
      nodeId: store.localNodeId(),
      masterUrl: opts.env.masterUrl,
      version,
      hardware: hardwareInfo,
      hardwareLabel: nodeHardwareLabel(hardwareInfo),
      status: join.status,
      detail: join.detail,
      currentJobId: join.currentJobId,
    });
  });

  app.post("/api/cluster/hello", async (c) => {
    const denied = clusterAdmission(c);
    if (denied) return denied;
    const parsed = parseClusterHello(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const now = clusterNow();
    const existing = store.getNode(parsed.hello.nodeId);
    const av1Before = clusterAv1();
    store.upsertNode({
      id: parsed.hello.nodeId,
      name: parsed.hello.name,
      role: "worker",
      lastSeen: now,
      hardware: parsed.hello.hardware,
      concurrency: existing?.concurrency ?? parsed.hello.concurrency,
      enabled: existing?.enabled ?? true,
      version: parsed.hello.version,
      currentJobId: null,
    });
    if (clusterAv1() !== av1Before) recomputeAllSuggestions();
    const node = store.getNode(parsed.hello.nodeId);
    return c.json({ ok: true, nodeId: parsed.hello.nodeId, concurrency: node?.concurrency ?? parsed.hello.concurrency });
  });

  app.post("/api/cluster/heartbeat", async (c) => {
    const denied = clusterAdmission(c);
    if (denied) return denied;
    const parsed = parseClusterHeartbeat(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const existing = store.getNode(parsed.beat.nodeId);
    if (!existing) return c.json({ error: CLUSTER_UNKNOWN_NODE }, 404);
    const now = opts.clock?.() ?? Date.now();
    store.upsertNode({
      ...existing,
      lastSeen: now,
      hardware: parsed.beat.hardware,
      currentJobId: parsed.beat.currentJobId,
      version: existing.version,
    });
    store.renewNodeLeases(parsed.beat.nodeId, parsed.beat.runningJobIds, now + LEASE_MS);
    const node = store.getNode(parsed.beat.nodeId);
    return c.json({
      ok: true,
      cancelJobIds: store.cancelledIdsForNode(parsed.beat.nodeId),
      concurrency: node?.concurrency ?? existing.concurrency,
    });
  });

  app.post("/api/cluster/claim", async (c) => {
    const denied = clusterAdmission(c);
    if (denied) return denied;
    const parsed = parseClusterClaim(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (!store.getNode(parsed.nodeId)) return c.json({ error: CLUSTER_UNKNOWN_NODE }, 404);
    const claimed = jobs.claimForNode(parsed.nodeId, parsed.freeSlots);
    return c.json({ jobs: claimed });
  });

  app.post("/api/cluster/jobs/:id/progress", async (c) => {
    const denied = clusterAdmission(c);
    if (denied) return denied;
    const parsed = parseRemoteProgress(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const result = jobs.progressRemote(c.req.param("id"), parsed.leaseToken, parsed.phase, parsed.progress, parsed.log);
    if ("cancelled" in result) return c.json({ cancelled: true }, 409);
    if ("error" in result) return c.json({ error: result.error }, result.status as 404 | 409);
    return c.json({ ok: true });
  });

  app.post("/api/cluster/jobs/:id/complete", async (c) => {
    const denied = clusterAdmission(c);
    if (denied) return denied;
    const parsed = parseRemoteComplete(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const result = await jobs.completeRemote(c.req.param("id"), parsed.leaseToken, parsed.sidecarPath, parsed.output);
    if ("cancelled" in result) return c.json({ cancelled: true }, 409);
    if ("error" in result) return c.json({ error: result.error }, result.status as 404 | 409);
    return c.json({ ok: true });
  });

  app.post("/api/cluster/jobs/:id/fail", async (c) => {
    const denied = clusterAdmission(c);
    if (denied) return denied;
    const parsed = parseRemoteFail(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const result = jobs.failRemote(c.req.param("id"), parsed.leaseToken, parsed.error);
    if ("cancelled" in result) return c.json({ cancelled: true }, 409);
    if ("error" in result) return c.json({ error: result.error }, result.status as 404 | 409);
    return c.json({ ok: true });
  });

  app.get("/api/settings", (c) => {
    const settings = store.getSettings();
    const thisNodeId = store.localNodeId();
    return c.json({
      ...settings,
      defaultEncodeNodeId: resolvedDefaultEncodeNodeId(thisNodeId),
      hasWebhookToken: Boolean(store.webhookTokenHash()),
      hasWidgetKey: Boolean(store.widgetKeyHash()),
      hasClusterToken: Boolean(store.clusterTokenHash()),
      username: store.onlyUser()?.username ?? "",
      instances: publicInstances(),
      firstRun: firstRunState(),
      profilePreviews: profilePreviews(settings.sizeCaps),
      thisNodeId,
    });
  });

  app.post("/api/settings/profiles/sync", async (c) => {
    const settings = store.getSettings();
    const results = [];
    for (const inst of store.listInstances()) {
      if (!inst.enabled || (inst.kind !== "radarr" && inst.kind !== "sonarr")) continue;
      const full = store.getInstance(inst.id);
      if (!full?.secret) continue;
      results.push(await syncProfiles({
        instanceId: inst.id,
        kind: inst.kind,
        url: inst.url,
        apiKey: decryptSecret(secret, full.secret),
        caps: settings.sizeCaps,
        fetch: httpFetch,
      }));
    }
    return c.json({ results });
  });

  app.put("/api/settings", async (c) => {
    const body: unknown = await c.req.json();
    const current = store.getSettings();
    const parsed = updateSettings(current, body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const next = parsed.settings;
    const knownRoots = store.listLibraryRoots();
    const guardedPaths = [...knownRoots, ...store.listItems().map((item) => dirnameOf(item.path))];
    if (next.reviewPath && unsafeReviewPath(next.reviewPath, guardedPaths)) {
      return c.json({ error: "The review folder cannot sit inside an Arr library folder." }, 400);
    }
    if (next.defaultEncodeNodeId && !store.getNode(next.defaultEncodeNodeId) && next.defaultEncodeNodeId !== store.localNodeId()) {
      return c.json({ error: "That encode node is not registered." }, 400);
    }
    const suggestionsChanged = suggestionSettingsChanged(current, next);
    store.saveSettings(next);
    if (suggestionsChanged) recomputeAllSuggestions();
    return c.json({ ok: true, settings: next, firstRun: firstRunState() });
  });

  app.post("/api/auth/password", async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>();
    const user = store.onlyUser();
    if (!user || !body.username || !body.password) return c.json({ error: "Username and password are required." }, 400);
    const hash = await argon2.hash(body.password, { type: argon2.argon2id });
    store.updateUser(user.id, body.username, hash);
    store.deleteUserSessions(user.id);
    const sid = store.createSession(user.id, SESSION_TTL, opts.clock?.() ?? Date.now());
    setCookie(c, "polisharr", sid, cookieOpts);
    return c.json({ ok: true });
  });

  app.get("/api/integrations", (c) => c.json({ instances: publicInstances() }));

  app.post("/api/integrations", async (c) => {
    const body = await c.req.json<{
      kind?: ArrKind | PlayerKind;
      name?: string;
      url?: string;
      apiKey?: string;
      token?: string;
      enabled?: boolean;
      id?: string;
    }>();
    if (!body.kind || !body.name || !body.url) return c.json({ error: "Kind, name, and URL are required." }, 400);
    if (!["radarr", "sonarr", "plex", "jellyfin"].includes(body.kind)) {
      return c.json({ error: "That integration kind is invalid." }, 400);
    }
    const secretPlain = body.apiKey ?? body.token;
    const id = store.upsertInstance({
      id: body.id,
      kind: body.kind,
      name: body.name,
      url: body.url,
      secret: secretPlain ? encryptSecret(secret, secretPlain) : undefined,
      enabled: body.enabled ?? true,
    });
    return c.json({ ok: true, id, instances: publicInstances() });
  });

  app.delete("/api/integrations/:id", (c) => {
    store.deleteInstance(c.req.param("id"));
    return c.json({ ok: true, instances: publicInstances() });
  });

  app.post("/api/integrations/:id/test", async (c) => {
    const inst = store.getInstance(c.req.param("id"));
    if (!inst) return c.json({ error: "That connection does not exist." }, 404);
    const key = inst.secret ? decryptSecret(secret, inst.secret) : "";
    if (inst.kind === "radarr") {
      const result = await testRadarr({ url: inst.url, apiKey: key }, httpFetch);
      return c.json(result, result.ok ? 200 : 400);
    }
    if (inst.kind === "sonarr") {
      const result = await testSonarr({ url: inst.url, apiKey: key }, httpFetch);
      return c.json(result, result.ok ? 200 : 400);
    }
    if (inst.kind === "plex") {
      const result = await testPlex(inst.url, key, httpFetch);
      return c.json(result, result.ok ? 200 : 400);
    }
    const result = await testJellyfin(inst.url, key, httpFetch);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/api/library/refresh", async (c) => {
    const result = await sync.refresh();
    recomputeAllSuggestions();
    return c.json({ ...result, inspect: store.getInspectState() });
  });

  function afterInspect(itemId: string): Suggestion | null {
    const suggestion = recomputeSuggestion(itemId);
    const item = store.getItem(itemId);
    if (!item || !suggestion || !shouldQueueNewImport({ settings: store.getSettings(), item, suggestion })) {
      return suggestion;
    }
    jobs.enqueue(itemId, suggestion, { writeMode: "sidecar", runNow: false });
    return suggestion;
  }

  function recomputeSuggestion(itemId: string): Suggestion | null {
    const item = store.getItem(itemId);
    const report = store.getInspection(itemId);
    if (!item || !report) return null;
    const settings = store.getSettings();
    const excluded = isExcluded(item);
    const suggestion = buildSuggestion({
      item,
      report,
      settings,
      sizeExempt: item.sizeExempt,
      excluded,
      videoTarget: store.videoTargetForItem(item) ?? settings.videoTarget,
      av1Available: clusterAv1(),
      hardwareAvailable: clusterHardware(),
      audioMix: store.audioMixForItem(item),
    });
    return store.saveSuggestion(itemId, suggestion) ?? null;
  }

  function recomputeAllSuggestions(): void {
    for (const item of store.listItems()) recomputeSuggestion(item.id);
  }

  let lastHardware: HardwareInfo = { backend: "none", cuda: false, vaapi: false, videotoolbox: false, av1: false, reason: null };
  void hardware().then((h) => {
    lastHardware = h;
    recomputeAllSuggestions();
  });

  function clusterNow(): number {
    return opts.clock?.() ?? Date.now();
  }

  function clusterAv1(): boolean {
    const nodes = store.listNodes();
    if (nodes.length === 0) return lastHardware.av1;
    return clusterHasAv1(nodes, clusterNow());
  }

  function clusterHardware(): boolean {
    const nodes = store.listNodes();
    if (nodes.length === 0) return lastHardware.backend !== "none";
    return clusterHasHardware(nodes, clusterNow());
  }

  function isExcluded(item: ReturnType<Store["getItem"]>): boolean {
    if (!item) return false;
    return store.listExclusions().some((rule) => {
      if (rule.kind === "path") return item.path.startsWith(rule.value);
      if (rule.kind === "profile") return item.profile === rule.value;
      if (rule.kind === "tag") return item.tags.includes(rule.value);
      return item.title === rule.value || item.showTitle === rule.value;
    });
  }

  app.get("/api/library/movies", (c) => {
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    const requestedSort = c.req.query("sort");
    const sort = requestedSort === "size" || requestedSort === "quality" ? requestedSort : "title";
    return c.json(library.movies(offset, limit, sort));
  });
  app.get("/api/library/series", (c) => {
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    return c.json(library.series(offset, limit));
  });
  app.get("/api/library/series/:instanceId/:seriesId/episodes", (c) => {
    const seriesId = Number(c.req.param("seriesId"));
    if (!Number.isSafeInteger(seriesId) || seriesId < 0) {
      return c.json({ error: "That series id is invalid." }, 400);
    }
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    return c.json(library.episodes(c.req.param("instanceId"), seriesId, offset, limit));
  });
  app.get("/api/inspect/status", (c) => {
    if (inspections.leftoverCount() > 0) void inspections.inspectPending();
    return c.json(store.getInspectState());
  });
  app.get("/api/errors", (c) => {
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    return c.json(store.errorPage(offset, limit));
  });

  app.post("/api/library/items/:id/force", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const settings = store.getSettings();
    const suggestion = buildSuggestion({
      item,
      report,
      settings,
      sizeExempt: false,
      excluded: false,
      forceTranscode: true,
      videoTarget: store.videoTargetForItem(item) ?? settings.videoTarget,
      av1Available: clusterAv1(),
      hardwareAvailable: clusterHardware(),
    });
    if (!suggestion) return c.json({ error: "Force did not create work for this title." }, 400);
    const saved = store.saveSuggestion(item.id, suggestion);
    return c.json({ ok: true, onSuggestions: true, suggestion: saved });
  });

  app.post("/api/library/items/:id/stereo", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    if (report.audio.some((t) => t.channels <= 2)) {
      return c.json({ error: "This file already has a stereo track." }, 400);
    }
    const settings = store.getSettings();
    const suggestion = buildSuggestion({
      item,
      report,
      settings,
      sizeExempt: item.sizeExempt,
      excluded: false,
      forceStereo: true,
      videoTarget: store.videoTargetForItem(item) ?? settings.videoTarget,
      av1Available: clusterAv1(),
      hardwareAvailable: clusterHardware(),
    });
    if (!suggestion?.actions.includes("add_stereo")) {
      return c.json({ error: "Add stereo did not change the plan." }, 400);
    }
    return c.json({ ok: true, onSuggestions: true, suggestion: store.saveSuggestion(item.id, suggestion) });
  });

  app.post("/api/library/items/:id/exempt", async (c) => {
    const body = await c.req.json<{ exempt?: boolean }>();
    store.setExempt(c.req.param("id"), Boolean(body.exempt));
    recomputeSuggestion(c.req.param("id"));
    return c.json({ ok: true, item: library.item(c.req.param("id"))! });
  });

  app.post("/api/library/items/:id/video-target", async (c) => {
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    if (item.type !== "movie") {
      return c.json({ error: "Set encode target on the series header for TV." }, 400);
    }
    const body: unknown = await c.req.json();
    const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).videoTarget : undefined;
    const target = raw === null || raw === "" ? null : parseVideoTarget(raw);
    if (raw !== null && raw !== "" && !target) return c.json({ error: "Encode target must be HEVC, AV1, or house default." }, 400);
    store.setItemVideoTarget(item.id, target);
    recomputeSuggestion(item.id);
    return c.json({ ok: true, item: library.item(item.id, true)!, ...store.movieHealth() });
  });

  app.post("/api/library/series/:instanceId/:seriesId/video-target", async (c) => {
    const seriesId = Number(c.req.param("seriesId"));
    if (!Number.isSafeInteger(seriesId) || seriesId < 0) return c.json({ error: "That series id is invalid." }, 400);
    const instanceId = c.req.param("instanceId");
    const episodes = store.listItems("episode").filter(
      (episode) => episode.instanceId === instanceId && episode.arrSeriesId === seriesId,
    );
    if (episodes.length === 0) return c.json({ error: "That series is not in the library." }, 404);
    const body: unknown = await c.req.json();
    const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).videoTarget : undefined;
    const target = raw === null || raw === "" ? null : parseVideoTarget(raw);
    if (raw !== null && raw !== "" && !target) return c.json({ error: "Encode target must be HEVC, AV1, or house default." }, 400);
    store.setSeriesVideoTarget(instanceId, seriesId, target);
    for (const episode of episodes) recomputeSuggestion(episode.id);
    return c.json({ ok: true, videoTarget: target, ...store.seriesHealth(instanceId, seriesId) });
  });

  app.post("/api/library/series/:instanceId/:seriesId/audio-mix", async (c) => {
    const seriesId = Number(c.req.param("seriesId"));
    if (!Number.isSafeInteger(seriesId) || seriesId < 0) return c.json({ error: "That series id is invalid." }, 400);
    const instanceId = c.req.param("instanceId");
    const episodes = store.listItems("episode").filter(
      (episode) => episode.instanceId === instanceId && episode.arrSeriesId === seriesId,
    );
    if (episodes.length === 0) return c.json({ error: "That series is not in the library." }, 404);
    const body: unknown = await c.req.json();
    const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).audioMix : undefined;
    const mix = raw === null || raw === "" ? null : parseAudioMix(raw);
    if (raw !== null && raw !== "" && !mix) return c.json({ error: "Audio mix must be stereo, surround, or house default." }, 400);
    store.setSeriesAudioMix(instanceId, seriesId, mix);
    for (const episode of episodes) recomputeSuggestion(episode.id);
    return c.json({ ok: true, audioMix: mix, ...store.seriesHealth(instanceId, seriesId) });
  });

  app.get("/api/library/items/:id", async (c) => {
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    return c.json({
      item: library.item(item.id, true),
      hardware: lastHardware,
      av1Available: clusterAv1(),
      settings: {
        writeMode: store.getSettings().writeMode,
        videoTarget: store.getSettings().videoTarget,
        preferredLanguage: store.getSettings().preferredLanguage,
      },
      languageId: { available: Boolean(opts.runLanguageLid || opts.env.whisperLid) },
      pgsOcr: { available: Boolean(opts.runPgsOcr || opts.env.pgsOcr) },
    });
  });

  app.post("/api/library/items/:id/plan", async (c) => {
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const body = await c.req.json<{ draft?: CustomPlanDraft }>();
    const result = validateCustomPlan({
      item,
      report,
      settings: store.getSettings(),
      hardware: lastHardware,
      draft: body.draft ?? {},
      av1Available: clusterAv1(),
    });
    if (!result.ok) return c.json({ ok: false, errors: result.errors }, 400);
    return c.json({ ok: true, plan: result.plan });
  });

  app.post("/api/library/items/:id/queue", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const body = await c.req.json<{ draft?: CustomPlanDraft; runNow?: boolean; assignedNodeId?: string }>();
    const result = validateCustomPlan({
      item,
      report,
      settings: store.getSettings(),
      hardware: lastHardware,
      draft: body.draft ?? {},
      av1Available: clusterAv1(),
    });
    if (!result.ok) return c.json({ ok: false, errors: result.errors }, 400);
    const queued = jobs.enqueueCustom(item.id, result.plan, {
      runNow: Boolean(body.runNow),
      assignedNodeId: typeof body.assignedNodeId === "string" ? body.assignedNodeId : undefined,
    });
    if ("error" in queued) return c.json({ error: queued.error }, queued.status as 400 | 404 | 409);
    return c.json({ ok: true, id: queued.id, plan: result.plan });
  });

  app.post("/api/library/items/:id/search-preferred", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({} as { confirm?: boolean }));
    if (body.confirm !== true) {
      return c.json({ error: "Confirm that Radarr or Sonarr should remove this file and search again." }, 400);
    }
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    if (store.activeJobForItem(item.id) || store.pendingReviewForItem(item.id)) {
      return c.json({ error: "Finish or cancel the current work on this title first." }, 409);
    }
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const languageSearch = soleNonPreferredAudio(report.audio, store.getSettings().preferredLanguage);
    const doviP5Search = isDolbyVisionProfile5(report);
    if (!languageSearch && !doviP5Search) {
      return c.json({ error: "This title does not need a Radarr or Sonarr search." }, 400);
    }
    const inst = store.getInstance(item.instanceId);
    if (!inst || (inst.kind !== "radarr" && inst.kind !== "sonarr") || !inst.secret) {
      return c.json({ error: "This title has no Radarr or Sonarr connection to search with." }, 400);
    }
    const result = await deleteArrFileAndSearch({
      kind: inst.kind,
      url: inst.url,
      apiKey: decryptSecret(secret, inst.secret),
      arrId: item.arrId,
      episodeFileId: item.arrEpisodeFileId,
    }, httpFetch);
    if (!result.ok) return c.json({ error: result.error }, 502);
    store.addHistory(item.id, "searched", 0);
    store.saveSuggestion(item.id, null);
    store.deleteLibraryItem(item.id);
    return c.json({ ok: true });
  });

  const extractLanguageClip = opts.extractLanguageClip ?? (async (args: string[]) => {
    await execFileAsync(opts.env.ffmpeg, args, { timeout: 120_000, env: toolLocaleEnv() });
  });
  const runLanguageLid = opts.runLanguageLid ?? (async (clipPath: string) => {
    if (!opts.env.whisperLid) throw new Error("Language identification is not installed.");
    const { stdout } = await execFileAsync(opts.env.whisperLid, [clipPath], {
      timeout: 120_000,
      maxBuffer: 64 * 1024,
      env: languageLidProcessEnv(toolLocaleEnv(), opts.env.configDir),
    });
    return stdout;
  });
  const whisperAvailable = Boolean(opts.runLanguageLid || opts.env.whisperLid);

  app.post("/api/library/items/:id/detect-language", async (c) => {
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const body = await c.req.json<{ trackIndex?: number; startSec?: number }>().catch(() => ({} as { trackIndex?: number; startSec?: number }));
    const trackIndex = body.trackIndex;
    if (typeof trackIndex !== "number" || !Number.isSafeInteger(trackIndex)) {
      return c.json({ error: "Pick an audio track to identify." }, 400);
    }
    const input = isIsoPath(item.path)
      ? isoRemuxInputs(item.path, report)[0] ?? ["-i", item.path]
      : ["-i", item.path];
    const result = await detectLanguageClip({
      report,
      trackIndex,
      startSec: typeof body.startSec === "number" ? body.startSec : undefined,
      input,
      whisperAvailable,
      extract: extractLanguageClip,
      runLid: runLanguageLid,
    });
    if (!result.ok) {
      if (result.status === 200) return c.json(result);
      const status = result.status === 501 ? 501 : 502;
      return c.json({ error: result.reason, ...result }, status);
    }
    return c.json(result);
  });

  app.post("/api/library/items/:id/apply-language", async (c) => {
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const body = await c.req.json<{ trackIndex?: number; language?: string; probability?: number }>().catch(
      () => ({} as { trackIndex?: number; language?: string; probability?: number }),
    );
    const trackIndex = body.trackIndex;
    if (typeof trackIndex !== "number" || !Number.isSafeInteger(trackIndex) || typeof body.language !== "string") {
      return c.json({ error: "Confirm the language for this soundtrack." }, 400);
    }
    if (typeof body.probability !== "number" || body.probability < LID_MIN_PROBABILITY) {
      return c.json({ error: "That sample was not confident enough to save." }, 400);
    }
    const next = applyLanguageToReport(report, trackIndex, body.language);
    if ("error" in next) return c.json({ error: next.error }, 400);
    store.saveInspection(item.id, next);
    recomputeSuggestion(item.id);
    const language = next.audio.find((track) => track.index === trackIndex)?.language ?? body.language;
    return c.json({
      ok: true,
      language,
      languageName: languageDisplayName(language),
      item: library.item(item.id, true),
    });
  });

  const extractSubtitleSample = opts.extractSubtitleSample ?? (async (args: string[]) => {
    await execFileAsync(opts.env.ffmpeg, args, { timeout: 120_000, env: toolLocaleEnv() });
    const dest = args.at(-1);
    if (!dest) throw new Error("ffmpeg could not extract subtitle text from this track.");
    return readFile(dest, "utf8");
  });
  const extractSubtitleSup = opts.extractSubtitleSup ?? (async (args: string[]) => {
    await execFileAsync(opts.env.ffmpeg, args, { timeout: 120_000, env: toolLocaleEnv() });
  });
  const runPgsOcr = opts.runPgsOcr ?? (async (supPath: string) => {
    if (!opts.env.pgsOcr) throw new Error("PGS language identification is not installed.");
    const { stdout } = await execFileAsync(opts.env.pgsOcr, [supPath], {
      timeout: 120_000,
      maxBuffer: 256 * 1024,
      env: toolLocaleEnv(),
    });
    return stdout;
  });
  const pgsOcrAvailable = Boolean(opts.runPgsOcr || opts.env.pgsOcr);

  app.post("/api/library/items/:id/detect-subtitle-language", async (c) => {
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const body = await c.req.json<{ trackIndex?: number; startSec?: number }>().catch(() => ({} as { trackIndex?: number; startSec?: number }));
    const trackIndex = body.trackIndex;
    if (typeof trackIndex !== "number" || !Number.isSafeInteger(trackIndex)) {
      return c.json({ error: "Pick a subtitle track to identify." }, 400);
    }
    const input = isIsoPath(item.path)
      ? isoRemuxInputs(item.path, report)[0] ?? ["-i", item.path]
      : ["-i", item.path];
    const result = await detectSubtitleLanguageSample({
      report,
      trackIndex,
      startSec: typeof body.startSec === "number" ? body.startSec : undefined,
      input,
      extract: extractSubtitleSample,
      extractSup: extractSubtitleSup,
      ocrPgs: runPgsOcr,
      pgsOcrAvailable,
    });
    if (!result.ok) {
      if (result.status === 200) return c.json(result);
      const status = result.status === 400 ? 400 : result.status === 501 ? 501 : 502;
      return c.json({ error: result.reason, ...result }, status);
    }
    return c.json(result);
  });

  app.post("/api/library/items/:id/apply-subtitle-language", async (c) => {
    const item = store.getItem(c.req.param("id"));
    if (!item) return c.json({ error: "That title is not in the library." }, 404);
    const report = store.getInspection(item.id);
    if (!report) return c.json({ error: "This file has not been inspected yet, or the path is unreadable." }, 400);
    const body = await c.req.json<{ trackIndex?: number; language?: string; probability?: number }>().catch(
      () => ({} as { trackIndex?: number; language?: string; probability?: number }),
    );
    const trackIndex = body.trackIndex;
    if (typeof trackIndex !== "number" || !Number.isSafeInteger(trackIndex) || typeof body.language !== "string") {
      return c.json({ error: "Confirm the language for this subtitle track." }, 400);
    }
    if (typeof body.probability !== "number" || body.probability < LID_MIN_PROBABILITY) {
      return c.json({ error: "That sample was not confident enough to save." }, 400);
    }
    const next = applySubtitleLanguageToReport(report, trackIndex, body.language);
    if ("error" in next) return c.json({ error: next.error }, 400);
    store.saveInspection(item.id, next);
    recomputeSuggestion(item.id);
    const language = next.subtitles.find((track) => track.index === trackIndex)?.language ?? body.language;
    return c.json({
      ok: true,
      language,
      languageName: languageDisplayName(language),
      item: library.item(item.id, true),
    });
  });

  app.post("/api/library/series/:instanceId/:seriesId/optimize", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const seriesId = Number(c.req.param("seriesId"));
    if (!Number.isSafeInteger(seriesId) || seriesId < 0) return c.json({ error: "That series id is invalid." }, 400);
    const episodes = store.listItems("episode").filter(
      (episode) => episode.instanceId === c.req.param("instanceId") && episode.arrSeriesId === seriesId,
    );
    const body = await c.req.json<{ assignedNodeId?: string }>().catch(() => ({} as { assignedNodeId?: string }));
    const assignedNodeId = typeof body.assignedNodeId === "string" ? body.assignedNodeId : undefined;
    let queued = 0;
    let skipped = 0;
    for (const ep of episodes) {
      const suggestion = store.openSuggestionForItem(ep.id);
      if (!suggestion || store.pendingReviewForItem(ep.id) || store.activeJobForItem(ep.id)) {
        skipped += 1;
        continue;
      }
      const result = jobs.enqueue(ep.id, suggestion, { assignedNodeId });
      if ("id" in result) queued += 1;
      else skipped += 1;
    }
    return c.json({ queued, skipped });
  });

  app.get("/api/suggestions", (c) => {
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    const parsed = suggestionFiltersFromQuery((name) => c.req.query(name));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    return c.json(store.suggestionPage(offset, limit, c.req.query("q") ?? "", parsed.filters));
  });

  app.post("/api/suggestions/queue-filtered", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "The filtered queue request is invalid." }, 400);
    const raw = body as Record<string, unknown>;
    const parsed = parseSuggestionFilters(raw.filters);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (raw.q !== undefined && typeof raw.q !== "string") return c.json({ error: "The suggestion search is invalid." }, 400);
    let queued = 0;
    let skipped = 0;
    for (const id of store.suggestionIds(typeof raw.q === "string" ? raw.q : "", parsed.filters)) {
      const suggestion = store.getSuggestion(id);
      if (!suggestion || suggestion.dismissed) {
        skipped += 1;
        continue;
      }
      const result = jobs.enqueue(suggestion.itemId, suggestion, {
        assignedNodeId: typeof raw.assignedNodeId === "string" ? raw.assignedNodeId : undefined,
      });
      if ("id" in result) queued += 1;
      else skipped += 1;
    }
    return c.json({ queued, skipped });
  });

  app.post("/api/suggestions/:id/dismiss", (c) => {
    if (!store.getSuggestion(c.req.param("id"))) return c.json({ error: "That suggestion does not exist." }, 404);
    store.dismissSuggestion(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/exclusions", (c) => c.json({ exclusions: store.listExclusions() }));

  app.post("/api/exclusions", async (c) => {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "An exclusion kind and value are required." }, 400);
    const raw = body as Record<string, unknown>;
    if (raw.kind !== "path" && raw.kind !== "profile" && raw.kind !== "tag" && raw.kind !== "title") {
      return c.json({ error: "That exclusion kind is invalid." }, 400);
    }
    if (typeof raw.value !== "string" || !raw.value.trim()) return c.json({ error: "Enter a value to exclude." }, 400);
    const id = store.addExclusion(raw.kind, raw.value.trim());
    recomputeAllSuggestions();
    return c.json({ ok: true, id, exclusions: store.listExclusions() });
  });

  app.delete("/api/exclusions/:id", (c) => {
    if (!store.listExclusions().some((rule) => rule.id === c.req.param("id"))) {
      return c.json({ error: "That exclusion does not exist." }, 404);
    }
    store.deleteExclusion(c.req.param("id"));
    recomputeAllSuggestions();
    return c.json({ ok: true, exclusions: store.listExclusions() });
  });

  app.post("/api/queue", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const body = await c.req.json<{ suggestionId?: string; itemId?: string; runNow?: boolean; assignedNodeId?: string }>();
    const suggestion = body.suggestionId ? store.getSuggestion(body.suggestionId) : body.itemId ? store.openSuggestionForItem(body.itemId) : undefined;
    if (!suggestion || suggestion.dismissed) return c.json({ error: "There is no open suggestion to queue." }, 400);
    const result = jobs.enqueue(suggestion.itemId, suggestion, {
      runNow: Boolean(body.runNow),
      assignedNodeId: typeof body.assignedNodeId === "string" ? body.assignedNodeId : undefined,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
    return c.json({ ok: true, id: result.id });
  });

  app.get("/api/jobs", (c) => {
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    const page = store.jobPage(offset, limit);
    return c.json({ ...page, items: page.items.map((job) => publicJob(job)) });
  });

  app.post("/api/jobs/:id/assign", async (c) => {
    const body = await readJson(c);
    const nodeId = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).nodeId === "string"
      ? (body as Record<string, unknown>).nodeId as string
      : "";
    if (!nodeId) return c.json({ error: "Pick an encode node." }, 400);
    const result = jobs.reassign(c.req.param("id"), nodeId);
    if ("error" in result) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
    return c.json({ ok: true });
  });

  app.post("/api/jobs/cancel-all", (c) => {
    const result = jobs.cancelAll();
    return c.json({ ok: true, cancelled: result.cancelled });
  });

  app.delete("/api/jobs/finished", (c) => {
    const result = jobs.clearFinished();
    return c.json({ ok: true, removed: result.removed });
  });

  app.delete("/api/jobs/:id", (c) => {
    const result = jobs.remove(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status as 404 | 409);
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:id/cancel", (c) => {
    const result = jobs.cancel(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:id/run-now", (c) => {
    const job = store.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "That job does not exist." }, 404);
    if (job.status !== "queued" && job.status !== "held" && job.status !== "paused") {
      return c.json({ error: "Only waiting jobs can run now." }, 409);
    }
    store.updateJob(job.id, { runNow: true, status: "queued", phase: "queued" });
    return c.json({ ok: true });
  });

  app.post("/api/jobs/reorder", async (c) => {
    const body = await c.req.json<{ ids?: string[] }>();
    (body.ids ?? []).forEach((id, index) => store.updateJob(id, { position: index + 1 }));
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:id/pause", (c) => {
    const job = store.getJob(c.req.param("id"));
    if (!job || (job.status !== "queued" && job.status !== "held")) return c.json({ error: "Only waiting jobs can be paused." }, 409);
    store.updateJob(job.id, { status: "paused", phase: "paused" });
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:id/resume", (c) => {
    const job = store.getJob(c.req.param("id"));
    if (!job || job.status !== "paused") return c.json({ error: "Only paused jobs can resume." }, 409);
    store.updateJob(job.id, { status: "queued", phase: "queued" });
    return c.json({ ok: true });
  });

  app.get("/api/jobs/:id/logs", (c) => {
    const log = store.jobLog(c.req.param("id"));
    if (log == null) return c.json({ error: "That job does not exist." }, 404);
    return c.json({ log });
  });

  app.get("/api/review", (c) => {
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    return c.json(store.reviewPage(offset, limit));
  });

  app.post("/api/review/:id/keep", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const result = await jobs.keep(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/review/keep-selected", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const body = await c.req.json<{ ids?: string[] }>();
    let accepted = 0;
    let skipped = 0;
    for (const id of body.ids ?? []) {
      const result = await jobs.keep(id);
      if ("accepted" in result) accepted += 1;
      else skipped += 1;
    }
    return c.json({ accepted, skipped }, 202);
  });

  app.post("/api/review/keep-all", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const result = await jobs.keepPending();
    return c.json(result, 202);
  });

  app.post("/api/review/:id/discard", async (c) => {
    const result = await jobs.discard(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/review/:id/requeue", async (c) => {
    const blocked = gateOptimize();
    if (blocked) return c.json({ error: blocked }, 403);
    const result = await jobs.requeueFlagged(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
    return c.json({ ok: true, id: result.id });
  });

  app.get("/api/history", (c) => {
    const { offset, limit } = pageRequest(c.req.query("offset"), c.req.query("limit"));
    return c.json(store.historyPage(offset, limit));
  });

  app.get("/api/work", (c) => {
    const work = store.workSummary();
    return c.json({
      queued: work.queued,
      queueActive: work.queueActive,
      review: work.review,
      runningTitle: work.running?.displayTitle ?? null,
    });
  });

  app.get("/api/home", (c) => {
    const sav = store.savings();
    const work = store.workSummary();
    return c.json({
      filesOptimized: sav.filesOptimized,
      spaceSavedBytes: sav.spaceSavedBytes,
      suggestions: work.suggestions,
      queued: work.queued,
      queueActive: work.queueActive,
      review: work.review,
      errors: work.errors,
      recent: store.historyPage(0, 8).items,
      status: homeStatus(work),
    });
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const hits = store
      .listItems()
      .filter((item) => matchesTitleSearch(q, item))
      .slice(0, 20)
      .map((item) => ({
        itemId: item.id,
        type: item.type,
        displayTitle: displayTitle(item),
        instanceName: item.instanceName,
        href: item.type === "movie" ? `/movies/${item.id}` : `/series/episodes/${item.id}`,
      }));
    return c.json({ items: hits });
  });

  app.post("/api/settings/widget-key", (c) => {
    const raw = randomBytes(24).toString("hex");
    store.setWidgetKeyHash(createHash("sha256").update(raw).digest("hex"));
    return c.json({ key: raw });
  });

  app.post("/api/settings/webhook-token", (c) => {
    const raw = randomBytes(24).toString("hex");
    store.setWebhookTokenHash(createHash("sha256").update(raw).digest("hex"));
    return c.json({ token: raw, url: "/api/hooks/arr" });
  });

  app.post("/api/settings/cluster-token", (c) => {
    const raw = randomBytes(24).toString("hex");
    store.setClusterTokenHash(createHash("sha256").update(raw).digest("hex"));
    return c.json({ token: raw });
  });

  app.post("/api/hooks/arr", async (c) => {
    const presented = presentedWebhookToken({
      apiKey: c.req.header("x-api-key") ?? undefined,
      authorization: c.req.header("authorization") ?? undefined,
      queryKey: c.req.query("apikey") ?? undefined,
    });
    if (!webhookTokenMatches(presented, store.webhookTokenHash())) {
      return c.json({ error: "The webhook token is wrong." }, 401);
    }
    let payload: unknown = {};
    try {
      payload = await c.req.json();
    } catch {
      payload = {};
    }
    const event = parseArrWebhook(payload);
    if (event.syncsLibrary) {
      void sync.notifyFromWebhook(payload).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`The Arr webhook could not refresh the library because ${message}`);
      });
    }
    return c.json({ ok: true });
  });

  const widget = async (c: Context) => {
    const settings = store.getSettings();
    const ip = requestAddress(clientAddress(c), c.req.header("x-forwarded-for"), opts.env.trustProxy);
    const presented = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const envKey = opts.env.widgetKeyEnv;
    const hash = store.widgetKeyHash();
    const keyOk =
      (envKey && presented === envKey) ||
      (hash && presented && createHash("sha256").update(presented).digest("hex") === hash);
    if (!keyOk && !(settings.localAuthBypass && isLocalAddress(ip))) {
      return c.json({ error: "A widget key is required." }, 401);
    }
    const work = store.workSummary();
    return c.json({
      status: homeStatus(work),
      queued: work.queued,
      review: work.review,
      suggestions: work.suggestions,
      failed: work.failed,
      runningTitle: work.running?.displayTitle ?? null,
      runningPhase: work.running?.phase ?? null,
      runningProgress: work.running?.progress ?? null,
    });
  };

  app.get("/api/widget", widget);
  app.get("/api/homepage", widget);

  app.get("/api/library/:id/poster", async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: "Sign in to continue." }, 401);
    const item = store.getItem(c.req.param("id"));
    if (!item?.posterRemoteUrl) return c.body(null, 404);
    const inst = store.getInstance(item.instanceId);
    if (!inst?.secret) return c.body(null, 404);
    let posterUrl: URL;
    let arrOrigin: string;
    try {
      posterUrl = new URL(item.posterRemoteUrl, `${trimUrl(inst.url)}/`);
      arrOrigin = new URL(inst.url).origin;
    } catch {
      return c.body(null, 404);
    }
    const headers = posterUrl.origin === arrOrigin ? { "X-Api-Key": decryptSecret(secret, inst.secret) } : undefined;
    const res = await httpFetch(posterUrl, { headers });
    if (!res.ok) return c.body(null, 404);
    return new Response(res.body, { headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  });

  if (opts.env.webRoot && existsSync(opts.env.webRoot)) {
    app.use("/*", serveStatic({ root: opts.env.webRoot }));
    app.get("*", serveStatic({ path: join(opts.env.webRoot, "index.html") }));
  }

  function publicInstances() {
    return store.listInstances().map((i) => {
      const full = store.getInstance(i.id)!;
      const base = { id: full.id, kind: full.kind, name: full.name, url: full.url, enabled: full.enabled };
      if (full.kind === "radarr" || full.kind === "sonarr") return { ...base, hasApiKey: Boolean(full.secret) };
      return { ...base, hasToken: Boolean(full.secret) };
    });
  }

  if (!isWorker) {
    sync.start();
    void inspections.inspectPending();
  }
  function resolvedDefaultEncodeNodeId(thisNodeId: string): string {
    const stored = store.getSettings().defaultEncodeNodeId;
    if (stored && (store.getNode(stored) || stored === thisNodeId)) return stored;
    return thisNodeId;
  }

  function publicNode(node: ClusterNode, thisNodeId: string) {
    const now = opts.clock?.() ?? Date.now();
    return {
      ...node,
      thisNode: node.id === thisNodeId,
      hardwareLabel: nodeHardwareLabel(node.hardware),
      roleLabel: nodeRoleLabel(node.role, node.id === thisNodeId),
      online: nodeIsOnline(node.lastSeen, now),
    };
  }

  function nodesPayload(thisNodeId: string) {
    const nodes = store.listNodes().map((node) => publicNode(node, thisNodeId));
    return {
      thisNodeId,
      defaultEncodeNodeId: resolvedDefaultEncodeNodeId(thisNodeId),
      av1Available: clusterAv1(),
      nodes,
    };
  }

  async function refreshLocalNode(): Promise<ClusterNode> {
    const running = store.listJobs().find((job) => job.status === "running" && job.nodeId === store.localNodeId());
    const id = store.localNodeId();
    const existing = store.getNode(id);
    const node: ClusterNode = {
      id,
      name: opts.env.nodeName || localHostname(),
      role: opts.env.role,
      lastSeen: clusterNow(),
      hardware: await hardware(),
      concurrency: existing?.concurrency ?? Math.max(1, store.getSettings().concurrency),
      enabled: existing?.enabled ?? true,
      version,
      currentJobId: running?.id ?? null,
    };
    store.upsertNode(node);
    return node;
  }

  if (isWorker) workerLoop.start();
  else void refreshLocalNode();

  function publicJob<T extends { assignedNodeId?: string | null; status: string }>(job: T) {
    const node = job.assignedNodeId ? store.getNode(job.assignedNodeId) : undefined;
    const now = opts.clock?.() ?? Date.now();
    const waiting = (job.status === "queued" || job.status === "held") && node && !nodeIsOnline(node.lastSeen, now);
    return {
      ...job,
      assignedNodeName: node?.name ?? null,
      waitingForNode: Boolean(waiting),
    };
  }

  function homeStatus(work: ReturnType<Store["workSummary"]>): string {
    if (work.running) {
      const node = work.running.assignedNodeId ? store.getNode(work.running.assignedNodeId) : undefined;
      if (node && store.listNodes().length > 1) return `Encoding ${work.running.displayTitle} on ${node.name}`;
      return `Working · ${work.running.displayTitle}`;
    }
    if (work.queued) {
      const waiting = store.listJobs().find((job) => {
        if (job.status !== "queued" && job.status !== "held") return false;
        const node = job.assignedNodeId ? store.getNode(job.assignedNodeId) : undefined;
        return Boolean(node && !nodeIsOnline(node.lastSeen, opts.clock?.() ?? Date.now()));
      });
      if (waiting?.assignedNodeId) {
        const node = store.getNode(waiting.assignedNodeId);
        if (node) return `Waiting for ${node.name}`;
      }
      return `${work.queued} waiting`;
    }
    return "Idle";
  }

  function clusterAdmission(c: Context) {
    if (opts.env.role !== "master") return c.json({ error: CLUSTER_NOT_MASTER }, 404);
    const presented = presentedWebhookToken({
      apiKey: c.req.header("x-api-key") ?? undefined,
      authorization: c.req.header("authorization") ?? undefined,
    });
    const envKey = opts.env.clusterTokenEnv;
    const accepted = webhookTokenMatches(presented, store.clusterTokenHash()) || Boolean(envKey && presented === envKey);
    if (!accepted) return c.json({ error: CLUSTER_WRONG_TOKEN }, 401);
    return null;
  }

  return { app, store, jobs, sync, inspectPending: inspections.inspectPending, secret, workerLoop };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function localHostname(): string {
  try {
    return hostname().trim() || "polisharr";
  } catch {
    return "polisharr";
  }
}

function unsafeReviewPath(reviewPath: string, libraryRoots: string[]): boolean {
  return libraryRoots.some((path) => path.length > 0 && pathsOverlap(reviewPath, path));
}

function dirnameOf(path: string): string {
  return path.replace(/\/[^/]+$/, "") || "/";
}

function suggestionSettingsChanged(current: Settings, next: Settings): boolean {
  return (
    current.preferredLanguage !== next.preferredLanguage ||
    current.videoTarget !== next.videoTarget ||
    JSON.stringify(current.sizeCaps) !== JSON.stringify(next.sizeCaps) ||
    JSON.stringify(current.suggestionDefaults) !== JSON.stringify(next.suggestionDefaults)
  );
}

function pageRequest(rawOffset: string | undefined, rawLimit: string | undefined): { offset: number; limit: number } {
  const parsedOffset = Number(rawOffset ?? 0);
  const parsedLimit = Number(rawLimit ?? 50);
  return {
    offset: Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
    limit: Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50,
  };
}

function suggestionFiltersFromQuery(query: (name: string) => string | undefined) {
  const booleanValue = (name: string): boolean | undefined | "invalid" => {
    const value = query(name);
    if (value === undefined || value === "") return undefined;
    if (value === "true") return true;
    if (value === "false") return false;
    return "invalid";
  };
  const raw: Record<string, unknown> = {
    type: query("type"),
    resolution: query("resolution"),
    hdr: query("hdr"),
    codec: query("codec"),
  };
  for (const name of ["overCap", "extraTracks", "exempt", "hardwareWarning"] as const) {
    const value = booleanValue(name);
    if (value === "invalid") return { ok: false as const, error: `The ${name} suggestion filter is invalid.` };
    if (value !== undefined) raw[name] = value;
  }
  return parseSuggestionFilters(raw);
}
