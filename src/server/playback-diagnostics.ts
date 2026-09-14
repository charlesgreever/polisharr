import { createHash } from "node:crypto";
import { languageDisplayName } from "./language-id.ts";
import { observationSummary, statPlaybackRevision } from "./playback-monitor.ts";
import { transcodeReasonFamilies } from "./jellyfin-playback.ts";
import { normalizeLang } from "./inspect.ts";
import type { Store } from "./store.ts";
import type {
  AudioTrack,
  CustomPlanDraft,
  InspectionReport,
  LibraryItem,
  PlaybackAfterKeep,
  PlaybackDiagnostic,
  PlaybackDismissal,
  PlaybackFileRevision,
  PlaybackOccurrence,
  PlaybackReasonFamily,
  PlaybackRecommendation,
  PlaybackRecommendationKind,
  Suggestion,
} from "./types.ts";
import {
  AFTER_KEEP_NOT_YET,
  AFTER_KEEP_OBSERVED,
  PLAYBACK_DIAGNOSTIC_DAYS,
  PLAYBACK_HISTORY_DAYS,
  PLAYBACK_HISTORY_MAX,
  PLAYBACK_REASON_FAMILIES,
} from "./types.ts";

export type PlaybackListQuery = {
  offset: number;
  limit: number;
  days: number;
  connectionId?: string;
  deviceId?: string;
  client?: string;
  reasonFamily?: PlaybackReasonFamily;
  title?: string;
  itemId?: string;
  unmatched?: boolean;
};

export type PlaybackListResult<T> = {
  items: T[];
  total: number;
  nextOffset: number | null;
  windowDays: number;
  windowStartAt: number;
};

export type PlaybackRepairDraft = {
  diagnosticId: string;
  itemId: string;
  href: string;
  explanation: string;
  kind: PlaybackRecommendationKind;
  draft: CustomPlanDraft;
  revision: PlaybackFileRevision | null;
};

export type PlaybackEvidenceError = { error: string; status: 400 | 404 | 409 };

export type PlaybackTitleSummary = {
  windowDays: number;
  observations: Array<PlaybackOccurrence & { summary: string }>;
  afterKeep: PlaybackAfterKeep;
  problemCount: number;
};

