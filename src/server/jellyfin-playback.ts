import { timingSafeEqual } from "node:crypto";
import { trimUrl } from "./arr.ts";
import { jellyfinAuthHeaders } from "./notify.ts";
import {
  PLAYBACK_MAX_RESPONSE_BYTES,
  PLAYBACK_MAX_SESSIONS,
  PLAYBACK_REASON_MAX_CHARS,
  PLAYBACK_REQUEST_TIMEOUT_MS,
  PLAYBACK_SOURCE_CACHE_MS,
  PLAYBACK_SOURCE_CONCURRENCY,
  PLAYBACK_TEXT_MAX_CHARS,
  type PlaybackCredentialKind,
  type PlaybackFileRevision,
} from "./types.ts";

export type JellyfinPlaybackOptions = {
  fetch: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxSessions?: number;
  sourceCacheMs?: number;
  sourceConcurrency?: number;
};

export type JellyfinMediaSourceRef = {
  id: string;
  path: string | null;
  protocol: string | null;
  isRemote: boolean | null;
  type: string | null;
};

export type JellyfinMediaStreamRef = {
  index: number;
  type: string;
  codec: string | null;
  language: string | null;
  channels: number | null;
};

export type JellyfinNowPlaying = {
  itemId: string;
  name: string;
  mediaType: string | null;
  type: string | null;
  path: string | null;
  mediaSources: JellyfinMediaSourceRef[];
  mediaStreams: JellyfinMediaStreamRef[];
};

export type JellyfinPlayState = {
  isPaused: boolean | null;
  mediaSourceId: string | null;
  playMethod: string | null;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | null;
  liveStreamId: string | null;
};

export type JellyfinTranscoding = {
  audioCodec: string | null;
  videoCodec: string | null;
  container: string | null;
  isVideoDirect: boolean | null;
  isAudioDirect: boolean | null;
  transcodeReasons: string[];
};

export type JellyfinParsedSession = {
  sessionId: string;
  deviceId: string;
  deviceLabel: string;
  nowPlaying: JellyfinNowPlaying | null;
  playState: JellyfinPlayState | null;
  transcoding: JellyfinTranscoding | null;
};

export type JellyfinSessionSnapshot = {
  connectionId: string;
  fetchedAt: number;
  complete: boolean;
  sessions: JellyfinParsedSession[];
  error: string | null;
  truncated: boolean;
};

export type ResolvedMediaSource = {
  itemId: string;
  mediaSourceId: string;
  path: string | null;
  protocol: string | null;
  isRemote: boolean;
  localFile: boolean;
  outcome: "ok" | "missing" | "remote" | "ambiguous";
};

export type PlaybackAccessResult = {
  ok: boolean;
  credentialKind: PlaybackCredentialKind;
  householdVisible: boolean;
  kind: "ok" | "access" | "connect" | "shape";
  message: string | null;
};

export type JellyfinPlaybackClient = {
  fetchSnapshot(input: { url: string; token: string; connectionId: string }): Promise<JellyfinSessionSnapshot>;
  resolveMediaSource(input: {
    url: string;
    token: string;
    connectionId: string;
    itemId: string;
    mediaSourceId: string;
    revisionKey?: string;
  }): Promise<ResolvedMediaSource>;
  testPlaybackAccess(input: { url: string; token: string; checkSessions?: boolean }): Promise<PlaybackAccessResult>;
  invalidateSourceCache(connectionId?: string): void;
};

type CacheEntry = { value: ResolvedMediaSource; expiresAt: number; revisionKey: string };

