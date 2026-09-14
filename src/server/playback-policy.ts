import {
  PLAYBACK_IDLE_COOLDOWN_MS,
  PLAYBACK_IDLE_OBSERVATIONS,
  PLAYBACK_STALE_MS,
  type PlaybackConnectionSettings,
  type PlaybackMatchOutcome,
} from "./types.ts";

export const PLAYBACK_WAIT_FINISH = "Waiting for Jellyfin playback to finish";
export const PLAYBACK_WAIT_STATUS = "Waiting for Jellyfin playback status.";

export type PlaybackHoldReason = "playing" | "unknown" | "cooldown";

export type PlaybackPolicySession = {
  nowPlaying: {
    itemId: string;
    mediaType: string | null;
    type: string | null;
    path: string | null;
  } | null;
  isPaused: boolean | null;
  match: {
    outcome: PlaybackMatchOutcome;
    libraryItemIds: string[];
    path: string | null;
    instanceIds: string[];
  } | null;
};

export type PlaybackPolicyObservation = {
  connectionId: string;
  fetchedAt: number;
  complete: boolean;
  error: string | null;
  sessions: PlaybackPolicySession[];
};

export type PlaybackFileTarget = {
  itemId: string;
  path: string;
  instanceId: string;
};

export type PlaybackDecision = {
  allowed: boolean;
  reason: PlaybackHoldReason | null;
  connectionIds: string[];
  connectionNames: string[];
  observedAt: number | null;
};

export type NodeWorkAdmission = {
  allowed: boolean;
  freeSlots: number;
  decision: PlaybackDecision;
};

export type PlaybackPolicy = {
  observe(observation: PlaybackPolicyObservation): void;
  forget(connectionId: string): void;
  reset(): void;
  nodeAdmission(nodeId: string, connections: PlaybackConnectionSettings[], now?: number): PlaybackDecision;
  fileReplacement(file: PlaybackFileTarget, connections: PlaybackConnectionSettings[], now?: number): PlaybackDecision;
  blockedNodeIds(connections: PlaybackConnectionSettings[], now?: number): string[];
};

type CooldownState = {
  lastBlockingAt: number | null;
  idleStreak: number;
  firstIdleAt: number | null;
};

type ConnectionState = {
  lastObservation: PlaybackPolicyObservation | null;
  lastSuccessAt: number | null;
  lastFetchedAt: number | null;
  cooldown: CooldownState;
};

const EMPTY_COOLDOWN: CooldownState = { lastBlockingAt: null, idleStreak: 0, firstIdleAt: null };

export const PLAYBACK_ALLOWED: PlaybackDecision = {
  allowed: true,
  reason: null,
  connectionIds: [],
  connectionNames: [],
  observedAt: null,
};

export function playbackMonitoringEnabled(settings: PlaybackConnectionSettings): boolean {
  return settings.observePlayback || settings.protectNodes || settings.protectReplacement;
}

export function sessionIsPotentialVideo(session: PlaybackPolicySession): boolean {
  if (!session.nowPlaying) return false;
  return !isAudioOnly(session.nowPlaying.mediaType, session.nowPlaying.type);
}

export function sessionBlocksNode(session: PlaybackPolicySession): boolean {
  if (!sessionIsPotentialVideo(session)) return false;
  return session.isPaused !== true;
}

export function sessionBlocksFile(
  session: PlaybackPolicySession,
  file: PlaybackFileTarget,
  coveredArrIds: ReadonlySet<string>,
): boolean {
  if (!sessionIsPotentialVideo(session)) return false;
  const match = session.match;
  if (!match || match.outcome !== "matched") return coveredArrIds.has(file.instanceId);
  const sameItem = match.libraryItemIds.includes(file.itemId);
  const samePath = Boolean(match.path && file.path && pathsLookSame(match.path, file.path));
  if (!sameItem && !samePath) return false;
  return match.instanceIds.some((id) => coveredArrIds.has(id)) || coveredArrIds.has(file.instanceId);
}

export function admitNodeWork(input: {
  decision: PlaybackDecision;
  concurrency: number;
  runningCount: number;
}): NodeWorkAdmission {
  if (!input.decision.allowed) {
    return { allowed: false, freeSlots: 0, decision: input.decision };
  }
  const freeSlots = Math.max(0, input.concurrency - input.runningCount);
  return { allowed: freeSlots > 0, freeSlots, decision: input.decision };
}