export type PlaybackDiagnostics = {
  listDiagnostics(query: PlaybackListQuery): PlaybackListResult<PlaybackDiagnostic>;
  listObservations(query: PlaybackListQuery): PlaybackListResult<PlaybackOccurrence & { summary: string }>;
  dismiss(id: string): { ok: true } | PlaybackEvidenceError;
  repairDraft(id: string): Promise<{ ok: true; repair: PlaybackRepairDraft } | PlaybackEvidenceError>;
  revalidate(id: string): Promise<{ ok: true; diagnostic: PlaybackDiagnostic; item: LibraryItem; report: InspectionReport } | PlaybackEvidenceError>;
  titleSummary(itemId: string): PlaybackTitleSummary;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function isPlaybackProblem(row: PlaybackOccurrence): boolean {
  if (row.playMethod === "DirectPlay") return false;
  if (row.gap && !row.playMethod && row.rawReasons.length === 0) return false;
  return true;
}

export function problemReasonFamily(row: PlaybackOccurrence): PlaybackReasonFamily | null {
  if (!isPlaybackProblem(row)) return null;
  const family = row.reasonFamily;
  if (family && (PLAYBACK_REASON_FAMILIES as readonly string[]).includes(family)) {
    return family as PlaybackReasonFamily;
  }
  return "unknown";
}

export function playbackDiagnosticId(input: {
  connectionId: string;
  deviceId: string;
  reasonFamily: string;
  match: string;
  libraryItemIds: string[];
  revision: PlaybackFileRevision | null;
  path: string | null;
  jellyfinItemId: string;
}): string {
  const revisionPart = input.revision
    ? `${input.revision.canonicalPath}|${nullish(input.revision.sizeBytes)}|${nullish(input.revision.mtimeMs)}|${input.revision.fileId ?? ""}`
    : `nomatch|${input.path ?? ""}|${input.jellyfinItemId}`;
  const key = [
    input.connectionId,
    input.deviceId,
    input.reasonFamily,
    input.match,
    [...input.libraryItemIds].sort().join(","),
    revisionPart,
  ].join("\0");
  return createHash("sha256").update(key).digest("hex");
}

export function revisionsMatch(left: PlaybackFileRevision | null, right: PlaybackFileRevision | null): boolean {
  if (!left || !right) return false;
  return left.canonicalPath === right.canonicalPath
    && left.sizeBytes === right.sizeBytes
    && left.mtimeMs === right.mtimeMs
    && left.fileId === right.fileId;
}

export function parsePlaybackListQuery(
  query: Record<string, string | undefined>,
  defaults: { days: number },
): { ok: true; value: PlaybackListQuery } | { ok: false; error: string } {
  const daysRaw = query.days;
  let days = defaults.days;
  if (daysRaw != null && daysRaw !== "") {
    if (daysRaw !== "7" && daysRaw !== "30") {
      return { ok: false, error: "The date window must be 7 or 30 days." };
    }
    days = Number(daysRaw);
  }
  const familyRaw = query.reasonFamily;
  let reasonFamily: PlaybackReasonFamily | undefined;
  if (familyRaw != null && familyRaw !== "") {
    if (!(PLAYBACK_REASON_FAMILIES as readonly string[]).includes(familyRaw)) {
      return { ok: false, error: "That reason family is not valid." };
    }
    reasonFamily = familyRaw as PlaybackReasonFamily;
  }
  const unmatched = query.unmatched;
  if (unmatched != null && unmatched !== "" && unmatched !== "1" && unmatched !== "0") {
    return { ok: false, error: "Unmatched must be 1 or 0." };
  }
  const offset = parseCount(query.offset, 0);
  const limit = parseCount(query.limit, 50);
  if (offset == null || limit == null) return { ok: false, error: "Page offset and limit must be whole numbers." };
  return {
    ok: true,
    value: {
      offset,
      limit: Math.min(Math.max(limit, 1), 100),
      days,
      connectionId: emptyToUndef(query.connectionId),
      deviceId: emptyToUndef(query.deviceId),
      client: emptyToUndef(query.client),
      reasonFamily,
      title: emptyToUndef(query.title),
      itemId: emptyToUndef(query.itemId),
      unmatched: unmatched === "1" ? true : unmatched === "0" ? false : undefined,
    },
  };
}

export function familiesFromEvidence(family: PlaybackReasonFamily, rawReasons: string[]): PlaybackReasonFamily[] {
  const fromReasons = transcodeReasonFamilies(rawReasons).filter((row): row is PlaybackReasonFamily =>
    (PLAYBACK_REASON_FAMILIES as readonly string[]).includes(row)
  );
  if (fromReasons.length > 0) return fromReasons;
  if (family === "mixed") return [];
  return [family];
}

export function recommendPlaybackRepair(input: {
  family: PlaybackReasonFamily;
  rawReasons: string[];
  selectedTracks: PlaybackOccurrence["selectedTracks"];
  match: PlaybackOccurrence["match"];
  path: string | null;
  report: InspectionReport | null;
  preferredLanguage: string;
  suggestion: Suggestion | null;
  excluded: boolean;
}): PlaybackRecommendation {
  if (input.match !== "matched") {
    return none("This playback did not match a library file. Repair stays off until the path matches.");
  }
  if (input.excluded) {
    return none("This title is excluded. Playback repair stays off until you remove the exclusion.");
  }
  const families = new Set(familiesFromEvidence(input.family, input.rawReasons));
  const parts: PlaybackRecommendation[] = [];
  if (families.has("audio")) parts.push(audioRecommendation(input));
  if (families.has("bitrate")) parts.push(bitrateRecommendation(input.suggestion));
  if (families.has("video")) parts.push(videoRecommendation(input.rawReasons));
  if (families.has("subtitle")) {
    parts.push(subtitleRecommendation(input.rawReasons, input.report, input.selectedTracks.subtitleStreamIndex));
  }
  if (families.has("container")) parts.push(containerRecommendation(input.path));
  if (parts.length === 0) return noneFromReasons(input.rawReasons);
  return mergeRecommendations(parts);
}

export function describeAfterKeep(input: {
  keptAt: number | null;
  deviceId: string;
  before: PlaybackOccurrence;
  later: PlaybackOccurrence[];
}): PlaybackAfterKeep {
  if (input.keptAt == null) return { status: "none", sentence: null };
  const later = input.later
    .filter((row) => row.deviceId === input.deviceId && row.lastSeenAt >= input.keptAt!)
    .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  if (later.length === 0) return { status: "not_yet_observed", sentence: AFTER_KEEP_NOT_YET };
  const qualifying = later.find((row) => row.playMethod === "DirectPlay" && contextCompatible(input.before, row));
  if (qualifying) return { status: "observed_direct", sentence: AFTER_KEEP_OBSERVED };
  const changed = later.find((row) => row.playMethod === "DirectPlay" && !contextCompatible(input.before, row));
  if (changed) {
    return { status: "context_changed", sentence: contextChangeSentence(input.before, changed) };
  }
  return { status: "not_yet_observed", sentence: AFTER_KEEP_NOT_YET };
}

export function createPlaybackDiagnostics(opts: {
  store: Store;
  clock?: () => number;
  statFile?: (path: string) => Promise<PlaybackFileRevision | null>;
  isExcluded?: (item: LibraryItem) => boolean;
}): PlaybackDiagnostics {
  const store = opts.store;
  const now = () => opts.clock?.() ?? Date.now();
  const statFile = opts.statFile ?? statPlaybackRevision;
  const isExcluded = opts.isExcluded ?? (() => false);

  function windowStart(days: number): number {
    return now() - days * DAY_MS;
  }

  function occurrencesFor(query: PlaybackListQuery): PlaybackOccurrence[] {
    return store.queryPlaybackOccurrences({
      connectionId: query.connectionId,
      deviceId: query.deviceId,
      unmatched: query.unmatched,
      libraryItemId: query.itemId,
      since: windowStart(query.days),
      limit: PLAYBACK_HISTORY_MAX,
    }).filter((row) =>
      matchesClient(row, query.client)
      && matchesTitle(store, row, query.title)
      && occurrenceMatchesFamily(row, query.reasonFamily)
    );
  }

  function diagnosticFromGroup(rows: PlaybackOccurrence[]): PlaybackDiagnostic {
    const latest = rows[0]!;
    const family = problemReasonFamily(latest) ?? "unknown";
    const item = firstItem(store, latest.libraryItemIds);
    const report = item ? store.getInspection(item.id) ?? null : null;
    const suggestion = item ? store.openSuggestionForItem(item.id) ?? null : null;
    const excluded = item ? isExcluded(item) : false;
    const id = playbackDiagnosticId({
      connectionId: latest.connectionId,
      deviceId: latest.deviceId,
      reasonFamily: family,
      match: latest.match,
      libraryItemIds: latest.libraryItemIds,
      revision: latest.revision,
      path: latest.path,
      jellyfinItemId: latest.itemId,
    });
    const keptAt = store.lastKeptAtForItems(latest.libraryItemIds);
    const later = keptAt == null
      ? []
      : store.queryPlaybackOccurrences({
        deviceId: latest.deviceId,
        since: keptAt,
        limit: PLAYBACK_HISTORY_MAX,
      }).filter((row) => row.libraryItemIds.some((id) => latest.libraryItemIds.includes(id)));
    return {
      id,
      connectionId: latest.connectionId,
      connectionName: store.getInstance(latest.connectionId)?.name ?? "",
      deviceId: latest.deviceId,
      deviceLabel: latest.deviceLabel,
      itemName: latest.itemName,
      libraryItemIds: latest.libraryItemIds,
      itemId: item?.id ?? null,
      href: item ? itemHref(item) : null,
      jellyfinItemId: latest.itemId,
      reasonFamily: family,
      summary: observationSummary(latest),
      rawReasons: unique(rows.flatMap((row) => row.rawReasons)),
      playMethod: latest.playMethod,
      match: latest.match,
      occurrenceCount: rows.length,
      lastSeenAt: latest.lastSeenAt,
      startedAt: Math.min(...rows.map((row) => row.startedAt)),
      revision: latest.revision,
      path: latest.path,
      selectedTracks: latest.selectedTracks,
      recommendation: recommendPlaybackRepair({
        family,
        rawReasons: unique(rows.flatMap((row) => row.rawReasons)),
        selectedTracks: latest.selectedTracks,
        match: latest.match,
        path: latest.path,
        report,
        preferredLanguage: store.getSettings().preferredLanguage,
        suggestion,
        excluded,
      }),
      afterKeep: describeAfterKeep({
        keptAt,
        deviceId: latest.deviceId,
        before: latest,
        later,
      }),
    };
  }

  function groupedProblems(query: PlaybackListQuery): PlaybackDiagnostic[] {
    const groups = new Map<string, PlaybackOccurrence[]>();
    for (const row of occurrencesFor(query)) {
      if (!isPlaybackProblem(row)) continue;
      const family = problemReasonFamily(row);
      if (!family) continue;
      if (query.reasonFamily && !occurrenceMatchesFamily(row, query.reasonFamily)) continue;
      const id = playbackDiagnosticId({
        connectionId: row.connectionId,
        deviceId: row.deviceId,
        reasonFamily: family,
        match: row.match,
        libraryItemIds: row.libraryItemIds,
        revision: row.revision,
        path: row.path,
        jellyfinItemId: row.itemId,
      });
      const list = groups.get(id) ?? [];
      list.push(row);
      groups.set(id, list);
    }
    const dismissed = new Set(store.listPlaybackDismissals().map((row) => row.id));
    const diagnostics: PlaybackDiagnostic[] = [];
    for (const rows of groups.values()) {
      rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.id.localeCompare(a.id));
      const diagnostic = diagnosticFromGroup(rows);
      if (dismissed.has(diagnostic.id)) continue;
      diagnostics.push(diagnostic);
    }
    diagnostics.sort((a, b) =>
      b.occurrenceCount - a.occurrenceCount
      || b.lastSeenAt - a.lastSeenAt
      || a.id.localeCompare(b.id)
    );
    return diagnostics;
  }

  function findDiagnostic(id: string): PlaybackDiagnostic | undefined {
    return groupedProblems({
      offset: 0,
      limit: PLAYBACK_HISTORY_MAX,
      days: PLAYBACK_HISTORY_DAYS,
    }).concat(groupedIncludingDismissed(id)).find((row) => row.id === id);
  }

  function groupedIncludingDismissed(id: string): PlaybackDiagnostic[] {
    const dismissal = store.getPlaybackDismissal(id);
    if (!dismissal) return [];
    const rows = store.queryPlaybackOccurrences({
      connectionId: dismissal.connectionId,
      deviceId: dismissal.deviceId,
      limit: PLAYBACK_HISTORY_MAX,
    }).filter((row) => {
      const family = problemReasonFamily(row);
      if (!family) return false;
      return playbackDiagnosticId({
        connectionId: row.connectionId,
        deviceId: row.deviceId,
        reasonFamily: family,
        match: row.match,
        libraryItemIds: row.libraryItemIds,
        revision: row.revision,
        path: row.path,
        jellyfinItemId: row.itemId,
      }) === id;
    });
    if (rows.length === 0) return [];
    rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.id.localeCompare(a.id));
    return [diagnosticFromGroup(rows)];
  }

  async function revalidate(id: string): Promise<{ ok: true; diagnostic: PlaybackDiagnostic; item: LibraryItem; report: InspectionReport } | PlaybackEvidenceError> {
    const diagnostic = findDiagnostic(id);
    if (!diagnostic) return { error: "That playback problem does not exist.", status: 404 };
    if (diagnostic.match !== "matched" || !diagnostic.itemId) {
      return { error: "This playback did not match a library file. Repair stays off until the path matches.", status: 400 };
    }
    const item = store.getItem(diagnostic.itemId);
    if (!item) return { error: "That title is not in the library.", status: 404 };
    if (isExcluded(item)) {
      return { error: "This title is excluded. Playback repair stays off until you remove the exclusion.", status: 409 };
    }
    const report = store.getInspection(item.id);
    if (!report) return { error: "This file has not been inspected yet, or the path is unreadable.", status: 400 };
    const current = diagnostic.path ? await statFile(diagnostic.path) : null;
    if (!revisionsMatch(diagnostic.revision, current)) {
      return { error: "The file has changed since this playback was observed. Inspect it again before opening a repair plan.", status: 409 };
    }
    return { ok: true, diagnostic, item, report };
  }

  return {
    listDiagnostics(query) {
      const all = groupedProblems(query);
      return pageWindow(all, query, windowStart(query.days));
    },
    listObservations(query) {
      const items = occurrencesFor(query).map((row) => ({ ...row, summary: observationSummary(row) }));
      return pageWindow(items, query, windowStart(query.days));
    },
    dismiss(id) {
      const diagnostic = findDiagnostic(id) ?? groupedIncludingDismissed(id)[0];
      if (!diagnostic) return { error: "That playback problem does not exist.", status: 404 };
      store.savePlaybackDismissal({
        id: diagnostic.id,
        connectionId: diagnostic.connectionId,
        deviceId: diagnostic.deviceId,
        reasonFamily: diagnostic.reasonFamily,
        revision: diagnostic.revision,
        match: diagnostic.match,
        libraryItemIds: diagnostic.libraryItemIds,
        path: diagnostic.path,
        jellyfinItemId: diagnostic.jellyfinItemId,
        dismissedAt: now(),
      });
      return { ok: true };
    },
    async repairDraft(id) {
      const checked = await revalidate(id);
      if (!("ok" in checked)) return checked;
      const rec = checked.diagnostic.recommendation;
      if (!rec.canRepair || !rec.draft || !checked.diagnostic.href) {
        return { error: rec.explanation, status: 400 };
      }
      return {
        ok: true,
        repair: {
          diagnosticId: checked.diagnostic.id,
          itemId: checked.item.id,
          href: checked.diagnostic.href,
          explanation: rec.explanation,
          kind: rec.kind,
          draft: rec.draft,
          revision: checked.diagnostic.revision,
        },
      };
    },
    revalidate,
    titleSummary(itemId) {
      const days = PLAYBACK_HISTORY_DAYS;
      const rows = store.queryPlaybackOccurrences({
        libraryItemId: itemId,
        since: windowStart(days),
        limit: PLAYBACK_HISTORY_MAX,
      });
      const item = store.getItem(itemId);
      const siblings = item ? store.itemsForPath(item.path, item.instanceId).map((row) => row.id) : [itemId];
      const keptAt = store.lastKeptAtForItems(siblings);
      const history = store.queryPlaybackOccurrences({
        libraryItemId: itemId,
        limit: PLAYBACK_HISTORY_MAX,
      });
      const beforeProblem = keptAt == null
        ? undefined
        : history.find((row) => isPlaybackProblem(row) && row.lastSeenAt <= keptAt);
      const afterKeep = beforeProblem
        ? describeAfterKeep({ keptAt, deviceId: beforeProblem.deviceId, before: beforeProblem, later: history })
        : { status: "none" as const, sentence: null };
      return {
        windowDays: days,
        observations: rows.slice(0, 20).map((row) => ({ ...row, summary: observationSummary(row) })),
        afterKeep,
        problemCount: groupedProblems({
          offset: 0,
          limit: PLAYBACK_HISTORY_MAX,
          days,
          itemId,
        }).length,
      };
    },
  };
}