const TRANSCODE_REASON_BITS: Array<[number, string]> = [
  [1 << 0, "ContainerNotSupported"],
  [1 << 1, "VideoCodecNotSupported"],
  [1 << 2, "AudioCodecNotSupported"],
  [1 << 3, "SubtitleCodecNotSupported"],
  [1 << 4, "AudioIsExternal"],
  [1 << 5, "SecondaryAudioNotSupported"],
  [1 << 6, "VideoProfileNotSupported"],
  [1 << 7, "VideoLevelNotSupported"],
  [1 << 8, "VideoResolutionNotSupported"],
  [1 << 9, "VideoBitDepthNotSupported"],
  [1 << 10, "VideoFramerateNotSupported"],
  [1 << 11, "RefFramesNotSupported"],
  [1 << 12, "AnamorphicVideoNotSupported"],
  [1 << 13, "InterlacedVideoNotSupported"],
  [1 << 14, "AudioChannelsNotSupported"],
  [1 << 15, "AudioProfileNotSupported"],
  [1 << 16, "AudioSampleRateNotSupported"],
  [1 << 17, "AudioBitDepthNotSupported"],
  [1 << 18, "ContainerBitrateExceedsLimit"],
  [1 << 19, "VideoBitrateNotSupported"],
  [1 << 20, "AudioBitrateNotSupported"],
  [1 << 21, "UnknownVideoStreamInfo"],
  [1 << 22, "UnknownAudioStreamInfo"],
  [1 << 23, "DirectPlayError"],
  [1 << 24, "VideoRangeTypeNotSupported"],
  [1 << 25, "VideoCodecTagNotSupported"],
  [1 << 26, "StreamCountExceedsLimit"],
  [1 << 27, "VideoRotationNotSupported"],
];

export function createJellyfinPlayback(opts: JellyfinPlaybackOptions): JellyfinPlaybackClient {
  const httpFetch = opts.fetch;
  const timeoutMs = opts.timeoutMs ?? PLAYBACK_REQUEST_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? PLAYBACK_MAX_RESPONSE_BYTES;
  const maxSessions = opts.maxSessions ?? PLAYBACK_MAX_SESSIONS;
  const cacheMs = opts.sourceCacheMs ?? PLAYBACK_SOURCE_CACHE_MS;
  const concurrency = opts.sourceConcurrency ?? PLAYBACK_SOURCE_CONCURRENCY;
  const now = () => opts.clock?.() ?? Date.now();
  const cache = new Map<string, CacheEntry>();
  const gates = new Map<string, Limit>();

  function limitFor(connectionId: string): Limit {
    const existing = gates.get(connectionId);
    if (existing) return existing;
    const created = new Limit(concurrency);
    gates.set(connectionId, created);
    return created;
  }

  return {
    async fetchSnapshot(input) {
      const fetchedAt = now();
      const result = await jellyfinGet({
        fetch: httpFetch,
        url: `${trimUrl(input.url)}/Sessions`,
        token: input.token,
        timeoutMs,
        maxBytes,
      });
      if (!result.ok) {
        return {
          connectionId: input.connectionId,
          fetchedAt,
          complete: false,
          sessions: [],
          error: result.message,
          truncated: result.kind === "too_large",
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(result.bytes));
      } catch {
        return {
          connectionId: input.connectionId,
          fetchedAt,
          complete: false,
          sessions: [],
          error: "Jellyfin returned a session list that is not valid JSON.",
          truncated: false,
        };
      }
      if (!Array.isArray(parsed)) {
        return {
          connectionId: input.connectionId,
          fetchedAt,
          complete: false,
          sessions: [],
          error: "Jellyfin returned a session list that is not an array.",
          truncated: false,
        };
      }
      const truncated = parsed.length > maxSessions;
      const slice = truncated ? parsed.slice(0, maxSessions) : parsed;
      return {
        connectionId: input.connectionId,
        fetchedAt,
        complete: !truncated,
        sessions: slice.map(parseSession).filter((row): row is JellyfinParsedSession => row !== null),
        error: truncated ? "Jellyfin returned more than 1,000 sessions." : null,
        truncated,
      };
    },

    async resolveMediaSource(input) {
      const at = now();
      for (const [cachedKey, entry] of cache) {
        if (entry.expiresAt <= at) cache.delete(cachedKey);
      }
      const key = `${input.connectionId}:${input.itemId}:${input.mediaSourceId}`;
      const revisionKey = input.revisionKey ?? "";
      const hit = cache.get(key);
      if (hit && hit.expiresAt > at && hit.revisionKey === revisionKey) return hit.value;
      const value = await limitFor(input.connectionId).run(() => resolveFromServer({
        fetch: httpFetch,
        url: input.url,
        token: input.token,
        itemId: input.itemId,
        mediaSourceId: input.mediaSourceId,
        timeoutMs,
        maxBytes,
      }));
      cache.set(key, { value, expiresAt: at + cacheMs, revisionKey });
      return value;
    },

    async testPlaybackAccess(input) {
      return testPlaybackAccess({
        fetch: httpFetch,
        url: input.url,
        token: input.token,
        timeoutMs,
        maxBytes,
        checkSessions: input.checkSessions !== false,
      });
    },

    invalidateSourceCache(connectionId) {
      if (!connectionId) {
        cache.clear();
        return;
      }
      for (const key of [...cache.keys()]) {
        if (key.startsWith(`${connectionId}:`)) cache.delete(key);
      }
    },
  };
}

