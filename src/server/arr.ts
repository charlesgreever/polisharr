import { isMediaFilePath } from "./inspect.ts";

export type ArrHttpAuth = {
  url: string;
  apiKey: string;
};

export type ArrTitle = {
  id: number;
  title: string;
  path: string;
  size: number;
  quality: string;
  resolution: string;
  profile: string;
  tags: string[];
  posterUrl: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  titleSlug: string | null;
};

export type ArrMovie = ArrTitle;

export type ArrEpisode = ArrTitle & {
  seriesId: number;
  episodeFileId: number | null;
  seriesTitle: string;
  season: number;
  episode: number;
  episodeTitle: string;
};

export type ConnectionResult =
  | { ok: true }
  | { ok: false; kind: "auth" | "connect" | "shape"; message: string };

export async function fetchJson(connection: ArrHttpAuth, path: string, httpFetch: typeof fetch): Promise<unknown> {
  const res = await httpFetch(`${trimUrl(connection.url)}${path}`, { headers: { "X-Api-Key": connection.apiKey } });
  if (res.status === 401 || res.status === 403) {
    const err = new Error("The Arr rejected this API key.") as Error & { kind: "auth" };
    err.kind = "auth";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`The Arr returned HTTP ${res.status}.`) as Error & { kind: "connect" };
    err.kind = "connect";
    throw err;
  }
  return res.json();
}

export function parseRadarrMovies(payload: unknown): ArrMovie[] {
  if (!Array.isArray(payload)) throw shape("Radarr movie list");
  return payload.flatMap((raw) => {
    const row = asRecord(raw);
    const file = movieFileOf(row);
    const path = str(file?.path, "");
    if (!path || !isMediaFilePath(path)) return [];
    const quality = qualityName(file ?? {});
    return [{
      id: num(row.id),
      title: str(row.title, "Untitled"),
      path,
      size: num(file?.size ?? row.sizeOnDisk),
      quality,
      resolution: resolutionFrom(quality, file ?? {}),
      profile: str(asRecord(row.qualityProfile).name, ""),
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      posterUrl: posterFrom(row.images),
      ...arrWebIds(row),
    }];
  });
}

export function parseSonarrSeries(payload: unknown): Array<{
  id: number;
  title: string;
  posterUrl: string | null;
  profile: string;
  tags: string[];
  tmdbId: number | null;
  tvdbId: number | null;
  titleSlug: string | null;
}> {
  if (!Array.isArray(payload)) throw shape("Sonarr series list");
  return payload.map((raw) => {
    const row = asRecord(raw);
    return {
      id: num(row.id),
      title: str(row.title, "Untitled"),
      posterUrl: posterFrom(row.images),
      profile: str(asRecord(row.qualityProfile).name, ""),
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      ...arrWebIds(row),
    };
  });
}

export function parseArrWebIds(payload: unknown): { tmdbId: number | null; tvdbId: number | null; titleSlug: string | null } {
  return arrWebIds(asRecord(payload));
}

export function arrWebIds(raw: Record<string, unknown>): { tmdbId: number | null; tvdbId: number | null; titleSlug: string | null } {
  const slug = str(raw.titleSlug, "").trim();
  const tmdb = num(raw.tmdbId);
  const tvdb = num(raw.tvdbId);
  return {
    tmdbId: tmdb > 0 ? tmdb : null,
    tvdbId: tvdb > 0 ? tvdb : null,
    titleSlug: slug || null,
  };
}