function pageWindow<T>(items: T[], query: PlaybackListQuery, windowStartAt: number): PlaybackListResult<T> {
  const total = items.length;
  const slice = items.slice(query.offset, query.offset + query.limit);
  const consumed = query.offset + slice.length;
  return {
    items: slice,
    total,
    nextOffset: consumed < total && slice.length === query.limit ? consumed : null,
    windowDays: query.days,
    windowStartAt,
  };
}

function audioRecommendation(input: {
  selectedTracks: PlaybackOccurrence["selectedTracks"];
  report: InspectionReport | null;
  preferredLanguage: string;
}): PlaybackRecommendation {
  if (!input.report || input.report.listingState !== "complete") {
    return none("This file has not been inspected yet, so Polisharr cannot recommend an audio change.");
  }
  const selected = selectedAudio(input.report, input.selectedTracks.audioStreamIndex);
  if (!selected) {
    return none("Polisharr cannot tell which soundtrack Jellyfin selected. Inspect the file before choosing a repair.");
  }
  const lang = normalizeLang(input.preferredLanguage || "eng");
  if (isPlayableStereo(selected, lang) || (selected.channels === 2 && isPlayableStereoCodec(selected.codec))) {
    return tryExistingStereo(selected);
  }
  const stereo = suitableStereo(input.report, lang);
  if (stereo) return tryExistingStereo(stereo);
  if (selected.channels > 2) {
    return {
      kind: "add_stereo",
      explanation: "Jellyfin converted the audio because this file has surround sound and no stereo track in the preferred language. This plan adds an AAC stereo track and keeps the original mix. Conversion on one device does not prove stereo will play everywhere.",
      canRepair: true,
      openEditor: true,
      draft: {
        video: { mode: "copy" },
        audio: [{ index: selected.index, action: "add_downmix", channels: 2 }],
      },
      suggestionId: null,
    };
  }
  if (selected.channels === 2) {
    return none(`The selected soundtrack is already two channels in ${selected.codec}, which this player converted. Polisharr will not guess a codec replace from this observation.`);
  }
  return none("The selected soundtrack is not surround, so Polisharr will not add a stereo mix from this observation.");
}