export function sessionHasCurrentItem(session: JellyfinParsedSession): boolean {
  return session.nowPlaying !== null;
}

export function verifiedSessionPath(session: JellyfinParsedSession): string | null {
  const sourceId = session.playState?.mediaSourceId;
  if (!sourceId || !session.nowPlaying) return null;
  const match = session.nowPlaying.mediaSources.find((source) => source.id === sourceId);
  if (!match?.path) return null;
  if (!isLocalFileSource(match)) return null;
  return match.path;
}

export function isLocalFileSource(source: {
  path: string | null;
  protocol: string | null;
  isRemote: boolean | null;
}): boolean {
  if (source.isRemote === true) return false;
  if (!source.path) return false;
  if (/^https?:\/\//i.test(source.path)) return false;
  if (source.protocol !== null && !isFileProtocol(source.protocol)) return false;
  return true;
}

export function parseTranscodeReasons(value: unknown): string[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    const reasons: string[] = [];
    let leftover = value >>> 0;
    for (const [bit, name] of TRANSCODE_REASON_BITS) {
      if (leftover & bit) {
        reasons.push(name);
        leftover &= ~bit;
      }
    }
    if (leftover) reasons.push(`UnknownReason:${leftover}`);
    return reasons.map(boundReason);
  }
  if (typeof value === "string") {
    return value.split(/[,|]/).map((part) => boundReason(part.trim())).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === "string" ? [boundReason(entry)] : []));
  }
  return [];
}

export function transcodeReasonFamilies(reasons: string[]): string[] {
  const families: string[] = [];
  const seen = new Set<string>();
  for (const reason of reasons) {
    const family = reasonFamilyOf(reason);
    if (seen.has(family)) continue;
    seen.add(family);
    families.push(family);
  }
  return families;
}

export function transcodeReasonFamily(reasons: string[]): string | null {
  const families = transcodeReasonFamilies(reasons);
  if (families.length === 0) return null;
  if (families.length === 1) return families[0] ?? null;
  return "mixed";
}

export function describePlaybackObservation(input: {
  deviceLabel: string;
  playMethod: string | null;
  reasons: string[];
}): string {
  const device = input.deviceLabel || "a player";
  if (input.playMethod === "DirectPlay") return `Jellyfin played this file directly on ${device}.`;
  const family = transcodeReasonFamily(input.reasons);
  if (family === "audio") return `Jellyfin converted the audio on ${device}.`;
  if (family === "video") return `Jellyfin converted the video on ${device}.`;
  if (family === "subtitle") return `Jellyfin converted the subtitles on ${device}.`;
  if (family === "container") return `Jellyfin converted the container on ${device}.`;
  if (family === "bitrate") return `Jellyfin converted this file because of a bitrate limit on ${device}.`;
  if (input.reasons.length === 0) return "Jellyfin did not report the reason.";
  return `Jellyfin converted playback on ${device}.`;
}

