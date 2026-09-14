import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { displayTitle } from "./titles.ts";
import type { Store } from "./store.ts";
import {
  PLAYBACK_OCCURRENCE_MISS_POLLS,
  PLAYBACK_POLL_MS,
  PLAYBACK_STALE_MS,
  type PlaybackConnectionHealth,
  type PlaybackConnectionSettings,
  type PlaybackCredentialKind,
  type PlaybackFileRevision,
  type PlaybackHealthStatus,
  type PlaybackMatchOutcome,
  type PlaybackOccurrence,
  type LibraryItem,
} from "./types.ts";
import {
  createJellyfinPlayback,
  describePlaybackObservation,
  revisionCacheKey,
  sessionHasCurrentItem,
  transcodeReasonFamily,
  verifiedSessionPath,
  type JellyfinParsedSession,
  type JellyfinPlaybackClient,
  type JellyfinSessionSnapshot,
} from "./jellyfin-playback.ts";

export type PlaybackCoverage = {
  connections: PlaybackConnectionHealth[];
};

export type PlaybackMonitor = {
  start(): void;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  coverage(): PlaybackCoverage;
  forgetConnection(connectionId: string): void;
};

export type PlaybackMonitorOptions = {
  store: Store;
  fetch: typeof fetch;
  decrypt: (packed: string) => string;
  clock?: () => number;
  pollMs?: number;
  staleMs?: number;
  playback?: JellyfinPlaybackClient;
  statFile?: (path: string) => Promise<PlaybackFileRevision | null>;
};

type ConnectionLive = {
  health: PlaybackConnectionHealth;
  missCounts: Map<string, number>;
  tokenFingerprint: string | null;
};

export function canonicalMediaPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const slashes = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return slashes || "/";
}

export function mediaPathsEqual(left: string, right: string): boolean {
  const a = canonicalMediaPath(left);
  const b = canonicalMediaPath(right);
  if (!a || !b) return false;
  if (process.platform === "win32" || process.platform === "darwin") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function parsePlaybackSettingsInput(
  body: unknown,
  context: {
    jellyfinIds: string[];
    arrIds: string[];
    nodeIds: string[];
    current: PlaybackConnectionSettings[];
  },
): { ok: true; connections: PlaybackConnectionSettings[] } | { ok: false; error: string } {
  const raw = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!raw) return { ok: false, error: "Playback settings must be a JSON object." };
  if (!("connections" in raw)) return { ok: false, error: "Playback settings must include connections." };
  if (!Array.isArray(raw.connections)) return { ok: false, error: "Playback connections must be a list." };
  const jellyfin = new Set(context.jellyfinIds);
  const arrs = new Set(context.arrIds);
  const nodes = new Set(context.nodeIds);
  const previous = new Map(context.current.map((row) => [row.connectionId, row]));
  const seen = new Set<string>();
  const connections: PlaybackConnectionSettings[] = [];
  for (const entry of raw.connections) {
    const row = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    if (!row || typeof row.connectionId !== "string") return { ok: false, error: "Each playback connection needs an id." };
    if (!jellyfin.has(row.connectionId)) return { ok: false, error: "That Jellyfin connection does not exist." };
    if (seen.has(row.connectionId)) return { ok: false, error: "A Jellyfin connection was listed twice." };
    seen.add(row.connectionId);
    if ("observePlayback" in row && typeof row.observePlayback !== "boolean") {
      return { ok: false, error: "Observe playback must be true or false." };
    }
    if ("retainHistory" in row && typeof row.retainHistory !== "boolean") {
      return { ok: false, error: "Retain history must be true or false." };
    }
    if ("protectNodes" in row && typeof row.protectNodes !== "boolean") {
      return { ok: false, error: "Protect encode nodes must be true or false." };
    }
    if ("protectReplacement" in row && typeof row.protectReplacement !== "boolean") {
      return { ok: false, error: "Protect replacement must be true or false." };
    }
    const stored = previous.get(row.connectionId) ?? {
      connectionId: row.connectionId,
      observePlayback: false,
      retainHistory: true,
      protectNodes: false,
      protectedNodeIds: [] as string[],
      protectReplacement: false,
      coveredArrInstanceIds: context.arrIds,
    };
    let protectedNodeIds = stored.protectedNodeIds;
    if ("protectedNodeIds" in row) {
      const parsedNodes = parseIdList(row.protectedNodeIds, "protected node");
      if (!parsedNodes.ok) return parsedNodes;
      for (const id of parsedNodes.ids) {
        if (!nodes.has(id)) return { ok: false, error: "That encode node is not registered." };
      }
      protectedNodeIds = parsedNodes.ids;
    }
    let coveredArrInstanceIds = stored.coveredArrInstanceIds;
    if ("coveredArrInstanceIds" in row) {
      const covered = parseIdList(row.coveredArrInstanceIds, "Arr instance");
      if (!covered.ok) return covered;
      for (const id of covered.ids) {
        if (!arrs.has(id)) return { ok: false, error: "That Radarr or Sonarr connection does not exist." };
      }
      coveredArrInstanceIds = covered.ids;
    }
    connections.push({
      connectionId: row.connectionId,
      observePlayback: "observePlayback" in row ? row.observePlayback === true : stored.observePlayback,
      retainHistory: "retainHistory" in row ? row.retainHistory === true : stored.retainHistory,
      protectNodes: "protectNodes" in row ? row.protectNodes === true : stored.protectNodes,
      protectedNodeIds,
      protectReplacement: "protectReplacement" in row ? row.protectReplacement === true : stored.protectReplacement,
      coveredArrInstanceIds,
    });
  }
  return { ok: true, connections };
}