export function playbackHoldSentence(decision: PlaybackDecision): string | null {
  if (decision.allowed) return null;
  if (decision.reason === "playing") return PLAYBACK_WAIT_FINISH;
  return PLAYBACK_WAIT_STATUS;
}

export function playbackHoldDetail(decision: PlaybackDecision): string | null {
  if (decision.allowed || decision.connectionNames.length === 0) return null;
  return decision.connectionNames.join(", ");
}

export function createPlaybackPolicy(opts: {
  clock?: () => number;
  staleMs?: number;
  cooldownMs?: number;
  idleObservations?: number;
  connectionName?: (connectionId: string) => string;
} = {}): PlaybackPolicy {
  const staleMs = opts.staleMs ?? PLAYBACK_STALE_MS;
  const cooldownMs = opts.cooldownMs ?? PLAYBACK_IDLE_COOLDOWN_MS;
  const idleNeeded = opts.idleObservations ?? PLAYBACK_IDLE_OBSERVATIONS;
  const now = () => opts.clock?.() ?? Date.now();
  const nameOf = opts.connectionName ?? ((id: string) => id);
  const states = new Map<string, ConnectionState>();

  function stateFor(connectionId: string): ConnectionState {
    const existing = states.get(connectionId);
    if (existing) return existing;
    const created: ConnectionState = {
      lastObservation: null,
      lastSuccessAt: null,
      lastFetchedAt: null,
      cooldown: { ...EMPTY_COOLDOWN },
    };
    states.set(connectionId, created);
    return created;
  }

  return {
    observe(observation) {
      const state = stateFor(observation.connectionId);
      if (state.lastFetchedAt === observation.fetchedAt) {
        state.lastObservation = observation;
        return;
      }
      if (state.lastSuccessAt != null && observation.fetchedAt - state.lastSuccessAt > staleMs) {
        state.cooldown = nextCooldown(state.cooldown, "unknown", state.lastSuccessAt + staleMs);
      }
      const kind = nodeObservationKind(observation);
      state.cooldown = nextCooldown(state.cooldown, kind, observation.fetchedAt);
      state.lastObservation = observation;
      state.lastFetchedAt = observation.fetchedAt;
      if (observation.complete && !observation.error) state.lastSuccessAt = observation.fetchedAt;
    },
    forget(connectionId) {
      states.delete(connectionId);
    },
    reset() {
      states.clear();
    },
    nodeAdmission(nodeId, connections, at = now()) {
      const relevant = connections.filter(
        (row) => row.protectNodes && row.protectedNodeIds.includes(nodeId),
      );
      if (relevant.length === 0) return PLAYBACK_ALLOWED;
      return combineDecisions(
        relevant.map((row) => decideNode(stateFor(row.connectionId), row, at, staleMs, cooldownMs, idleNeeded, nameOf)),
      );
    },
    fileReplacement(file, connections, at = now()) {
      const relevant = connections.filter((row) => row.protectReplacement);
      if (relevant.length === 0) return PLAYBACK_ALLOWED;
      return combineDecisions(
        relevant.map((row) => decideFile(stateFor(row.connectionId), row, file, at, staleMs, nameOf)),
      );
    },
    blockedNodeIds(connections, at = now()) {
      const ids = new Set<string>();
      for (const row of connections) {
        if (!row.protectNodes) continue;
        for (const nodeId of row.protectedNodeIds) {
          if (ids.has(nodeId)) continue;
          if (!this.nodeAdmission(nodeId, connections, at).allowed) ids.add(nodeId);
        }
      }
      return [...ids];
    },
  };
}

function decideNode(
  state: ConnectionState,
  settings: PlaybackConnectionSettings,
  at: number,
  staleMs: number,
  cooldownMs: number,
  idleNeeded: number,
  nameOf: (id: string) => string,
): PlaybackDecision {
  const named = (reason: PlaybackHoldReason, observedAt: number | null): PlaybackDecision => ({
    allowed: false,
    reason,
    connectionIds: [settings.connectionId],
    connectionNames: [nameOf(settings.connectionId)],
    observedAt,
  });
  if (!state.lastObservation) return named("unknown", null);
  const snapshot = state.lastObservation;
  const observedAt = snapshot.fetchedAt;
  if (!snapshot.complete || snapshot.error) return named("unknown", observedAt);
  if (state.lastSuccessAt == null || at - state.lastSuccessAt > staleMs) return named("unknown", state.lastSuccessAt);
  if (snapshot.sessions.some(sessionBlocksNode)) return named("playing", observedAt);
  if (!cooldownReady(state.cooldown, at, cooldownMs, idleNeeded)) return named("cooldown", observedAt);
  return { ...PLAYBACK_ALLOWED, observedAt };
}