function reasonFamilyOf(reason: string): string {
  if (
    reason.startsWith("Audio")
    || reason === "SecondaryAudioNotSupported"
    || reason === "UnknownAudioStreamInfo"
  ) return "audio";
  if (
    reason.startsWith("Video")
    || reason === "RefFramesNotSupported"
    || reason === "AnamorphicVideoNotSupported"
    || reason === "InterlacedVideoNotSupported"
    || reason === "UnknownVideoStreamInfo"
  ) return "video";
  if (reason.includes("Subtitle")) return "subtitle";
  if (reason === "ContainerNotSupported") return "container";
  if (reason.includes("Bitrate") || reason === "ContainerBitrateExceedsLimit") return "bitrate";
  if (reason === "DirectPlayError" || reason === "StreamCountExceedsLimit" || reason === "AudioIsExternal") return "other";
  return "unknown";
}

function parseSession(raw: unknown): JellyfinParsedSession | null {
  const row = asRecord(raw);
  const sessionId = str(pick(row, "Id", "id"));
  if (!sessionId) return null;
  const deviceName = str(pick(row, "DeviceName", "deviceName")) || "Unknown device";
  return {
    sessionId,
    deviceId: str(pick(row, "DeviceId", "deviceId")),
    deviceLabel: boundText(deviceName, PLAYBACK_TEXT_MAX_CHARS),
    nowPlaying: parseNowPlaying(pick(row, "NowPlayingItem", "nowPlayingItem")),
    playState: parsePlayState(pick(row, "PlayState", "playState")),
    transcoding: parseTranscoding(pick(row, "TranscodingInfo", "transcodingInfo")),
  };
}

function parseNowPlaying(value: unknown): JellyfinNowPlaying | null {
  if (value == null) return null;
  const row = asRecord(value);
  const itemId = str(pick(row, "Id", "id"));
  if (!itemId) return null;
  const sourcesRaw = pick(row, "MediaSources", "mediaSources");
  const streamsRaw = pick(row, "MediaStreams", "mediaStreams");
  return {
    itemId,
    name: boundText(str(pick(row, "Name", "name")) || "Untitled", PLAYBACK_TEXT_MAX_CHARS),
    mediaType: optionalStr(pick(row, "MediaType", "mediaType")),
    type: optionalStr(pick(row, "Type", "type")),
    path: optionalStr(pick(row, "Path", "path")),
    mediaSources: Array.isArray(sourcesRaw) ? sourcesRaw.flatMap(parseMediaSource) : [],
    mediaStreams: Array.isArray(streamsRaw) ? streamsRaw.flatMap(parseMediaStream) : [],
  };
}

function parseMediaSource(raw: unknown): JellyfinMediaSourceRef[] {
  const row = asRecord(raw);
  const id = str(pick(row, "Id", "id"));
  if (!id) return [];
  return [{
    id,
    path: optionalStr(pick(row, "Path", "path")),
    protocol: protocolString(pick(row, "Protocol", "protocol")),
    isRemote: optionalBoolean(pick(row, "IsRemote", "isRemote")),
    type: optionalStr(pick(row, "Type", "type")),
  }];
}

function parseMediaStream(raw: unknown): JellyfinMediaStreamRef[] {
  const row = asRecord(raw);
  const index = optionalInt(pick(row, "Index", "index"));
  const type = optionalStr(pick(row, "Type", "type"));
  if (index == null || !type) return [];
  return [{
    index,
    type,
    codec: optionalStr(pick(row, "Codec", "codec")),
    language: optionalStr(pick(row, "Language", "language")),
    channels: optionalInt(pick(row, "Channels", "channels")),
  }];
}

