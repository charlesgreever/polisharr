async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  health: () => req<{ ok: boolean; service?: string; version?: string }>("/api/health"),
  work: () => req<{ queued: number; queueActive: number; review: number; runningTitle: string | null }>("/api/work"),
  status: () => req<{ authenticated: boolean; firstRun: FirstRun; version?: string; role?: "standalone" | "master" | "worker" }>("/api/auth/status"),
  worker: () => req<WorkerStatus>("/api/worker"),
  setup: (username: string, password: string) => req("/api/auth/setup", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) => req("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => req("/api/auth/logout", { method: "POST" }),
  settings: () => req<SettingsPayload>("/api/settings"),
  saveSettings: (body: Record<string, unknown>) => req("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  mintWebhookToken: () => req<{ token: string; url: string }>("/api/settings/webhook-token", { method: "POST" }),
  mintWidgetKey: () => req<{ key: string }>("/api/settings/widget-key", { method: "POST" }),
  mintClusterToken: () => req<{ token: string }>("/api/settings/cluster-token", { method: "POST" }),
  nodes: () => req<NodesPayload>("/api/nodes"),
  changePassword: (username: string, password: string) =>
    req("/api/auth/password", { method: "POST", body: JSON.stringify({ username, password }) }),
  hardware: () => req<Hardware>("/api/hardware"),
  saveInstance: (body: Record<string, unknown>) => req<{ ok: true; id: string }>("/api/integrations", { method: "POST", body: JSON.stringify(body) }),
  testInstance: (id: string) => req<{ ok: boolean; message?: string }>(`/api/integrations/${id}/test`, { method: "POST" }),
  deleteInstance: (id: string) => req(`/api/integrations/${id}`, { method: "DELETE" }),
  refresh: () => req<{ errors: string[] }>("/api/library/refresh", { method: "POST" }),
  movies: (offset = 0, limit = 50, sort: "title" | "size" | "quality" = "title") =>
    req<LibraryPage<LibraryRow>>(`/api/library/movies?offset=${offset}&limit=${limit}&sort=${sort}`),
  series: (offset = 0, limit = 50) => req<LibraryPage<SeriesSummary>>(`/api/library/series?offset=${offset}&limit=${limit}`),
  seriesEpisodes: (instanceId: string, seriesId: number, offset = 0, limit = 50) =>
    req<LibraryPage<LibraryRow>>(`/api/library/series/${encodeURIComponent(instanceId)}/${seriesId}/episodes?offset=${offset}&limit=${limit}`),
  title: (id: string) => req<{
    item: LibraryRow;
    hardware: Hardware;
    av1Available?: boolean;
    settings: { writeMode: string; videoTarget: string; preferredLanguage?: string };
    languageId?: { available?: boolean };
    pgsOcr?: { available?: boolean };
  }>(`/api/library/items/${id}`),
  previewPlan: async (id: string, draft: Record<string, unknown>) => {
    const res = await fetch(`/api/library/items/${id}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft }),
    });
    return (await res.json()) as { ok?: boolean; plan?: ExecutablePlan; errors?: Array<{ field: string; message: string }>; error?: string };
  },
  queueCustom: (id: string, draft: Record<string, unknown>, runNow = false, assignedNodeId?: string) =>
    req(`/api/library/items/${id}/queue`, { method: "POST", body: JSON.stringify({ draft, runNow, assignedNodeId }) }),
  searchPreferred: (id: string) =>
    req(`/api/library/items/${id}/search-preferred`, { method: "POST", body: JSON.stringify({ confirm: true }) }),
  detectLanguage: (id: string, trackIndex: number, startSec?: number) =>
    req<{
      ok?: boolean;
      language?: string;
      languageName?: string;
      probability?: number;
      startSec?: number;
      suggestedNextSec?: number;
      durationSec?: number;
      reason?: string;
    }>(`/api/library/items/${id}/detect-language`, { method: "POST", body: JSON.stringify({ trackIndex, startSec }) }),
  applyLanguage: (id: string, trackIndex: number, language: string, probability: number) =>
    req<{ ok?: boolean; language?: string; languageName?: string; item?: LibraryRow }>(
      `/api/library/items/${id}/apply-language`,
      { method: "POST", body: JSON.stringify({ trackIndex, language, probability }) },
    ),
  detectSubtitleLanguage: (id: string, trackIndex: number, startSec?: number) =>
    req<{
      ok?: boolean;
      language?: string;
      languageName?: string;
      probability?: number;
      startSec?: number;
      suggestedNextSec?: number;
      durationSec?: number;
      reason?: string;
    }>(`/api/library/items/${id}/detect-subtitle-language`, { method: "POST", body: JSON.stringify({ trackIndex, startSec }) }),
  applySubtitleLanguage: (id: string, trackIndex: number, language: string, probability: number) =>
    req<{ ok?: boolean; language?: string; languageName?: string; item?: LibraryRow }>(
      `/api/library/items/${id}/apply-subtitle-language`,
      { method: "POST", body: JSON.stringify({ trackIndex, language, probability }) },
    ),
  syncProfiles: () => req<{ results: Array<{ created: string[]; updated: string[]; failed: string[] }> }>("/api/settings/profiles/sync", { method: "POST" }),
  inspect: () => req<InspectState>("/api/inspect/status"),
  errors: (offset = 0, limit = 50) => req<LibraryPage<FileError>>(`/api/errors?offset=${offset}&limit=${limit}`),
  suggestions: (q = "", filters: SuggestionFilters = {}, offset = 0, limit = 50) => {
    const params = new URLSearchParams({ q, offset: String(offset), limit: String(limit) });
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, String(value));
    return req<LibraryPage<SuggestionRow>>(`/api/suggestions?${params}`);
  },
  queueFiltered: (q: string, filters: SuggestionFilters, assignedNodeId?: string) =>
    req<{ queued: number; skipped: number }>("/api/suggestions/queue-filtered", {
      method: "POST", body: JSON.stringify({ q, filters, assignedNodeId }),
    }),
  dismiss: (id: string) => req(`/api/suggestions/${id}/dismiss`, { method: "POST" }),
  queue: (body: Record<string, unknown>) => req("/api/queue", { method: "POST", body: JSON.stringify(body) }),
  jobs: (offset = 0, limit = 50) => req<LibraryPage<JobRow>>(`/api/jobs?offset=${offset}&limit=${limit}`),
  cancel: (id: string) => req(`/api/jobs/${id}/cancel`, { method: "POST" }),
  cancelAll: () => req<{ ok: true; cancelled: number }>("/api/jobs/cancel-all", { method: "POST" }),
  removeJob: (id: string) => req(`/api/jobs/${id}`, { method: "DELETE" }),
  clearFinishedJobs: () => req<{ ok: true; removed: number }>("/api/jobs/finished", { method: "DELETE" }),
  runNow: (id: string) => req(`/api/jobs/${id}/run-now`, { method: "POST" }),
  pauseJob: (id: string) => req(`/api/jobs/${id}/pause`, { method: "POST" }),
  resumeJob: (id: string) => req(`/api/jobs/${id}/resume`, { method: "POST" }),
  reorderJobs: (ids: string[]) => req("/api/jobs/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  jobLogs: (id: string) => req<{ log: string }>(`/api/jobs/${id}/logs`),
  review: (offset = 0, limit = 50) => req<LibraryPage<ReviewRow>>(`/api/review?offset=${offset}&limit=${limit}`),
  keep: (id: string) => req(`/api/review/${id}/keep`, { method: "POST" }),
  keepSelected: (ids: string[]) => req<{ accepted: number; skipped: number }>("/api/review/keep-selected", { method: "POST", body: JSON.stringify({ ids }) }),
  keepAll: () => req<{ accepted: number; skipped: number }>("/api/review/keep-all", { method: "POST" }),
  discard: (id: string) => req(`/api/review/${id}/discard`, { method: "POST" }),
  requeueFlagged: (id: string) => req<{ ok: true; id: string }>(`/api/review/${id}/requeue`, { method: "POST" }),
  history: (offset = 0, limit = 50) => req<LibraryPage<HistoryRow>>(`/api/history?offset=${offset}&limit=${limit}`),
  home: () => req<HomePayload>("/api/home"),
  search: (q: string) => req<{ items: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  force: (id: string) => req(`/api/library/items/${id}/force`, { method: "POST" }),
  stereo: (id: string) => req(`/api/library/items/${id}/stereo`, { method: "POST" }),
  exempt: (id: string, exempt: boolean) => req(`/api/library/items/${id}/exempt`, { method: "POST", body: JSON.stringify({ exempt }) }),
  setItemVideoTarget: (id: string, videoTarget: "hevc" | "av1" | null) =>
    req<{ item: LibraryRow; healthyCount: number; suggestionCount: number }>(`/api/library/items/${id}/video-target`, { method: "POST", body: JSON.stringify({ videoTarget }) }),
  setSeriesVideoTarget: (instanceId: string, seriesId: number, videoTarget: "hevc" | "av1" | null) =>
    req<{ videoTarget: "hevc" | "av1" | null; healthyCount: number; suggestionCount: number }>(
      `/api/library/series/${encodeURIComponent(instanceId)}/${seriesId}/video-target`,
      { method: "POST", body: JSON.stringify({ videoTarget }) },
    ),
  setSeriesAudioMix: (instanceId: string, seriesId: number, audioMix: "stereo" | "surround" | null) =>
    req<{ audioMix: "stereo" | "surround" | null; healthyCount: number; suggestionCount: number }>(
      `/api/library/series/${encodeURIComponent(instanceId)}/${seriesId}/audio-mix`,
      { method: "POST", body: JSON.stringify({ audioMix }) },
    ),
  optimizeShow: (instanceId: string, seriesId: number, assignedNodeId?: string) =>
    req(`/api/library/series/${encodeURIComponent(instanceId)}/${seriesId}/optimize`, {
      method: "POST",
      body: JSON.stringify({ assignedNodeId }),
    }),
  saveNode: (id: string, body: { concurrency?: number; enabled?: boolean }) =>
    req<{ ok: true; node: ClusterNode }>(`/api/nodes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  assignJob: (id: string, nodeId: string) =>
    req(`/api/jobs/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify({ nodeId }) }),
  exclusions: () => req<{ exclusions: Exclusion[] }>("/api/exclusions"),
  addExclusion: (kind: Exclusion["kind"], value: string) =>
    req<{ exclusions: Exclusion[] }>("/api/exclusions", { method: "POST", body: JSON.stringify({ kind, value }) }),
  deleteExclusion: (id: string) => req<{ exclusions: Exclusion[] }>(`/api/exclusions/${id}`, { method: "DELETE" }),
};

export type LibraryPage<T> = {
  items: T[];
  nextOffset: number | null;
  total: number;
  pendingCount?: number;
  finishedCount?: number;
  healthyCount?: number;
  suggestionCount?: number;
};
export type SeriesSummary = {
  id: string;
  key: string;
  instanceId: string;
  instanceName: string;
  arrSeriesId: number;
  showTitle: string;
  episodeCount: number;
  healthyCount: number;
  suggestionCount: number;
  videoTarget?: "hevc" | "av1" | null;
  audioMix?: "stereo" | "surround" | null;
};

export type FirstRun = { hasAdmin: boolean; languageConfirmed: boolean; hasReviewPath: boolean; hasArr: boolean; complete: boolean };
export type HardwareBackend = "cuda" | "vaapi" | "none";
export type Hardware = { backend: HardwareBackend; cuda: boolean; vaapi: boolean; av1: boolean; reason: string | null; vaapiDevice?: string | null };
export type ClusterNode = {
  id: string;
  name: string;
  role: "standalone" | "master" | "worker";
  roleLabel: string;
  thisNode: boolean;
  lastSeen: number;
  hardware: Hardware;
  hardwareLabel: string;
  concurrency: number;
  enabled: boolean;
  version: string;
  currentJobId: string | null;
  online: boolean;
};
export type WorkerStatus = {
  role: "worker";
  name: string;
  nodeId: string;
  masterUrl: string | null;
  version: string;
  hardware: Hardware;
  hardwareLabel: string;
  status: "misconfigured" | "connecting" | "connected" | "unreachable" | "rejected";
  detail: string;
  currentJobId: string | null;
};
export type NodesPayload = {
  thisNodeId: string;
  defaultEncodeNodeId: string;
  av1Available?: boolean;
  nodes: ClusterNode[];
};
export type SettingsPayload = {
  preferredLanguage: string;
  languageConfirmed: boolean;
  reviewPath: string;
  sizeCaps: Record<string, number>;
  suggestionDefaults: {
    removeNonPreferredSubtitles: boolean;
    removeNonPreferredAudio: boolean;
    addStereo: boolean;
    transcodeToSizeCap: boolean;
    transcodeBelowHevc: boolean;
    convertMp4ToMkv: boolean;
    convertIsoToMkv: boolean;
    searchPreferredLanguage: boolean;
    queueNewImports: boolean;
  };
  videoTarget: "hevc" | "av1";
  concurrency: number;
  conservativeMode: boolean;
  offPeakEnabled: boolean;
  offPeakStart: string;
  offPeakEnd: string;
  localAuthBypass: boolean;
  writeMode: "sidecar" | "direct";
  profileAutoAssign: boolean;
  hasWebhookToken?: boolean;
  hasWidgetKey?: boolean;
  hasClusterToken?: boolean;
  defaultEncodeNodeId?: string;
  thisNodeId?: string;
  username?: string;
  instances: Array<{ id: string; kind: "radarr" | "sonarr" | "plex" | "jellyfin"; name: string; url: string; enabled: boolean; hasApiKey?: boolean; hasToken?: boolean }>;
  firstRun: FirstRun;
  profilePreviews?: Array<{ category: string; name: string; gbPerHour: number; mbPerMin: number }>;
};
export type LibraryRow = {
  id: string;
  instanceId: string;
  arrSeriesId?: number | null;
  displayTitle: string;
  sharedFileLabel?: string | null;
  title?: string;
  instanceName: string;
  type: "movie" | "episode";
  showTitle: string | null;
  quality: string;
  path: string;
  sizeBytes: number;
  sizeExempt: boolean;
  videoTarget?: "hevc" | "av1" | null;
  inspected: boolean;
  mediaState?: "waiting" | "unreadable" | "inspected";
  hasPoster: boolean;
  error: string | null;
  reasons: string[];
  suggestion: { id: string; actions: string[]; reasons: string[] } | null;
  href?: string;
  listingState?: string | null;
  sourceMethod?: string | null;
  videoLabel?: string | null;
  audioLabels?: string[];
  subtitleLabels?: string[];
  trackEditingAvailable?: boolean;
  report?: InspectionReport | null;
  width?: number;
  height?: number;
  resolution?: string;
};
export type SuggestionRow = {
  id: string;
  itemId: string;
  displayTitle: string;
  instanceName?: string;
  type?: "movie" | "episode";
  href?: string;
  reasons: string[];
  warning: string | null;
  estimatedSavingsBytes: number | null;
  now: { codec: string | null; quality: string | null; sizeBytes: number | null; sizePerHourGb: number | null; tracks: string[] };
  after: { codec: string | null; quality: string | null; sizeBytes: number | null; sizePerHourGb: number | null; tracks: string[] };
};
export type SuggestionFilters = {
  type?: "movie" | "episode";
  resolution?: "1080p" | "4k";
  hdr?: "hdr" | "sdr";
  codec?: "h264" | "hevc" | "av1";
  overCap?: boolean;
  extraTracks?: boolean;
  exempt?: boolean;
  hardwareWarning?: boolean;
};
export type Exclusion = { id: string; kind: "path" | "profile" | "tag" | "title"; value: string };
export type JobRow = {
  id: string;
  displayTitle: string;
  href?: string;
  status: "queued" | "held" | "paused" | "running" | "succeeded" | "failed" | "cancelled";
  phase: "queued" | "held" | "paused" | "copying" | "muxing" | "creating_stereo" | "transcoding" | "finishing" | "idle";
  progress: number;
  error: string | null;
  warning: string | null;
  promoteError: string | null;
  writeMode?: "sidecar" | "direct";
  plan?: { video?: { kind?: "copy" | "size" | "quality"; codec?: "hevc" | "av1" }; reasons?: string[]; writeMode?: "sidecar" | "direct" };
  assignedNodeId?: string | null;
  assignedNodeName?: string | null;
  waitingForNode?: boolean;
};
export type ReviewRow = {
  id: string;
  displayTitle: string;
  status: "pending" | "keeping" | "discarding";
  flagged: boolean;
  flagReason: string | null;
  source: { codec: string | null; sizeBytes: number | null; sizePerHourGb: number | null; durationSec: number; tracks: string };
  sidecar: { codec: string | null; sizeBytes: number | null; sizePerHourGb: number | null; durationSec: number; tracks: string };
  error: string | null;
};
export type HistoryRow = { id: string; displayTitle: string; outcome: "kept" | "discarded" | "flagged" | "failed" | "cancelled" | "searched"; bytesSaved: number; createdAt: number };
export type HomePayload = {
  filesOptimized: number;
  spaceSavedBytes: number;
  suggestions: number;
  queued: number;
  queueActive?: number;
  review: number;
  errors: number;
  recent: HistoryRow[];
  status: string;
};

export type ListingState = "complete" | "iso_unlisted";
export type SourceMethod = "ffprobe" | "iso_ffmpeg";
export type FileError = {
  itemId: string | null;
  path: string;
  fileName: string;
  displayTitle: string;
  reason: string;
  type?: "movie" | "episode";
  href?: string;
};
export type InspectState = { walking: boolean; pending: number; inspected: number; failed: number };
export type SearchHit = { itemId: string; type: "movie" | "episode"; displayTitle: string; instanceName: string; href: string };
export type InspectionReport = {
  listingState: ListingState | string;
  sourceMethod: SourceMethod | string;
  videoCodec: string;
  width: number;
  height: number;
  bitDepth: number;
  hdr: string;
  sizeBytes: number;
  durationSec: number;
  sizePerHourGb?: number;
  audio: Array<{ index: number; language: string; channels: number; codec: string; title: string; untagged?: boolean }>;
  subtitles: Array<{ index: number; language: string; codec: string; title: string; sdh?: boolean; forced?: boolean; untagged?: boolean }>;
};
export type ExecutablePlan = {
  reasons: string[];
  warning: string | null;
  estimatedOutputBytes: number | null;
  video: { kind: "copy" | "size" | "quality" };
};

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return "—";
  const total = Math.round(sec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatGbHour(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value.toFixed(2)} GB/hr`;
}
