export type ArrKind = "radarr" | "sonarr";
export type PlayerKind = "plex" | "jellyfin";
export type MediaType = "movie" | "episode";
export type JobStatus = "queued" | "held" | "paused" | "running" | "succeeded" | "failed" | "cancelled";
export type JobPhase =
  | "queued"
  | "held"
  | "paused"
  | "copying"
  | "muxing"
  | "creating_stereo"
  | "transcoding"
  | "finishing"
  | "idle";
export type ReviewStatus = "pending" | "keeping" | "discarding";
export type SizeCategory = "movie1080p" | "movie4kSdr" | "movie4kHdr" | "tv1080p" | "tv4k";
export type SuggestionAction = "transcode" | "remux" | "tracks" | "add_stereo" | "search_language";
export type VideoTarget = "hevc" | "av1";

export function parseVideoTarget(value: unknown): VideoTarget | null {
  return value === "hevc" || value === "av1" ? value : null;
}

export type AudioMix = "stereo" | "surround";

export function parseAudioMix(value: unknown): AudioMix | null {
  return value === "stereo" || value === "surround" ? value : null;
}
export type HardwareBackend = "cuda" | "vaapi" | "none";
export type ActivityOutcome = "kept" | "discarded" | "flagged" | "failed" | "cancelled" | "searched";
export type ExclusionKind = "path" | "profile" | "tag" | "title";

export type SizeCaps = {
  movie1080p: number;
  movie4kSdr: number;
  movie4kHdr: number;
  tv1080p: number;
  tv4k: number;
};

export type SuggestionDefaults = {
  removeNonPreferredSubtitles: boolean;
  removeNonPreferredAudio: boolean;
  addStereo: boolean;
  transcodeToSizeCap: boolean;
  /** Copy and suggestion predicate follow Encode Target; the stored key is historical. */
  transcodeBelowHevc: boolean;
  convertMp4ToMkv: boolean;
  convertIsoToMkv: boolean;
  searchPreferredLanguage: boolean;
  queueNewImports: boolean;
};

export const DEFAULT_SIZE_CAPS: SizeCaps = {
  movie1080p: 2.5,
  movie4kSdr: 6,
  movie4kHdr: 8,
  tv1080p: 1.0,
  tv4k: 4.0,
};

export const DEFAULT_SUGGESTION_DEFAULTS: SuggestionDefaults = {
  removeNonPreferredSubtitles: true,
  removeNonPreferredAudio: true,
  addStereo: true,
  transcodeToSizeCap: true,
  transcodeBelowHevc: false,
  convertMp4ToMkv: false,
  convertIsoToMkv: false,
  searchPreferredLanguage: false,
  queueNewImports: false,
};

export type Settings = {
  preferredLanguage: string;
  languageConfirmed: boolean;
  reviewPath: string;
  sizeCaps: SizeCaps;
  suggestionDefaults: SuggestionDefaults;
  videoTarget: VideoTarget;
  concurrency: number;
  conservativeMode: boolean;
  offPeakEnabled: boolean;
  offPeakStart: string;
  offPeakEnd: string;
  localAuthBypass: boolean;
  inspectConcurrency: number;
  writeMode: WriteMode;
  profileAutoAssign: boolean;
  queueNewImportsSince: number;
  /** Empty means this machine. Set when a second encode node exists. */
  defaultEncodeNodeId: string;
};

export const DEFAULT_SETTINGS: Settings = {
  preferredLanguage: "eng",
  languageConfirmed: false,
  reviewPath: "",
  sizeCaps: { ...DEFAULT_SIZE_CAPS },
  suggestionDefaults: { ...DEFAULT_SUGGESTION_DEFAULTS },
  videoTarget: "hevc",
  concurrency: 1,
  conservativeMode: false,
  offPeakEnabled: false,
  offPeakStart: "01:00",
  offPeakEnd: "07:00",
  localAuthBypass: false,
  inspectConcurrency: 1,
  writeMode: "sidecar",
  profileAutoAssign: true,
  queueNewImportsSince: 0,
  defaultEncodeNodeId: "",
};

export type ArrInstance = {
  id: string;
  kind: ArrKind;
  name: string;
  url: string;
  enabled: boolean;
  hasApiKey: boolean;
};

export type PlayerInstance = {
  id: string;
  kind: PlayerKind;
  name: string;
  url: string;
  enabled: boolean;
  hasToken: boolean;
};