function parsePlayState(value: unknown): JellyfinPlayState | null {
  if (value == null) return null;
  const row = asRecord(value);
  return {
    isPaused: optionalBoolean(pick(row, "IsPaused", "isPaused")),
    mediaSourceId: optionalStr(pick(row, "MediaSourceId", "mediaSourceId")),
    playMethod: optionalStr(pick(row, "PlayMethod", "playMethod")),
    audioStreamIndex: optionalInt(pick(row, "AudioStreamIndex", "audioStreamIndex")),
    subtitleStreamIndex: optionalInt(pick(row, "SubtitleStreamIndex", "subtitleStreamIndex")),
    liveStreamId: optionalStr(pick(row, "LiveStreamId", "liveStreamId")),
  };
}

function parseTranscoding(value: unknown): JellyfinTranscoding | null {
  if (value == null) return null;
  const row = asRecord(value);
  return {
    audioCodec: optionalStr(pick(row, "AudioCodec", "audioCodec")),
    videoCodec: optionalStr(pick(row, "VideoCodec", "videoCodec")),
    container: optionalStr(pick(row, "Container", "container")),
    isVideoDirect: optionalBoolean(pick(row, "IsVideoDirect", "isVideoDirect")),
    isAudioDirect: optionalBoolean(pick(row, "IsAudioDirect", "isAudioDirect")),
    transcodeReasons: parseTranscodeReasons(pick(row, "TranscodeReasons", "transcodeReasons")),
  };
}

async function resolveFromServer(input: {
  fetch: typeof fetch;
  url: string;
  token: string;
  itemId: string;
  mediaSourceId: string;
  timeoutMs: number;
  maxBytes: number;
}): Promise<ResolvedMediaSource> {
  const missing: ResolvedMediaSource = {
    itemId: input.itemId,
    mediaSourceId: input.mediaSourceId,
    path: null,
    protocol: null,
    isRemote: false,
    localFile: false,
    outcome: "missing",
  };
  const result = await jellyfinGet({
    fetch: input.fetch,
    url: `${trimUrl(input.url)}/Items/${encodeURIComponent(input.itemId)}/PlaybackInfo`,
    token: input.token,
    timeoutMs: input.timeoutMs,
    maxBytes: input.maxBytes,
  });
  if (!result.ok) return missing;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(result.bytes));
  } catch {
    return missing;
  }
  const row = asRecord(parsed);
  const sourcesRaw = pick(row, "MediaSources", "mediaSources");
  const sources = Array.isArray(sourcesRaw) ? sourcesRaw.flatMap(parseMediaSource) : [];
  const matches = sources.filter((source) => source.id === input.mediaSourceId);
  if (matches.length === 0) return missing;
  if (matches.length > 1) {
    return { ...missing, outcome: "ambiguous" };
  }
  const source = matches[0]!;
  if (!isLocalFileSource(source)) {
    return {
      itemId: input.itemId,
      mediaSourceId: input.mediaSourceId,
      path: source.path,
      protocol: source.protocol,
      isRemote: source.isRemote === true || !isFileProtocol(source.protocol ?? ""),
      localFile: false,
      outcome: "remote",
    };
  }
  return {
    itemId: input.itemId,
    mediaSourceId: input.mediaSourceId,
    path: source.path,
    protocol: source.protocol ?? "File",
    isRemote: false,
    localFile: true,
    outcome: "ok",
  };
}

