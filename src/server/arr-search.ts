import { fetchJson, trimUrl } from "./arr.ts";
import { normalizeLang } from "./inspect.ts";
import type { InspectionReport } from "./types.ts";

export type PreferredLanguageSearch = {
  kind: "radarr" | "sonarr";
  url: string;
  apiKey: string;
  arrId: number;
  episodeFileId: number | null;
};

export function isArrSearchOnly(actions: string[]): boolean {
  return actions.length > 0 && actions.every((action) => action === "search_language" || action === "search_release");
}

export function soleNonPreferredAudio(
  audio: InspectionReport["audio"],
  preferred: string,
): boolean {
  const usable = audio.filter((track) => track.channels > 0);
  if (usable.length !== 1) return false;
  const language = normalizeLang(usable[0]?.language ?? "und");
  if (language === "und") return false;
  return language !== normalizeLang(preferred);
}

export async function deleteArrFileAndSearch(
  input: PreferredLanguageSearch,
  httpFetch: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const app = input.kind === "radarr" ? "Radarr" : "Sonarr";
  try {
    const fileId = input.kind === "radarr"
      ? await radarrMovieFileId(input, httpFetch)
      : input.episodeFileId;
    if (fileId == null || !Number.isSafeInteger(fileId) || fileId <= 0) {
      return { ok: false, error: `${app} has no file to replace on this title.` };
    }
    const filePath = input.kind === "radarr" ? `/api/v3/moviefile/${fileId}` : `/api/v3/episodefile/${fileId}`;
    const deleted = await httpFetch(`${trimUrl(input.url)}${filePath}`, {
      method: "DELETE",
      headers: { "X-Api-Key": input.apiKey },
    });
    if (!deleted.ok) {
      return { ok: false, error: `${app} could not remove the current file. The library file is unchanged.` };
    }
    const command = input.kind === "radarr"
      ? { name: "MoviesSearch", movieIds: [input.arrId] }
      : { name: "EpisodeSearch", episodeIds: [input.arrId] };
    const searched = await httpFetch(`${trimUrl(input.url)}/api/v3/command`, {
      method: "POST",
      headers: { "X-Api-Key": input.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!searched.ok) {
      return { ok: false, error: `${app} removed the file but the search did not start. Check ${app}.` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `${app} could not be reached. The library file is unchanged.` };
  }
}

async function radarrMovieFileId(input: PreferredLanguageSearch, httpFetch: typeof fetch): Promise<number | null> {
  const payload = await fetchJson({ url: input.url, apiKey: input.apiKey }, `/api/v3/movie/${input.arrId}`, httpFetch);
  const row = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const file = row.movieFile && typeof row.movieFile === "object" ? row.movieFile as Record<string, unknown> : {};
  return typeof file.id === "number" && Number.isSafeInteger(file.id) ? file.id : null;
}