export function observationSummary(row: PlaybackOccurrence): string {
  return describePlaybackObservation({
    deviceLabel: row.deviceLabel,
    playMethod: row.playMethod,
    reasons: row.rawReasons,
  });
}

export function createPlaybackMonitor(opts: PlaybackMonitorOptions): PlaybackMonitor {
  const store = opts.store;
  const playback = opts.playback ?? createJellyfinPlayback({ fetch: opts.fetch, clock: opts.clock });
  const now = () => opts.clock?.() ?? Date.now();
  const pollMs = opts.pollMs ?? PLAYBACK_POLL_MS;
  const staleMs = opts.staleMs ?? PLAYBACK_STALE_MS;
  const statFile = opts.statFile ?? statPlaybackRevision;
  const live = new Map<string, ConnectionLive>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | null = null;
  let started = false;

  function healthFor(connectionId: string, settings: PlaybackConnectionSettings | undefined): PlaybackConnectionHealth {
    const existing = live.get(connectionId)?.health;
    if (existing) {
      return {
        ...existing,
        observePlayback: settings?.observePlayback === true,
        stale: isStale(existing, settings, now(), staleMs),
        status: effectiveStatus(existing, settings, now(), staleMs),
      };
    }
    return unknownHealth(connectionId, settings?.observePlayback === true);
  }

  return {
    start() {
      if (started) return;
      started = true;
      store.closeOpenPlaybackOccurrences(null, now(), true);
      live.clear();
      if (pollMs > 0) {
        timer = setInterval(() => void this.refresh(), pollMs);
        timer.unref?.();
      }
    },
    stop() {
      started = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      return inFlight ?? Promise.resolve();
    },
    refresh() {
      if (!started) return inFlight ?? Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = pollAll({
        store,
        playback,
        decrypt: opts.decrypt,
        now: now(),
        live,
        staleMs,
        statFile,
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    coverage() {
      const settings = store.getPlaybackSettings();
      return {
        connections: settings.map((row) => healthFor(row.connectionId, row)),
      };
    },
    forgetConnection(connectionId: string) {
      live.delete(connectionId);
      playback.invalidateSourceCache(connectionId);
    },
  };
}

async function pollAll(input: {
  store: Store;
  playback: JellyfinPlaybackClient;
  decrypt: (packed: string) => string;
  now: number;
  live: Map<string, ConnectionLive>;
  staleMs: number;
  statFile: (path: string) => Promise<PlaybackFileRevision | null>;
}): Promise<void> {
  const settings = input.store.getPlaybackSettings();
  for (const row of settings) {
    if (!row.observePlayback) {
      input.store.closeOpenPlaybackOccurrences(row.connectionId, input.now, true);
      input.live.delete(row.connectionId);
      input.playback.invalidateSourceCache(row.connectionId);
      continue;
    }
    const inst = input.store.getInstance(row.connectionId);
    if (!inst || inst.kind !== "jellyfin" || !inst.secret) {
      writeHealth(input.live, row, {
        status: "error",
        lastError: "That Jellyfin connection has no saved token.",
        complete: false,
        stale: true,
      }, input.now, input.staleMs);
      continue;
    }
    let token: string;
    try {
      token = input.decrypt(inst.secret);
    } catch {
      writeHealth(input.live, row, {
        status: "error",
        lastError: "Polisharr could not read the saved Jellyfin token.",
        complete: false,
        stale: true,
      }, input.now, input.staleMs);
      continue;
    }
    const snapshot = await input.playback.fetchSnapshot({
      url: inst.url,
      token,
      connectionId: row.connectionId,
    });
    const access = await ensureCredential(input.live, row, input.playback, inst.url, token);
    if (!snapshot.complete || snapshot.error) {
      input.store.closeOpenPlaybackOccurrences(row.connectionId, input.now, true);
      const state = input.live.get(row.connectionId);
      if (state) state.missCounts.clear();
      writeHealth(input.live, row, {
        status: snapshot.truncated ? "incomplete" : "error",
        lastError: snapshot.error,
        complete: false,
        stale: true,
        credentialKind: access.credentialKind,
        householdVisible: access.householdVisible,
      }, input.now, input.staleMs);
      continue;
    }
    await applySnapshot({
      store: input.store,
      playback: input.playback,
      settings: row,
      url: inst.url,
      token,
      snapshot,
      now: input.now,
      live: input.live,
      staleMs: input.staleMs,
      statFile: input.statFile,
      access,
    });
  }
  const known = new Set(settings.map((row) => row.connectionId));
  for (const id of [...input.live.keys()]) {
    if (known.has(id)) continue;
    input.live.delete(id);
    input.playback.invalidateSourceCache(id);
  }
}

async function ensureCredential(
  live: Map<string, ConnectionLive>,
  settings: PlaybackConnectionSettings,
  playback: JellyfinPlaybackClient,
  url: string,
  token: string,
): Promise<{ credentialKind: PlaybackCredentialKind; householdVisible: boolean }> {
  const fingerprint = tokenFingerprint(token);
  const existing = live.get(settings.connectionId);
  if (
    existing
    && existing.tokenFingerprint === fingerprint
    && existing.health.credentialKind !== "unknown"
  ) {
    return { credentialKind: existing.health.credentialKind, householdVisible: existing.health.householdVisible };
  }
  const access = await playback.testPlaybackAccess({ url, token, checkSessions: false });
  const state = existing ?? {
    health: unknownHealth(settings.connectionId, settings.observePlayback),
    missCounts: new Map<string, number>(),
    tokenFingerprint: fingerprint,
  };
  state.tokenFingerprint = fingerprint;
  live.set(settings.connectionId, state);
  return { credentialKind: access.credentialKind, householdVisible: access.householdVisible };
}

async function applySnapshot(input: {
  store: Store;
  playback: JellyfinPlaybackClient;
  settings: PlaybackConnectionSettings;
  url: string;
  token: string;
  snapshot: JellyfinSessionSnapshot;
  now: number;
  live: Map<string, ConnectionLive>;
  staleMs: number;
  statFile: (path: string) => Promise<PlaybackFileRevision | null>;
  access: { credentialKind: PlaybackCredentialKind; householdVisible: boolean };
}): Promise<void> {
  const state = input.live.get(input.settings.connectionId) ?? {
    health: unknownHealth(input.settings.connectionId, true),
    missCounts: new Map<string, number>(),
    tokenFingerprint: null,
  };
  const playing = input.snapshot.sessions.filter(sessionHasCurrentItem);
  const seen = new Set<string>();
  for (const session of playing) {
    if (!session.nowPlaying) continue;
    const mediaSourceId = session.playState?.mediaSourceId ?? "";
    const key = occurrenceKey(session.sessionId, session.nowPlaying.itemId, mediaSourceId);
    seen.add(key);
    state.missCounts.delete(key);
    const recorded = await recordOccurrence({
      store: input.store,
      playback: input.playback,
      settings: input.settings,
      url: input.url,
      token: input.token,
      session,
      now: input.now,
      statFile: input.statFile,
    });
    if (recorded && input.settings.retainHistory) {
      input.store.savePlaybackOccurrence(recorded);
    }
  }
  for (const open of input.store.listOpenPlaybackOccurrences(input.settings.connectionId)) {
    const key = occurrenceKey(open.sessionId, open.itemId, open.mediaSourceId);
    if (seen.has(key)) continue;
    const misses = (state.missCounts.get(key) ?? 0) + 1;
    state.missCounts.set(key, misses);
    if (misses >= PLAYBACK_OCCURRENCE_MISS_POLLS) {
      input.store.closePlaybackOccurrence(open.id, input.now, false);
      state.missCounts.delete(key);
    }
  }
  const unavailable = input.access.credentialKind === "userToken";
  const status: PlaybackHealthStatus = unavailable ? "unavailable" : playing.length > 0 ? "playing" : "idle";
  input.live.set(input.settings.connectionId, state);
  writeHealth(input.live, input.settings, {
    status,
    lastError: null,
    complete: true,
    lastSuccessAt: input.now,
    stale: false,
    credentialKind: input.access.credentialKind,
    householdVisible: input.access.householdVisible,
  }, input.now, input.staleMs);
  input.store.prunePlaybackHistory(input.now);
}

async function recordOccurrence(input: {
  store: Store;
  playback: JellyfinPlaybackClient;
  settings: PlaybackConnectionSettings;
  url: string;
  token: string;
  session: JellyfinParsedSession;
  now: number;
  statFile: (path: string) => Promise<PlaybackFileRevision | null>;
}): Promise<PlaybackOccurrence | null> {
  const playing = input.session.nowPlaying;
  if (!playing) return null;
  const mediaSourceId = input.session.playState?.mediaSourceId ?? "";
  const rawReasons = input.session.transcoding?.transcodeReasons ?? [];
  const match = await resolveMatch({
    store: input.store,
    playback: input.playback,
    url: input.url,
    token: input.token,
    connectionId: input.settings.connectionId,
    session: input.session,
    statFile: input.statFile,
  });
  const existing = input.store.openPlaybackOccurrence(
    input.settings.connectionId,
    input.session.sessionId,
    playing.itemId,
    mediaSourceId,
  );
  const itemName = match.libraryItemIds.length
    ? titleForItems(input.store, match.libraryItemIds, playing.name)
    : playing.name;
  const reasons = unique([...existing?.reasons ?? [], ...summariesFor(input.session)]);
  const raw = unique([...existing?.rawReasons ?? [], ...rawReasons]);
  return {
    id: existing?.id ?? randomUUID(),
    connectionId: input.settings.connectionId,
    deviceId: input.session.deviceId,
    deviceLabel: input.session.deviceLabel,
    sessionId: input.session.sessionId,
    itemId: playing.itemId,
    mediaSourceId,
    itemName,
    playMethod: input.session.playState?.playMethod ?? null,
    mediaType: playing.mediaType ?? playing.type,
    isPaused: input.session.playState?.isPaused ?? null,
    reasons,
    rawReasons: raw,
    reasonFamily: transcodeReasonFamily(raw),
    selectedTracks: {
      audioStreamIndex: input.session.playState?.audioStreamIndex ?? null,
      subtitleStreamIndex: input.session.playState?.subtitleStreamIndex ?? null,
    },
    match: match.outcome,
    libraryItemIds: match.libraryItemIds,
    path: match.path,
    revision: match.revision,
    startedAt: existing?.startedAt ?? input.now,
    lastSeenAt: input.now,
    endedAt: null,
    gap: false,
  };
}

async function resolveMatch(input: {
  store: Store;
  playback: JellyfinPlaybackClient;
  url: string;
  token: string;
  connectionId: string;
  session: JellyfinParsedSession;
  statFile: (path: string) => Promise<PlaybackFileRevision | null>;
}): Promise<{
  outcome: PlaybackMatchOutcome;
  libraryItemIds: string[];
  path: string | null;
  revision: PlaybackFileRevision | null;
}> {
  const unmatched = { outcome: "unmatched" as const, libraryItemIds: [] as string[], path: null, revision: null };
  const playing = input.session.nowPlaying;
  if (!playing) return unmatched;
  const liveStream = input.session.playState?.liveStreamId;
  if (liveStream) return { ...unmatched, outcome: "remote" };
  const sourceId = input.session.playState?.mediaSourceId;
  if (!sourceId) {
    if (playing.mediaSources.length > 1) return { ...unmatched, outcome: "ambiguous" };
    return unmatched;
  }
  let path = verifiedSessionPath(input.session);
  if (!path) {
    const revisionProbe = await revisionForPath(input.store, canonicalMediaPath(playing.path ?? ""), input.statFile);
    const resolved = await input.playback.resolveMediaSource({
      url: input.url,
      token: input.token,
      connectionId: input.connectionId,
      itemId: playing.itemId,
      mediaSourceId: sourceId,
      revisionKey: revisionCacheKey(revisionProbe),
    });
    if (resolved.outcome === "remote") return { ...unmatched, outcome: "remote", path: resolved.path };
    if (resolved.outcome === "ambiguous") return { ...unmatched, outcome: "ambiguous" };
    if (resolved.outcome !== "ok" || !resolved.path) return unmatched;
    path = resolved.path;
  }
  const canonical = canonicalMediaPath(path);
  const items = libraryItemsForPath(input.store, path);
  if (items.length === 0) return { ...unmatched, path: canonical || path };
  const revision = await input.statFile(items[0]!.path) ?? {
    canonicalPath: canonicalMediaPath(items[0]!.path),
    sizeBytes: null,
    mtimeMs: null,
    fileId: null,
  };
  return {
    outcome: "matched",
    libraryItemIds: items.map((item) => item.id),
    path: items[0]!.path,
    revision,
  };
}

async function revisionForPath(
  store: Store,
  path: string,
  statFile: (path: string) => Promise<PlaybackFileRevision | null>,
): Promise<PlaybackFileRevision | null> {
  if (!path) return null;
  const items = libraryItemsForPath(store, path);
  if (items[0]) return statFile(items[0].path);
  return statFile(path);
}

function libraryItemsForPath(store: Store, path: string): LibraryItem[] {
  const canonical = canonicalMediaPath(path);
  const exact = store.itemsForCanonicalPath(canonical).filter((item) => mediaPathsEqual(item.path, path));
  if (exact.length) return exact;
  if (path !== canonical) {
    const raw = store.itemsForCanonicalPath(path).filter((item) => mediaPathsEqual(item.path, path));
    if (raw.length) return raw;
  }
  if (process.platform !== "win32" && process.platform !== "darwin") return [];
  return store.itemsForPathIgnoreCase(canonical).filter((item) => mediaPathsEqual(item.path, path));
}

function titleForItems(store: Store, ids: string[], fallback: string): string {
  const items = ids.map((id) => store.getItem(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (items.length === 0) return fallback;
  return displayTitle(items[0]!) || fallback;
}

function summariesFor(session: JellyfinParsedSession): string[] {
  return [describePlaybackObservation({
    deviceLabel: session.deviceLabel,
    playMethod: session.playState?.playMethod ?? null,
    reasons: session.transcoding?.transcodeReasons ?? [],
  })];
}

function occurrenceKey(sessionId: string, itemId: string, mediaSourceId: string): string {
  return `${sessionId}\0${itemId}\0${mediaSourceId}`;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function unknownHealth(connectionId: string, observePlayback: boolean): PlaybackConnectionHealth {
  return {
    connectionId,
    observePlayback,
    status: observePlayback ? "unknown" : "off",
    lastSuccessAt: null,
    lastError: null,
    complete: false,
    credentialKind: "unknown",
    householdVisible: false,
    stale: observePlayback,
  };
}

function writeHealth(
  live: Map<string, ConnectionLive>,
  settings: PlaybackConnectionSettings,
  patch: Partial<PlaybackConnectionHealth>,
  now: number,
  staleMs: number,
): void {
  const current = live.get(settings.connectionId);
  const health: PlaybackConnectionHealth = {
    ...(current?.health ?? unknownHealth(settings.connectionId, settings.observePlayback)),
    ...patch,
    connectionId: settings.connectionId,
    observePlayback: settings.observePlayback,
  };
  health.stale = isStale(health, settings, now, staleMs);
  health.status = effectiveStatus(health, settings, now, staleMs);
  live.set(settings.connectionId, {
    health,
    missCounts: current?.missCounts ?? new Map(),
    tokenFingerprint: current?.tokenFingerprint ?? null,
  });
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isStale(health: PlaybackConnectionHealth, settings: PlaybackConnectionSettings | undefined, now: number, staleMs: number): boolean {
  if (!settings?.observePlayback) return false;
  if (health.lastSuccessAt == null || !health.complete) return true;
  return now - health.lastSuccessAt > staleMs;
}

function effectiveStatus(
  health: PlaybackConnectionHealth,
  settings: PlaybackConnectionSettings | undefined,
  now: number,
  staleMs: number,
): PlaybackHealthStatus {
  if (!settings?.observePlayback) return "off";
  if (isStale(health, settings, now, staleMs) && health.status !== "error" && health.status !== "incomplete" && health.status !== "unavailable" && health.status !== "unknown") {
    return "stale";
  }
  return health.status;
}

function parseIdList(value: unknown, label: string): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { ok: false, error: `The ${label} list is invalid.` };
  }
  return { ok: true, ids: value };
}

export async function statPlaybackRevision(path: string): Promise<PlaybackFileRevision | null> {
  const canonicalPath = canonicalMediaPath(path);
  try {
    const info = await stat(path);
    return {
      canonicalPath,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      fileId: `${info.dev}:${info.ino}`,
    };
  } catch {
    return { canonicalPath, sizeBytes: null, mtimeMs: null, fileId: null };
  }
}