async function testPlaybackAccess(input: {
  fetch: typeof fetch;
  url: string;
  token: string;
  timeoutMs: number;
  maxBytes: number;
  checkSessions: boolean;
}): Promise<PlaybackAccessResult> {
  const keys = await jellyfinGet({
    fetch: input.fetch,
    url: `${trimUrl(input.url)}/Auth/Keys`,
    token: input.token,
    timeoutMs: input.timeoutMs,
    maxBytes: input.maxBytes,
  });
  if (!keys.ok) {
    if (keys.kind === "auth") {
      return {
        ok: false,
        credentialKind: "userToken",
        householdVisible: false,
        kind: "access",
        message: "This Jellyfin login can only see its own sessions. Use a server API key to observe the whole household.",
      };
    }
    return {
      ok: false,
      credentialKind: "unknown",
      householdVisible: false,
      kind: keys.kind === "connect" || keys.kind === "timeout" ? "connect" : "shape",
      message: keys.message,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(keys.bytes));
  } catch {
    return {
      ok: false,
      credentialKind: "unknown",
      householdVisible: false,
      kind: "shape",
      message: "Jellyfin returned API keys that are not valid JSON.",
    };
  }
  const listed = apiKeyTokens(parsed);
  if (listed === null) {
    return {
      ok: false,
      credentialKind: "unknown",
      householdVisible: false,
      kind: "shape",
      message: "Jellyfin did not list server API keys in a form Polisharr can verify.",
    };
  }
  if (!listed.some((token) => tokenEquals(token, input.token))) {
    return {
      ok: false,
      credentialKind: "userToken",
      householdVisible: false,
      kind: "access",
      message: "This Jellyfin login is a user account, not a server API key. Household playback protection needs a server API key.",
    };
  }
  if (input.checkSessions) {
    const sessions = await jellyfinGet({
      fetch: input.fetch,
      url: `${trimUrl(input.url)}/Sessions`,
      token: input.token,
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
    });
    if (!sessions.ok) {
      return {
        ok: false,
        credentialKind: "apiKey",
        householdVisible: false,
        kind: sessions.kind === "auth" ? "access" : "connect",
        message: sessions.message,
      };
    }
  }
  return { ok: true, credentialKind: "apiKey", householdVisible: true, kind: "ok", message: null };
}

function apiKeyTokens(payload: unknown): string[] | null {
  const row = asRecord(payload);
  const items = Array.isArray(payload) ? payload : pick(row, "Items", "items");
  if (!Array.isArray(items)) return null;
  const tokens: string[] = [];
  let sawTokenField = false;
  for (const entry of items) {
    const rec = asRecord(entry);
    const token = pick(rec, "AccessToken", "accessToken");
    if (typeof token === "string") {
      sawTokenField = true;
      if (token) tokens.push(token);
    }
  }
  if (items.length > 0 && !sawTokenField) return null;
  return tokens;
}

type GetFail = {
  ok: false;
  kind: "auth" | "connect" | "timeout" | "too_large" | "shape";
  message: string;
  status?: number;
};

async function jellyfinGet(input: {
  fetch: typeof fetch;
  url: string;
  token: string;
  timeoutMs: number;
  maxBytes: number;
}): Promise<{ ok: true; status: number; bytes: Uint8Array } | GetFail> {
  try {
    const res = await input.fetch(input.url, {
      method: "GET",
      headers: jellyfinAuthHeaders(input.token),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", message: "Jellyfin rejected this token.", status: res.status };
    }
    if (!res.ok) {
      return { ok: false, kind: "connect", message: `Jellyfin returned HTTP ${res.status}.`, status: res.status };
    }
    const bytes = await readCapped(res, input.maxBytes);
    if (bytes === "too_large") {
      return { ok: false, kind: "too_large", message: "Jellyfin returned more than 2 MiB of session data." };
    }
    return { ok: true, status: res.status, bytes };
  } catch (error) {
    if (isTimeout(error)) {
      return { ok: false, kind: "timeout", message: "Jellyfin did not answer before the timeout." };
    }
    return { ok: false, kind: "connect", message: "Polisharr could not reach Jellyfin." };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | "too_large"> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? "too_large" : buf;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isFileProtocol(value: string): boolean {
  return value === "File" || value === "0";
}

function protocolString(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value === 0) return "File";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function tokenEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function boundReason(value: string): string {
  return boundText(value, PLAYBACK_REASON_MAX_CHARS);
}

function boundText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row && row[key] !== undefined) return row[key];
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function optionalStr(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

class Limit {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export function revisionCacheKey(revision: PlaybackFileRevision | null): string {
  if (!revision) return "";
  return `${revision.canonicalPath}|${revision.sizeBytes ?? ""}|${revision.mtimeMs ?? ""}|${revision.fileId ?? ""}`;
}
