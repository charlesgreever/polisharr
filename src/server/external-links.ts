import { basename } from "node:path";
import { fetchJson, parseArrWebIds, trimUrl } from "./arr.ts";
import { jellyfinAuthHeaders } from "./notify.ts";
import type { LibraryItem } from "./types.ts";
import type { StoredInstance } from "./store.ts";

export type ExternalLink = { label: string; href: string };

export function radarrMovieHref(baseUrl: string, tmdbId?: number | null, titleSlug?: string | null): string | null {
  const base = trimUrl(baseUrl);
  if (!base) return null;
  // Radarr 6 routes /movie/:titleSlug. The API slug is the TMDB id as a string.
  const slug = titleSlug?.trim() || (tmdbId && tmdbId > 0 ? String(tmdbId) : "");
  return slug ? `${base}/movie/${encodeURIComponent(slug)}` : null;
}

export function sonarrSeriesHref(baseUrl: string, tvdbId?: number | null, titleSlug?: string | null): string | null {
  const base = trimUrl(baseUrl);
  if (!base) return null;
  // Sonarr routes /series/:titleSlug using a name slug, not the TVDB id.
  const slug = titleSlug?.trim();
  if (slug) return `${base}/series/${encodeURIComponent(slug)}`;
  return null;
}

export function plexDetailsHref(baseUrl: string, machineId: string, ratingKey: string): string | null {
  const base = trimUrl(baseUrl);
  if (!base || !machineId || !ratingKey) return null;
  const key = `/library/metadata/${ratingKey}`;
  return `${base}/web/index.html#!/server/${encodeURIComponent(machineId)}/details?key=${encodeURIComponent(key)}`;
}

export function jellyfinDetailsHref(baseUrl: string, itemId: string): string | null {
  const base = trimUrl(baseUrl);
  if (!base || !itemId) return null;
  return `${base}/web/#/details?id=${encodeURIComponent(itemId)}`;
}

export function arrLinkForLibraryItem(input: {
  type: "movie" | "episode";
  instanceKind: string;
  instanceUrl: string;
  tmdbId?: number | null;
  tvdbId?: number | null;
  titleSlug?: string | null;
}): ExternalLink | null {
  if (input.instanceKind === "radarr" && input.type === "movie") {
    const href = radarrMovieHref(input.instanceUrl, input.tmdbId, input.titleSlug);
    return href ? { label: "Open in Radarr", href } : null;
  }
  if (input.instanceKind === "sonarr") {
    const href = sonarrSeriesHref(input.instanceUrl, input.tvdbId, input.titleSlug);
    return href ? { label: "Open in Sonarr", href } : null;
  }
  return null;
}

export async function collectTitleLinks(input: {
  item: LibraryItem;
  instance?: StoredInstance;
  players: StoredInstance[];
  decrypt: (packed: string) => string;
  fetch: typeof fetch;
  saveArrIds?: (ids: { tmdbId: number | null; tvdbId: number | null; titleSlug: string | null }) => void;
}): Promise<ExternalLink[]> {
  const links: ExternalLink[] = [];
  let tmdbId = input.item.tmdbId ?? null;
  let tvdbId = input.item.tvdbId ?? null;
  let titleSlug = input.item.titleSlug ?? null;
  const inst = input.instance;
  if (inst && (inst.kind === "radarr" || inst.kind === "sonarr") && inst.secret && !arrLinkForLibraryItem({
    type: input.item.type,
    instanceKind: inst.kind,
    instanceUrl: inst.url,
    tmdbId,
    tvdbId,
    titleSlug,
  })) {
    const ids = await fetchArrWebIds(inst, input.item, input.decrypt, input.fetch);
    if (ids) {
      tmdbId = ids.tmdbId ?? tmdbId;
      tvdbId = ids.tvdbId ?? tvdbId;
      titleSlug = ids.titleSlug ?? titleSlug;
      input.saveArrIds?.(ids);
    }
  }
  if (inst) {
    const arr = arrLinkForLibraryItem({
      type: input.item.type,
      instanceKind: inst.kind,
      instanceUrl: inst.url,
      tmdbId,
      tvdbId,
      titleSlug,
    });
    if (arr) links.push(arr);
  }
  const playerLookups = input.players.map(async (player) => {
    if (!player.enabled || !player.secret) return null;
    const token = input.decrypt(player.secret);
    if (player.kind === "plex") return lookupPlexLink(player.url, token, input.item.path, input.fetch);
    if (player.kind === "jellyfin") return lookupJellyfinLink(player.url, token, input.item.path, input.fetch);
    return null;
  });
  const found = await Promise.allSettled(playerLookups);
  for (const result of found) {
    if (result.status === "fulfilled" && result.value) links.push(result.value);
  }
  return links;
}