function bitrateRecommendation(suggestion: Suggestion | null): PlaybackRecommendation {
  const hasSize = Boolean(suggestion?.actions.includes("transcode"));
  return {
    kind: "bitrate_suggestion",
    explanation: hasSize
      ? "Jellyfin hit a bitrate limit. There is already a size-reduction suggestion for this file. A smaller file may still convert if the player or network is the limit. Polisharr will not invent a bitrate target."
      : "Jellyfin hit a bitrate limit. Polisharr will not invent a bitrate target from this observation.",
    canRepair: false,
    openEditor: false,
    draft: null,
    suggestionId: hasSize ? suggestion?.id ?? null : null,
  };
}

function videoRecommendation(rawReasons: string[]): PlaybackRecommendation {
  return {
    kind: "video_constraint",
    explanation: videoExplanation(rawReasons),
    canRepair: false,
    openEditor: false,
    draft: null,
    suggestionId: null,
  };
}

function subtitleRecommendation(
  rawReasons: string[],
  report: InspectionReport | null,
  index: number | null,
): PlaybackRecommendation {
  return {
    kind: "subtitle_guidance",
    explanation: subtitleExplanation(rawReasons, report, index),
    canRepair: false,
    openEditor: false,
    draft: null,
    suggestionId: null,
  };
}