export type AudioTrack = {
  index: number;
  language: string;
  channels: number;
  codec: string;
  title: string;
  untagged: boolean;
  commentary: boolean;
  languagePending?: boolean;
  bitrateBps?: number;
  sizeBytes?: number;
  default?: boolean;
};

export type SubtitleTrack = {
  index: number;
  language: string;
  codec: string;
  title: string;
  untagged: boolean;
  forced: boolean;
  sdh: boolean;
  languagePending?: boolean;
  bitrateBps?: number;
  sizeBytes?: number;
  default?: boolean;
  hearingImpaired?: boolean;
};

export type InspectionReport = {
  sourceSig: string;
  sourceMethod: "ffprobe" | "iso_ffmpeg";
  listingState: "complete" | "iso_unlisted";
  durationSec: number;
  isoPlaylist?: number | null;
  sizeBytes: number;
  sizePerHourGb: number;
  videoCodec: string;
  videoIndex?: number;
  width: number;
  height: number;
  bitDepth: number;
  hdr: "none" | "hdr10" | "hdr10plus" | "dolby_vision";
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  hasChapters: boolean;
  hasAttachments: boolean;
  attachmentBytes?: number;
  chapterCount?: number;
};

export type SuggestionNowAfter = {
  codec: string | null;
  quality: string | null;
  sizeBytes: number | null;
  sizePerHourGb: number | null;
};

export type Suggestion = {
  id: string;
  itemId: string;
  actions: SuggestionAction[];
  reasons: string[];
  warning: string | null;
  category: SizeCategory;
  estimatedSavingsBytes: number | null;
  now: SuggestionNowAfter;
  after: SuggestionNowAfter;
  dismissed: boolean;
  keepAudio: number[];
  keepAudioLanguages?: Record<string, string>;
  stripAudio: number[];
  keepSubs: number[];
  stripSubs: number[];
  /** Stream index to downmix when add_stereo is set. Missing means the first kept audio track. */
  stereoSource?: number;
  /** When false, the job may skip video encode after mux if remaining size meets the cap or kept audio fills it. Missing means encode (older jobs). */
  mustEncode?: boolean;
};

export type LibraryItem = {
  id: string;
  instanceId: string;
  instanceName: string;
  arrId: number;
  arrSeriesId: number | null;
  arrEpisodeFileId: number | null;
  type: MediaType;
  title: string;
  showTitle: string | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  path: string;
  sizeBytes: number;
  quality: string;
  resolution: string;
  profile: string;
  tags: string[];
  posterRemoteUrl: string | null;
  hasPoster: boolean;
  sizeExempt: boolean;
  videoTarget?: VideoTarget | null;
  firstSeenAt?: number;
  fileChangedAt?: number;
  keptSizeBytes?: number;
};

export type FileError = {
  itemId: string | null;
  path: string;
  fileName: string;
  displayTitle: string;
  reason: string;
  type?: "movie" | "episode";
  href?: string;
};

export type Job = {
  id: string;
  itemId: string;
  suggestionId: string | null;
  displayTitle: string;
  href?: string;
  status: JobStatus;
  phase: JobPhase;
  progress: number;
  error: string | null;
  warning: string | null;
  runNow: boolean;
  createdAt: number;
  writeMode: WriteMode;
  promoteError: string | null;
  assignedNodeId: string | null;
  nodeId: string | null;
  assignedNodeName?: string | null;
  waitingForNode?: boolean;
};

export type ReviewItem = {
  id: string;
  jobId: string;
  itemId: string;
  displayTitle: string;
  status: ReviewStatus;
  flagged: boolean;
  flagReason: string | null;
  sourcePath: string;
  sidecarPath: string;
  source: SuggestionNowAfter & { durationSec: number; tracks: string };
  sidecar: SuggestionNowAfter & { durationSec: number; tracks: string };
  error: string | null;
};

export type HistoryRow = {
  id: string;
  itemId: string;
  displayTitle: string;
  outcome: ActivityOutcome;
  bytesSaved: number;
  createdAt: number;
};

export type HardwareInfo = {
  backend: HardwareBackend;
  cuda: boolean;
  vaapi: boolean;
  av1: boolean;
  reason: string | null;
  vaapiDevice?: string | null;
};

export type HomePayload = {
  filesOptimized: number;
  spaceSavedBytes: number;
  suggestions: number;
  queued: number;
  review: number;
  errors: number;
  recent: HistoryRow[];
  status: string;
};

