import type { Store, LibrarySnapshot } from "./store.ts";
import type { LibraryItem } from "./types.ts";
import { displayTitle, sharedFileLabel } from "./titles.ts";
import { audioTrackLabel, subtitleTrackLabel } from "./tracks.ts";
import { arrLinkForLibraryItem } from "./external-links.ts";

export type Page<T> = {
  items: T[];
  nextOffset: number | null;
  total: number;
  healthyCount?: number;
  suggestionCount?: number;
  libraryTotal?: number;
};

export function createLibraryReadModel(store: Store) {
  return {
    movies(offset: number, limit: number, sort: "title" | "size" | "quality" = "title", work = false) {
      const page = store.libraryPage({ type: "movie", offset, limit, sort, work });
      const health = store.movieHealth();
      return {
        ...presentPage(store, page, offset, limit),
        healthyCount: health.healthyCount,
        suggestionCount: health.suggestionCount,
        libraryTotal: health.total,
      };
    },
    series(offset: number, limit: number) {
      const page = store.seriesPage(offset, limit);
      return {
        items: page.rows.map((row) => {
          const sonarr = arrLinkForLibraryItem({
            type: "episode",
            instanceKind: "sonarr",
            instanceUrl: row.instanceUrl,
            tvdbId: row.tvdbId,
            titleSlug: row.titleSlug,
          });
          return {
            id: `${row.instanceId}:${row.arrSeriesId}`,
            key: `${row.instanceId}:${row.arrSeriesId}`,
            instanceId: row.instanceId,
            instanceName: row.instanceName,
            arrSeriesId: row.arrSeriesId,
            showTitle: row.showTitle,
            episodeCount: row.episodeCount,
            healthyCount: row.healthyCount,
            suggestionCount: row.suggestionCount,
            videoTarget: row.videoTarget,
            audioMix: row.audioMix,
            links: sonarr ? [sonarr] : [],
          };
        }),
        nextOffset: nextOffset(offset, limit, page.total),
        total: page.total,
      };
    },
    episodes(instanceId: string, arrSeriesId: number, offset: number, limit: number, work = false) {
      const page = store.libraryPage({ type: "episode", instanceId, arrSeriesId, offset, limit, work });
      return presentPage(store, page, offset, limit);
    },
    item(id: string, detail = false) {
      const snapshot = store.librarySnapshot(id);
      if (!snapshot) return undefined;
      return presentLibraryItem(
        snapshot,
        detail,
        store.itemsForPath(snapshot.item.path, snapshot.item.instanceId),
        customPlanReasons(store, snapshot.item.id),
      );
    },
  };
}

function presentPage(
  store: Store,
  page: { rows: LibrarySnapshot[]; total: number },
  offset: number,
  limit: number,
): Page<ReturnType<typeof presentLibraryItem>> {
  return {
    items: page.rows.map((row) => presentLibraryItem(
      row,
      false,
      store.itemsForPath(row.item.path, row.item.instanceId),
      customPlanReasons(store, row.item.id),
    )),
    nextOffset: nextOffset(offset, limit, page.total),
    total: page.total,
  };
}

function customPlanReasons(store: Store, itemId: string): string[] {
  const job = store.activeJobForItem(itemId);
  const plan = job?.plan;
  if (!plan || typeof plan !== "object" || !("reasons" in plan) || !Array.isArray(plan.reasons)) return [];
  return plan.reasons.filter((reason): reason is string => typeof reason === "string");
}

function nextOffset(offset: number, limit: number, total: number): number | null {
  const next = offset + limit;
  return next < total ? next : null;
}

export function presentLibraryItem(
  snapshot: LibrarySnapshot,
  detail = false,
  siblings: LibraryItem[] = [],
  customReasons: string[] = [],
) {
  const { item, report, suggestion } = snapshot;
  const error = snapshot.error ?? (!item.path && item.type === "episode"
    ? "Sonarr did not send a file path. Refresh the library."
    : null);
  return {
    ...item,
    displayTitle: displayTitle(item),
    sharedFileLabel: sharedFileLabel(item, siblings),
    inspected: Boolean(report),
    mediaState: error ? "unreadable" as const : report ? "inspected" as const : "waiting" as const,
    report: detail ? report : undefined,
    suggestion: suggestion
      ? { id: suggestion.id, actions: suggestion.actions, reasons: suggestion.reasons }
      : null,
    error,
    reasons: suggestion?.reasons ?? customReasons,
    href: item.type === "movie" ? `/movies/${item.id}` : `/series/episodes/${item.id}`,
    listingState: report?.listingState ?? null,
    sourceMethod: report?.sourceMethod ?? null,
    videoLabel: report ? `${report.videoCodec} · ${report.width}x${report.height}` : null,
    audioLabels: report?.audio.map((track) => audioTrackLabel(track).replace(/^Audio: /, "")) ?? [],
    subtitleLabels: report?.subtitles.map((track) => subtitleTrackLabel(track).replace(/^Subtitle: /, "")) ?? [],
    trackEditingAvailable: report?.listingState === "complete",
  };
}