function containerRecommendation(path: string | null): PlaybackRecommendation {
  return {
    kind: "container_guidance",
    explanation: containerExplanation(path),
    canRepair: false,
    openEditor: false,
    draft: null,
    suggestionId: null,
  };
}

function tryExistingStereo(track: AudioTrack): PlaybackRecommendation {
  return {
    kind: "try_existing_stereo",
    explanation: `This file already has a ${trackLabel(track)} track. In Jellyfin, choose that stereo soundtrack. Polisharr will not add another copy.`,
    canRepair: false,
    openEditor: false,
    draft: null,
    suggestionId: null,
  };
}

function mergeRecommendations(parts: PlaybackRecommendation[]): PlaybackRecommendation {
  const ranked = [...parts].sort((left, right) => recommendationRank(left.kind) - recommendationRank(right.kind));
  const primary = ranked[0]!;
  const repair = parts.find((part) => part.canRepair && part.draft);
  return {
    kind: primary.kind,
    explanation: unique(parts.map((part) => part.explanation)).join(" "),
    canRepair: Boolean(repair),
    openEditor: Boolean(repair),
    draft: repair?.draft ?? null,
    suggestionId: parts.find((part) => part.suggestionId)?.suggestionId ?? null,
  };
}

function recommendationRank(kind: PlaybackRecommendationKind): number {
  const order: PlaybackRecommendationKind[] = [
    "add_stereo",
    "try_existing_stereo",
    "video_constraint",
    "bitrate_suggestion",
    "subtitle_guidance",
    "container_guidance",
    "none",
  ];
  const index = order.indexOf(kind);
  return index < 0 ? order.length : index;
}