export type WidgetPayload = {
  status: string;
  queued: number;
  review: number;
  suggestions: number;
  failed: number;
  runningTitle: string | null;
  runningPhase: JobPhase | null;
  runningProgress: number | null;
};

export type SearchHit = {
  itemId: string;
  type: MediaType;
  displayTitle: string;
  instanceName: string;
  href: string;
};

export type PlanOrigin = "bulk" | "custom";
export type WriteMode = "sidecar" | "direct";
export type OutputContainer = "mkv";

export type VideoCopy = { kind: "copy" };
export type VideoSizeTranscode = {
  kind: "size";
  codec: VideoTarget;
  targetBytes: number;
  downscale1080p: boolean;
  bitDepth: number;
  /** False: bulk size-cap encode that may be skipped after mux. Missing/true: encode must run (codec, Force, or custom). */
  mustEncode?: boolean;
};
export type VideoQualityTranscode = {
  kind: "quality";
  codec: VideoTarget;
  quality: number;
  downscale1080p: boolean;
  bitDepth: number;
};
export type VideoIntent = VideoCopy | VideoSizeTranscode | VideoQualityTranscode;

export type AudioKeep = { op: "keep"; index: number; language?: string };
export type AudioRemove = { op: "remove"; index: number };
export type AudioReplaceAac = { op: "replace_aac"; index: number };
export type AudioReplaceDownmix = { op: "replace_downmix"; index: number; channels: number };
export type AudioAddDownmix = { op: "add_downmix"; index: number; channels: number };
export type AudioOp = AudioKeep | AudioRemove | AudioReplaceAac | AudioReplaceDownmix | AudioAddDownmix;

export type SubtitleKeep = { op: "keep"; index: number; language?: string };
export type SubtitleRemove = { op: "remove"; index: number };
export type SubtitleOp = SubtitleKeep | SubtitleRemove;

export function keepWritesLanguage(op: AudioOp | SubtitleOp): boolean {
  return op.op === "keep" && Boolean(op.language) && op.language !== "und";
}

export type ExecutablePlan = {
  origin: PlanOrigin;
  video: VideoIntent;
  audio: AudioOp[];
  subtitles: SubtitleOp[];
  container: OutputContainer;
  // Jobs saved before MP4 conversion omit this field and retain the old encode path.
  remuxInput?: boolean;
  writeMode: WriteMode;
  /** When true, Keep this write mode even if Settings later change. Queue new Arr imports locks sidecar. */
  writeModeLocked?: boolean;
  warning: string | null;
  reasons: string[];
  estimatedOutputBytes: number | null;
  category: SizeCategory;
};

export function planHasVideoTranscode(plan: ExecutablePlan): boolean {
  return plan.video.kind !== "copy";
}

export function effectiveWriteMode(plan: ExecutablePlan, house: WriteMode): WriteMode {
  if (plan.writeModeLocked === true) return plan.writeMode;
  if (plan.writeModeLocked === false) return house;
  if (plan.origin === "custom") return plan.writeMode;
  return house;
}

export function profileAssignmentEligible(opts: {
  autoAssign: boolean;
  sizeExempt: boolean;
  plan: ExecutablePlan;
}): boolean {
  return opts.autoAssign && !opts.sizeExempt && planHasVideoTranscode(opts.plan);
}

export type CustomAudioAction = "keep" | "remove" | "replace_aac" | "replace_downmix" | "add_downmix";
export type CustomAudioChoice = {
  index: number;
  action: CustomAudioAction;
  channels?: number;
};
export type CustomSubtitleChoice = {
  index: number;
  action: "keep" | "remove";
};
export type CustomVideoDraft =
  | { mode: "copy"; downscale1080p?: boolean }
  | { mode: "size"; targetBytes: number; codec?: VideoTarget; downscale1080p?: boolean }
  | { mode: "quality"; quality: number; codec?: VideoTarget; downscale1080p?: boolean };
export type CustomPlanDraft = {
  remuxToMkv?: boolean;
  video?: CustomVideoDraft;
  audio?: CustomAudioChoice[];
  subtitles?: CustomSubtitleChoice[];
  writeMode?: WriteMode | "default";
};
export type PlanFieldError = { field: string; message: string };
export type CustomPlanOk = { ok: true; plan: ExecutablePlan };
export type CustomPlanFail = { ok: false; errors: PlanFieldError[] };
export type CustomPlanResult = CustomPlanOk | CustomPlanFail;