function decideFile(
  state: ConnectionState,
  settings: PlaybackConnectionSettings,
  file: PlaybackFileTarget,
  at: number,
  staleMs: number,
  nameOf: (id: string) => string,
): PlaybackDecision {
  const named = (reason: PlaybackHoldReason, observedAt: number | null): PlaybackDecision => ({
    allowed: false,
    reason,
    connectionIds: [settings.connectionId],
    connectionNames: [nameOf(settings.connectionId)],
    observedAt,
  });
  if (!state.lastObservation) return named("unknown", null);
  const snapshot = state.lastObservation;
  const observedAt = snapshot.fetchedAt;
  if (!snapshot.complete || snapshot.error) return named("unknown", observedAt);
  if (state.lastSuccessAt == null || at - state.lastSuccessAt > staleMs) return named("unknown", state.lastSuccessAt);
  const covered = new Set(settings.coveredArrInstanceIds);
  if (snapshot.sessions.some((session) => sessionBlocksFile(session, file, covered))) {
    return named("playing", observedAt);
  }
  return { ...PLAYBACK_ALLOWED, observedAt };
}

function nodeObservationKind(observation: PlaybackPolicyObservation): "blocking" | "unknown" | "idle" {
  if (!observation.complete || observation.error) return "unknown";
  if (observation.sessions.some(sessionBlocksNode)) return "blocking";
  return "idle";
}

// Unknown and playing both restart the wait. After startup with no block, the 30s clock starts at the first idle snapshot.
function nextCooldown(prev: CooldownState, kind: "blocking" | "unknown" | "idle", at: number): CooldownState {
  if (kind === "blocking" || kind === "unknown") {
    return { lastBlockingAt: at, idleStreak: 0, firstIdleAt: null };
  }
  return {
    lastBlockingAt: prev.lastBlockingAt,
    idleStreak: prev.idleStreak + 1,
    firstIdleAt: prev.firstIdleAt ?? at,
  };
}

function cooldownReady(state: CooldownState, at: number, cooldownMs: number, idleNeeded: number): boolean {
  if (state.idleStreak < idleNeeded) return false;
  const origin = state.lastBlockingAt ?? state.firstIdleAt;
  if (origin == null) return false;
  return at - origin >= cooldownMs;
}

function combineDecisions(decisions: PlaybackDecision[]): PlaybackDecision {
  const blocked = decisions.filter((row) => !row.allowed);
  if (blocked.length === 0) {
    const observedAt = decisions.reduce<number | null>((latest, row) => {
      if (row.observedAt == null) return latest;
      if (latest == null || row.observedAt > latest) return row.observedAt;
      return latest;
    }, null);
    return { ...PLAYBACK_ALLOWED, observedAt };
  }
  const rank = { playing: 0, unknown: 1, cooldown: 2 };
  blocked.sort((left, right) => rank[left.reason ?? "unknown"] - rank[right.reason ?? "unknown"]);
  const chosen = blocked[0]!;
  const connectionIds: string[] = [];
  const connectionNames: string[] = [];
  const seen = new Set<string>();
  for (const row of blocked) {
    for (let index = 0; index < row.connectionIds.length; index += 1) {
      const id = row.connectionIds[index]!;
      if (seen.has(id)) continue;
      seen.add(id);
      connectionIds.push(id);
      connectionNames.push(row.connectionNames[index] ?? id);
    }
  }
  const observedAt = blocked.reduce<number | null>((latest, row) => {
    if (row.observedAt == null) return latest;
    if (latest == null || row.observedAt > latest) return row.observedAt;
    return latest;
  }, null);
  return {
    allowed: false,
    reason: chosen.reason,
    connectionIds,
    connectionNames,
    observedAt,
  };
}

function isAudioOnly(mediaType: string | null, type: string | null): boolean {
  const tokens = [mediaType, type].map((value) => (value ?? "").trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((token) => token === "video" || token === "movie" || token === "episode" || token === "musicvideo" || token === "trailer")) {
    return false;
  }
  return tokens.some((token) => token === "audio" || token === "audiobook");
}

function pathsLookSame(left: string, right: string): boolean {
  const a = left.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const b = right.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return a === b;
}