function selectedAudio(report: InspectionReport, index: number | null): AudioTrack | undefined {
  if (index == null || index < 0) return undefined;
  return report.audio.find((track) => track.index === index);
}

function suitableStereo(report: InspectionReport, lang: string): AudioTrack | undefined {
  return report.audio.find((track) => isPlayableStereo(track, lang));
}

function isPlayableStereo(track: AudioTrack, lang: string): boolean {
  if (track.channels !== 2 || track.commentary) return false;
  if (!isPlayableStereoCodec(track.codec)) return false;
  return track.language === lang || track.language === "und" || track.untagged;
}

function isPlayableStereoCodec(codec: string): boolean {
  const value = codec.toLowerCase().replace(/[-_]/g, "");
  return value === "aac" || value === "ac3" || value === "mp3" || value === "opus" || value.startsWith("aac");
}

function trackLabel(track: AudioTrack): string {
  const lang = track.language && track.language !== "und" ? languageDisplayName(track.language) : "untagged";
  const layout = track.channels <= 2 ? "stereo" : track.channels === 6 ? "5.1" : track.channels === 8 ? "7.1" : `${track.channels}-channel`;
  return `${lang} ${layout} ${track.codec}`.trim();
}

function subtitleExplanation(rawReasons: string[], report: InspectionReport | null, index: number | null): string {
  const track = report && index != null ? report.subtitles.find((row) => row.index === index) : undefined;
  const format = track?.codec ? ` (${track.codec})` : rawReasons.length ? ` (${rawReasons.join(", ")})` : "";
  return `Jellyfin converted the subtitles${format}. Open the title to inspect subtitle tracks. Polisharr will not remove or convert subtitles from this observation.`;
}

