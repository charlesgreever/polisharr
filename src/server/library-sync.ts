import { resolve } from "node:path";
import {
  fetchJson,
  parseRadarrMovies,
  parseRootFolders,
  parseSonarrEpisodes,
  parseSonarrSeries,
  type ArrEpisode,
  type ArrMovie,
} from "./arr.ts";
import { parseArrWebhook } from "./arr-webhook.ts";
import type { Store, StoredInstance } from "./store.ts";

export type LibrarySyncResult = { ok: true; errors: string[] };

export type LibrarySyncOptions = {
  store: Store;
  fetch: typeof fetch;
  decrypt: (packed: string) => string;
  inspectPending: () => Promise<void>;
  intervalMs?: number;
};

export class LibrarySync {
  private inFlight: Promise<LibrarySyncResult> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: LibrarySyncOptions) {}

  start(): void {
    this.refreshInBackground();
    const intervalMs = this.options.intervalMs ?? 15 * 60 * 1_000;
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => this.refreshInBackground(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  refresh(): Promise<LibrarySyncResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  notifyFromWebhook(payload: unknown): Promise<LibrarySyncResult> {
    const event = parseArrWebhook(payload);
    if (!event.syncsLibrary) return Promise.resolve({ ok: true, errors: [] });
    if (this.inFlight) return this.refresh();
    return this.performTargetedRefresh(event).then((hit) => {
      if (hit) {
        this.inspectAfterSync();
        return { ok: true as const, errors: [] };
      }
      return this.refresh();
    });
  }

  private refreshInBackground(): void {
    void this.refresh().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`The library sync could not start because ${message}`);
    });
  }

  private async performRefresh(): Promise<LibrarySyncResult> {
    const errors: string[] = [];
    for (const instance of this.options.store.listInstances()) {
      if (!instance.enabled || !instance.secret || (instance.kind !== "radarr" && instance.kind !== "sonarr")) continue;
      try {
        await this.refreshInstance(instance, this.options.decrypt(instance.secret), errors);
      } catch (error) {
        errors.push(`${instance.name}: ${error instanceof Error ? error.message : "Sync failed."}`);
      }
    }
    this.inspectAfterSync();
    return { ok: true, errors };
  }

  private inspectAfterSync(): void {
    void this.options.inspectPending().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`The library inspector could not start after sync because ${message}`);
    });
  }

  private async performTargetedRefresh(event: { movieId: number | null; seriesId: number | null }): Promise<boolean> {
    if (event.movieId != null && (await this.refreshRadarrMovie(event.movieId))) return true;
    if (event.seriesId != null && (await this.refreshSonarrSeries(event.seriesId))) return true;
    return false;
  }

  private async refreshRadarrMovie(movieId: number): Promise<boolean> {
    let found = false;
    for (const instance of this.options.store.listInstances()) {
      if (!instance.enabled || instance.kind !== "radarr" || !instance.secret) continue;
      try {
        const raw = await fetchJson(
          { url: instance.url, apiKey: this.options.decrypt(instance.secret) },
          `/api/v3/movie/${movieId}`,
          this.options.fetch,
        );
        const movie = parseRadarrMovies(Array.isArray(raw) ? raw : [raw])[0];
        if (!movie) continue;
        this.storeMovie(instance, movie);
        found = true;
      } catch {
        /* try the next Radarr */
      }
    }
    return found;
  }

  private async refreshSonarrSeries(seriesId: number): Promise<boolean> {
    let found = false;
    for (const instance of this.options.store.listInstances()) {
      if (!instance.enabled || instance.kind !== "sonarr" || !instance.secret) continue;
      try {
        const auth = { url: instance.url, apiKey: this.options.decrypt(instance.secret) };
        const rawShow = await fetchJson(auth, `/api/v3/series/${seriesId}`, this.options.fetch);
        const show = parseSonarrSeries(Array.isArray(rawShow) ? rawShow : [rawShow])[0];
        if (!show) continue;
        const episodes = parseSonarrEpisodes(
          await fetchJson(auth, `/api/v3/episode?seriesId=${show.id}&includeEpisodeFile=true`, this.options.fetch),
          show.title,
          show.posterUrl,
          show.profile,
          show.tags,
        );
        for (const episode of episodes) {
          this.storeEpisode(instance, { ...episode, tvdbId: show.tvdbId, titleSlug: show.titleSlug, tmdbId: show.tmdbId });
        }
        found = true;
      } catch {
        /* try the next Sonarr */
      }
    }
    return found;
  }

  private async refreshInstance(instance: StoredInstance, key: string, errors: string[]): Promise<void> {
    const roots = await this.refreshRoots(instance, key);
    const reviewPath = this.options.store.getSettings().reviewPath;
    if (reviewPath && roots.some((root) => pathsOverlap(reviewPath, root))) {
      errors.push(`${instance.name}: The review folder overlaps this Arr library.`);
      return;
    }
    if (instance.kind === "radarr") {
      const movies = parseRadarrMovies(await fetchJson({ url: instance.url, apiKey: key }, "/api/v3/movie", this.options.fetch));
      const ids: string[] = [];
      for (const movie of movies) ids.push(this.storeMovie(instance, movie));
      this.options.store.removeItemsNotIn(instance.id, "movie", ids);
      return;
    }
    const series = parseSonarrSeries(await fetchJson({ url: instance.url, apiKey: key }, "/api/v3/series", this.options.fetch));
    const episodeIds: string[] = [];
    for (const show of series) {
      const episodes = parseSonarrEpisodes(
        await fetchJson({ url: instance.url, apiKey: key }, `/api/v3/episode?seriesId=${show.id}&includeEpisodeFile=true`, this.options.fetch),
        show.title, show.posterUrl, show.profile, show.tags,
      );
      for (const episode of episodes) {
        episodeIds.push(this.storeEpisode(instance, { ...episode, tvdbId: show.tvdbId, titleSlug: show.titleSlug, tmdbId: show.tmdbId }));
      }
    }
    this.options.store.removeItemsNotIn(instance.id, "episode", episodeIds);
  }

  private storeMovie(instance: StoredInstance, movie: ArrMovie): string {
    const id = `${instance.id}:movie:${movie.id}`;
    this.options.store.upsertItem({
      id, instanceId: instance.id, arrId: movie.id, arrSeriesId: null, arrEpisodeFileId: null, type: "movie",
      title: movie.title, showTitle: null, season: null, episode: null, episodeTitle: null, path: movie.path,
      sizeBytes: movie.size, quality: movie.quality, resolution: movie.resolution, profile: movie.profile,
      tags: movie.tags, posterRemoteUrl: movie.posterUrl,
      sizeExempt: this.options.store.getItem(id)?.sizeExempt ?? false,
      tmdbId: movie.tmdbId, tvdbId: movie.tvdbId, titleSlug: movie.titleSlug,
    });
    return id;
  }

  private storeEpisode(instance: StoredInstance, episode: ArrEpisode): string {
    const id = `${instance.id}:episode:${episode.id}`;
    this.options.store.upsertItem({
      id, instanceId: instance.id, arrId: episode.id, arrSeriesId: episode.seriesId,
      arrEpisodeFileId: episode.episodeFileId, type: "episode", title: episode.seriesTitle,
      showTitle: episode.seriesTitle, season: episode.season, episode: episode.episode,
      episodeTitle: episode.episodeTitle, path: episode.path, sizeBytes: episode.size, quality: episode.quality,
      resolution: episode.resolution, profile: episode.profile, tags: episode.tags,
      posterRemoteUrl: episode.posterUrl, sizeExempt: this.options.store.getItem(id)?.sizeExempt ?? false,
      tmdbId: episode.tmdbId, tvdbId: episode.tvdbId, titleSlug: episode.titleSlug,
    });
    return id;
  }

  private async refreshRoots(instance: StoredInstance, key: string): Promise<string[]> {
    try {
      const roots = parseRootFolders(
        await fetchJson({ url: instance.url, apiKey: key }, "/api/v3/rootfolder", this.options.fetch),
      );
      this.options.store.replaceLibraryRoots(instance.id, roots);
      return roots;
    } catch {
      return this.options.store.listLibraryRoots(instance.id);
    }
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