export function parseSonarrEpisodes(payload: unknown, seriesTitle: string, posterUrl: string | null, profile: string, tags: string[]): ArrEpisode[] {
  if (!Array.isArray(payload)) throw shape("Sonarr episode list");
  return payload
    .map((raw) => {
      const row = asRecord(raw);
      const file = asRecord(row.episodeFile);
      if (!file.path || !isMediaFilePath(str(file.path, ""))) return null;
      const quality = qualityName(file);
      return {
        id: num(row.id),
        seriesId: num(row.seriesId),
        episodeFileId: file.id == null ? null : num(file.id),
        title: seriesTitle,
        seriesTitle,
        season: num(row.seasonNumber),
        episode: num(row.episodeNumber),
        episodeTitle: str(row.title, "Episode"),
        path: str(file.path, ""),
        size: num(file.size),
        quality,
        resolution: resolutionFrom(quality, file),
        profile,
        tags,
        posterUrl,
        tmdbId: null,
        tvdbId: null,
        titleSlug: null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export function parseRootFolders(payload: unknown): string[] {
  if (!Array.isArray(payload)) throw shape("Arr root-folder list");
  return payload
    .map((raw) => str(asRecord(raw).path, "").trim())
    .filter((path) => path.length > 0);
}

export async function testRadarr(connection: ArrHttpAuth, httpFetch: typeof fetch): Promise<ConnectionResult> {
  try {
    const payload = await fetchJson(connection, "/api/v3/system/status", httpFetch);
    const row = asRecord(payload);
    if (typeof row.appName === "string" || typeof row.version === "string") return { ok: true };
    return { ok: false, kind: "shape", message: "That URL answered, but it does not look like Radarr." };
  } catch (error) {
    return connectionError(error);
  }
}

export async function testSonarr(connection: ArrHttpAuth, httpFetch: typeof fetch): Promise<ConnectionResult> {
  try {
    const payload = await fetchJson(connection, "/api/v3/system/status", httpFetch);
    const row = asRecord(payload);
    if (typeof row.appName === "string" && String(row.appName).toLowerCase().includes("sonarr")) return { ok: true };
    if (typeof row.version === "string") return { ok: true };
    return { ok: false, kind: "shape", message: "That URL answered, but it does not look like Sonarr." };
  } catch (error) {
    return connectionError(error);
  }
}

export function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export type ArrRefreshRenameInput = {
  kind: "radarr" | "sonarr";
  url: string;
  apiKey: string;
  movieId?: number;
  seriesId?: number;
  episodeFileId?: number | null;
  currentPath: string;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

export async function refreshAndRenameArr(input: ArrRefreshRenameInput): Promise<{ path: string | null; warning: string | null }> {
  const connection = { url: input.url, apiKey: input.apiKey };
  const refreshBody = input.kind === "radarr"
    ? { name: "RefreshMovie", movieIds: [input.movieId] }
    : { name: "RefreshSeries", seriesId: input.seriesId };
  const refreshed = await runArrCommand(connection, refreshBody, input);
  if (refreshed) return { path: null, warning: refreshed };
  const preview = await renamePreview(connection, input);
  if ("warning" in preview) return { path: null, warning: preview.warning };
  if (preview.files.length === 0) return { path: null, warning: null };
  const renameBody = input.kind === "radarr"
    ? { name: "RenameFiles", files: preview.files.map((file) => file.fileId) }
    : { name: "RenameFiles", seriesId: input.seriesId, files: preview.files.map((file) => file.fileId) };
  const renamed = await runArrCommand(connection, renameBody, input);
  if (renamed) return { path: null, warning: renamed };
  const path = await promotedArrPath(connection, input, preview.files[0]?.newPath ?? null);
  return { path: path && path !== input.currentPath ? path : preview.files[0]?.newPath ?? null, warning: null };
}

async function runArrCommand(
  connection: ArrHttpAuth,
  body: Record<string, unknown>,
  input: ArrRefreshRenameInput,
): Promise<string | null> {
  try {
    const payload = await arrJson(connection, "/api/v3/command", input.fetch, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const row = asRecord(payload);
    const id = num(row.id);
    const status = str(row.status, "queued");
    if (status === "completed") return null;
    if (status === "failed" || status === "aborted") {
      return `The Arr ${String(body.name ?? "command")} failed. The new file is already in place.`;
    }
    if (!(id > 0)) return null;
    return waitArrCommand(connection, id, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Arr command failed.";
    return `${message} The new file is already in place.`;
  }
}

async function waitArrCommand(connection: ArrHttpAuth, id: number, input: ArrRefreshRenameInput): Promise<string | null> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(250);
    try {
      const payload = await arrJson(connection, `/api/v3/command/${id}`, input.fetch);
      const status = str(asRecord(payload).status, "");
      if (status === "completed") return null;
      if (status === "failed" || status === "aborted") {
        return "The Arr command failed. The new file is already in place.";
      }
    } catch {
      return "The Arr command status could not be read. The new file is already in place.";
    }
  }
  return "The Arr did not finish refreshing or renaming in time. The new file is already in place.";
}

async function renamePreview(
  connection: ArrHttpAuth,
  input: ArrRefreshRenameInput,
): Promise<{ files: Array<{ fileId: number; existingPath: string; newPath: string }> } | { warning: string }> {
  try {
    const query = input.kind === "radarr" ? `movieId=${input.movieId}` : `seriesId=${input.seriesId}`;
    const payload = await arrJson(connection, `/api/v3/rename?${query}`, input.fetch);
    if (!Array.isArray(payload)) return { files: [] };
    const files = payload.flatMap((raw) => {
      const row = asRecord(raw);
      const fileId = num(row.movieFileId ?? row.episodeFileId);
      const existingPath = str(row.existingPath, "");
      const newPath = str(row.newPath, "");
      if (!(fileId > 0) || !existingPath || !newPath || existingPath === newPath) return [];
      return [{ fileId, existingPath, newPath }];
    });
    const matched = files.filter((file) => {
      if (file.existingPath === input.currentPath) return true;
      if (input.episodeFileId && file.fileId === input.episodeFileId) return true;
      if (input.kind === "radarr") return files.length === 1;
      return false;
    });
    return { files: matched.length > 0 ? matched : files.filter((file) => file.existingPath === input.currentPath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Arr rename preview failed.";
    return { warning: `${message} The new file is already in place.` };
  }
}

async function promotedArrPath(
  connection: ArrHttpAuth,
  input: ArrRefreshRenameInput,
  fallback: string | null,
): Promise<string | null> {
  try {
    if (input.kind === "radarr" && input.movieId) {
      const payload = await arrJson(connection, `/api/v3/movie/${input.movieId}`, input.fetch);
      const path = str(asRecord(asRecord(payload).movieFile).path, "");
      return path || fallback;
    }
    const fileId = input.episodeFileId ?? 0;
    if (input.kind === "sonarr" && fileId > 0) {
      const payload = await arrJson(connection, `/api/v3/episodefile/${fileId}`, input.fetch);
      const path = str(asRecord(payload).path, "");
      return path || fallback;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

async function arrJson(
  connection: ArrHttpAuth,
  path: string,
  httpFetch: typeof fetch,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("X-Api-Key", connection.apiKey);
  const res = await httpFetch(`${trimUrl(connection.url)}${path}`, { ...init, headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error("The Arr rejected this API key.");
  }
  if (!res.ok) throw new Error(`The Arr returned HTTP ${res.status}.`);
  return res.json();
}

function connectionError(error: unknown): ConnectionResult {
  const err = error as { kind?: string; message?: string };
  if (err.kind === "auth") return { ok: false, kind: "auth", message: "The Arr rejected this API key." };
  if (err.kind === "shape") return { ok: false, kind: "shape", message: err.message ?? "Unexpected response." };
  return { ok: false, kind: "connect", message: "Polisharr could not reach that URL." };
}

function shape(what: string): Error {
  const err = new Error(`The ${what} was not the expected JSON.`) as Error & { kind: "shape" };
  err.kind = "shape";
  return err;
}

function movieFileOf(row: Record<string, unknown>): Record<string, unknown> | null {
  if (row.movieFile && typeof row.movieFile === "object") return asRecord(row.movieFile);
  return null;
}

function qualityName(file: Record<string, unknown>): string {
  const q = asRecord(asRecord(file.quality).quality);
  return str(q.name ?? q.resolution, "");
}

function resolutionFrom(quality: string, file: Record<string, unknown>): string {
  const media = asRecord(file.mediaInfo);
  return str(media.resolution, quality);
}

function posterFrom(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const poster = images.map(asRecord).find((img) => String(img.coverType) === "poster");
  const url = poster ? str(poster.url ?? poster.remoteUrl, "") : "";
  return url || null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