function videoExplanation(rawReasons: string[]): string {
  const reported = rawReasons.length ? ` (${rawReasons.join(", ")})` : "";
  return `Jellyfin could not play this video as-is${reported}. Open the custom editor to choose a video change. Polisharr will not pick HEVC or AV1 from this observation, because encoder support does not mean this player can play that codec.`;
}

function containerExplanation(path: string | null): string {
  const ext = path?.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  const named = ext ? ` This file is ${ext}.` : "";
  return `Jellyfin converted the container.${named} The video may stay the same. Changing MKV or MP4 is not a universal playback fix.`;
}

function none(explanation: string): PlaybackRecommendation {
  return {
    kind: "none",
    explanation,
    canRepair: false,
    openEditor: false,
    draft: null,
    suggestionId: null,
  };
}

function noneFromReasons(rawReasons: string[]): PlaybackRecommendation {
  if (rawReasons.length === 0) {
    return none("Jellyfin did not report the reason. Polisharr will not guess a repair.");
  }
  return none("Polisharr will not guess a repair from this reason.");
}

function contextCompatible(before: PlaybackOccurrence, after: PlaybackOccurrence): boolean {
  return streamIndex(before.selectedTracks.subtitleStreamIndex) === streamIndex(after.selectedTracks.subtitleStreamIndex)
    && (before.match === "remote") === (after.match === "remote");
}

function streamIndex(index: number | null): number | null {
  if (index == null || index < 0) return null;
  return index;
}

function contextChangeSentence(before: PlaybackOccurrence, after: PlaybackOccurrence): string {
  if ((before.match === "remote") !== (after.match === "remote")) {
    return after.match === "remote"
      ? "Later playback on this device was remote, so this is not a direct comparison."
      : "Later playback on this device was local, so this is not a direct comparison.";
  }
  if (streamIndex(before.selectedTracks.subtitleStreamIndex) !== streamIndex(after.selectedTracks.subtitleStreamIndex)) {
    return "Later playback on this device used different subtitles, so this is not a direct comparison.";
  }
  return "Later playback on this device used different settings, so this is not a direct comparison.";
}

export function occurrenceMatchesFamily(row: PlaybackOccurrence, family: PlaybackReasonFamily | undefined): boolean {
  if (!family) return true;
  if (!isPlaybackProblem(row)) return false;
  const stored = problemReasonFamily(row);
  if (stored === family) return true;
  const fromReasons = familiesFromEvidence(stored ?? "unknown", row.rawReasons);
  if (fromReasons.includes(family)) return true;
  return family === "mixed" && fromReasons.length > 1;
}

function matchesClient(row: PlaybackOccurrence, client: string | undefined): boolean {
  if (!client) return true;
  const needle = client.trim().toLowerCase();
  if (!needle) return true;
  return row.deviceId.toLowerCase() === needle || row.deviceLabel.toLowerCase().includes(needle);
}

function matchesTitle(store: Store, row: PlaybackOccurrence, title: string | undefined): boolean {
  if (!title) return true;
  const needle = title.trim().toLowerCase();
  if (!needle) return true;
  if (row.itemName.toLowerCase().includes(needle)) return true;
  return row.libraryItemIds.some((id) => {
    const item = store.getItem(id);
    if (!item) return false;
    return `${item.title} ${item.showTitle ?? ""} ${item.episodeTitle ?? ""}`.toLowerCase().includes(needle);
  });
}

function firstItem(store: Store, ids: string[]): LibraryItem | undefined {
  for (const id of ids) {
    const item = store.getItem(id);
    if (item) return item;
  }
  return undefined;
}

function itemHref(item: LibraryItem): string {
  return item.type === "episode" ? `/series/episodes/${item.id}` : `/movies/${item.id}`;
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

function emptyToUndef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCount(raw: string | undefined, fallback: number): number | null {
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function nullish(value: number | null): string {
  return value == null ? "" : String(value);
}

export { PLAYBACK_DIAGNOSTIC_DAYS, PLAYBACK_HISTORY_DAYS };