async function fetchArrWebIds(
  inst: StoredInstance,
  item: LibraryItem,
  decrypt: (packed: string) => string,
  httpFetch: typeof fetch,
): Promise<{ tmdbId: number | null; tvdbId: number | null; titleSlug: string | null } | null> {
  if (!inst.secret) return null;
  const auth = { url: inst.url, apiKey: decrypt(inst.secret) };
  try {
    const path = inst.kind === "radarr"
      ? `/api/v3/movie/${item.arrId}`
      : `/api/v3/series/${item.arrSeriesId ?? item.arrId}`;
    return parseArrWebIds(await fetchJson(auth, path, httpFetch));
  } catch {
    return null;
  }
}

export async function lookupPlexLink(
  baseUrl: string,
  token: string,
  filePath: string,
  httpFetch: typeof fetch,
): Promise<ExternalLink | null> {
  try {
    const identity = await playerJson(httpFetch, `${trimUrl(baseUrl)}/identity`, { "X-Plex-Token": token, Accept: "application/json" });
    const machineId = plexMachineId(identity);
    if (!machineId) return null;
    const ratingKey = await plexRatingKey(baseUrl, token, filePath, httpFetch);
    if (!ratingKey) return null;
    const href = plexDetailsHref(baseUrl, machineId, ratingKey);
    return href ? { label: "Open in Plex", href } : null;
  } catch {
    return null;
  }
}

export async function lookupJellyfinLink(
  baseUrl: string,
  token: string,
  filePath: string,
  httpFetch: typeof fetch,
): Promise<ExternalLink | null> {
  try {
    const headers = jellyfinAuthHeaders(token);
    const pathQuery = new URLSearchParams({
      recursive: "true",
      includeItemTypes: "Movie,Episode",
      filters: "IsNotFolder",
      fields: "Path",
      searchTerm: basename(filePath),
      limit: "25",
    });
    const payload = await playerJson(httpFetch, `${trimUrl(baseUrl)}/Items?${pathQuery}`, headers);
    const id = jellyfinItemIdForPath(payload, filePath);
    if (!id) return null;
    const href = jellyfinDetailsHref(baseUrl, id);
    return href ? { label: "Open in Jellyfin", href } : null;
  } catch {
    return null;
  }
}

function plexMachineId(payload: unknown): string | null {
  const row = asRecord(payload);
  const container = asRecord(row.MediaContainer) ?? row;
  const id = container.machineIdentifier;
  return typeof id === "string" && id ? id : null;
}

async function plexRatingKey(baseUrl: string, token: string, filePath: string, httpFetch: typeof fetch): Promise<string | null> {
  const headers = { "X-Plex-Token": token, Accept: "application/json" };
  const byFile = await playerJson(
    httpFetch,
    `${trimUrl(baseUrl)}/library/all?file=${encodeURIComponent(filePath)}`,
    headers,
  );
  const direct = firstPlexRatingKey(byFile);
  if (direct) return direct;
  const byName = await playerJson(
    httpFetch,
    `${trimUrl(baseUrl)}/hubs/search?query=${encodeURIComponent(basename(filePath))}&limit=8`,
    headers,
  );
  return firstPlexRatingKey(byName);
}

function firstPlexRatingKey(payload: unknown): string | null {
  const row = asRecord(payload);
  const container = asRecord(row.MediaContainer) ?? row;
  const meta = container.Metadata;
  const first = Array.isArray(meta) ? asRecord(meta[0]) : asRecord(meta);
  const key = first?.ratingKey;
  return key == null ? null : String(key);
}

function jellyfinItemIdForPath(payload: unknown, filePath: string): string | null {
  const row = asRecord(payload);
  const items = Array.isArray(row.Items) ? row.Items : [];
  const wanted = filePath.replace(/\\/g, "/").toLowerCase();
  const file = basename(filePath).toLowerCase();
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item.Id && !item.id && !item.Path) continue;
    const path = String(item.Path ?? "").replace(/\\/g, "/").toLowerCase();
    if (path === wanted || path.endsWith(`/${file}`)) {
      const id = item.Id ?? item.id;
      if (id) return String(id);
    }
  }
  return null;
}

async function playerJson(httpFetch: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await httpFetch(url, { headers, signal: AbortSignal.timeout(4_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
