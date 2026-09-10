import type { ArrKind, SizeCaps, SizeCategory } from "./types.ts";
import { DEFAULT_SIZE_CAPS } from "./types.ts";

const RADARR_CATEGORIES: SizeCategory[] = ["movie1080p", "movie4kSdr", "movie4kHdr"];
const SONARR_CATEGORIES: SizeCategory[] = ["tv1080p", "tv4k", "tv4kHdr"];

export const PROFILE_NAMES: Record<SizeCategory, string> = {
  movie1080p: "Polisharr Movie 1080p",
  movie4kSdr: "Polisharr Movie 4K SDR",
  movie4kHdr: "Polisharr Movie 4K HDR",
  tv1080p: "Polisharr TV 1080p",
  tv4k: "Polisharr TV 4K",
  tv4kHdr: "Polisharr TV 4K HDR",
};

export type ProfilePreview = {
  category: SizeCategory;
  name: string;
  gbPerHour: number;
  mbPerMin: number;
};

export function profilePreviews(caps: SizeCaps = DEFAULT_SIZE_CAPS): ProfilePreview[] {
  return (Object.keys(PROFILE_NAMES) as SizeCategory[]).map((category) => {
    const gbPerHour = caps[category];
    return {
      category,
      name: PROFILE_NAMES[category],
      gbPerHour,
      mbPerMin: Math.round(((gbPerHour * 1024) / 60) * 10) / 10,
    };
  });
}

export function profilesForArrKind(kind: ArrKind, caps: SizeCaps = DEFAULT_SIZE_CAPS): ProfilePreview[] {
  const wanted = kind === "radarr" ? RADARR_CATEGORIES : SONARR_CATEGORIES;
  return profilePreviews(caps).filter((preview) => wanted.includes(preview.category));
}

export type ProfileRecord = {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  items: unknown;
  raw: Record<string, unknown>;
};

export function parseProfiles(payload: unknown): ProfileRecord[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "number" || typeof rec.name !== "string") return [];
    return [
      {
        id: rec.id,
        name: rec.name,
        upgradeAllowed: rec.upgradeAllowed === true,
        items: rec.items,
        raw: rec,
      },
    ];
  });
}

export function profileAllowsQuality(items: unknown, qualityName: string): boolean {
  if (!qualityName || !Array.isArray(items)) return false;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (profileAllowsQuality(rec.items, qualityName)) return true;
    const quality = rec.quality && typeof rec.quality === "object" ? (rec.quality as Record<string, unknown>) : null;
    if (rec.allowed && quality && String(quality.name) === qualityName) return true;
  }
  return false;
}

export function pickPreventUpgradeProfile(
  profiles: ProfileRecord[],
  wantedName: string,
  currentQuality: string,
): ProfileRecord | undefined {
  const named = findNamedProfile(profiles, wantedName);
  if (named) return named;
  return profiles.find((p) => !p.upgradeAllowed && profileAllowsQuality(p.items, currentQuality));
}

export function legacyProfileName(name: string): string {
  return name.replace(/^Polisharr /, "Optimizarr ");
}

function findNamedProfile(profiles: ProfileRecord[], name: string): ProfileRecord | undefined {
  return profiles.find((p) => p.name === name) ?? profiles.find((p) => p.name === legacyProfileName(name));
}

export type SyncResult = {
  instanceId: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  failed: string[];
};

export async function syncProfiles(opts: {
  instanceId: string;
  kind: ArrKind;
  url: string;
  apiKey: string;
  caps: SizeCaps;
  fetch: typeof fetch;
}): Promise<SyncResult> {
  const result: SyncResult = { instanceId: opts.instanceId, created: [], updated: [], unchanged: [], failed: [] };
  const base = opts.url.replace(/\/+$/, "");
  const headers = { "X-Api-Key": opts.apiKey, "Content-Type": "application/json" };
  const listed = await opts.fetch(`${base}/api/v3/qualityprofile`, { headers });
  if (!listed.ok) {
    result.failed.push("Could not list quality profiles.");
    return result;
  }
  const existing = parseProfiles(await listed.json());
  for (const preview of profilesForArrKind(opts.kind, opts.caps)) {
    const found = findNamedProfile(existing, preview.name);
    if (found) {
      const desired = configuredProfile(found.raw, preview.name, preview.category);
      if (!profileNeedsUpdate(found, desired)) {
        result.unchanged.push(preview.name);
        continue;
      }
      try {
        const updated = await opts.fetch(`${base}/api/v3/qualityprofile/${found.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...desired, id: found.id }),
        });
        if (updated.ok) result.updated.push(preview.name);
        else result.failed.push(preview.name);
      } catch {
        result.failed.push(preview.name);
      }
      continue;
    }
    try {
      const created = await createNamedProfile(base, headers, existing, preview.name, opts.fetch, "", preview.category);
      if (created) result.created.push(preview.name);
      else result.failed.push(preview.name);
    } catch {
      result.failed.push(preview.name);
    }
  }
  return result;
}

export async function assignProfile(opts: {
  kind: "radarr" | "sonarr";
  connection: { url: string; apiKey: string };
  movieId?: number;
  seriesId?: number;
  profileName: string;
  currentQuality?: string;
  fetch: typeof fetch;
}): Promise<string | null> {
  const base = opts.connection.url.replace(/\/+$/, "");
  const headers = { "X-Api-Key": opts.connection.apiKey, "Content-Type": "application/json" };
  const listed = await opts.fetch(`${base}/api/v3/qualityprofile`, { headers });
  if (!listed.ok) return "Could not list quality profiles.";
  const profiles = parseProfiles(await listed.json());
  let currentQuality = opts.currentQuality ?? "";
  let resource: Record<string, unknown> | null = null;
  let resourceUrl = "";
  if (opts.kind === "radarr" && opts.movieId != null) {
    resourceUrl = `${base}/api/v3/movie/${opts.movieId}`;
    resource = await getRecord(resourceUrl, headers, opts.fetch);
    currentQuality = movieQualityName(resource) || currentQuality;
  } else if (opts.kind === "sonarr" && opts.seriesId != null) {
    resourceUrl = `${base}/api/v3/series/${opts.seriesId}`;
    resource = await getRecord(resourceUrl, headers, opts.fetch);
  }
  if (!resource || !resourceUrl) return "That title has no Arr id for profile assignment.";

  let profile = pickPreventUpgradeProfile(profiles, opts.profileName, currentQuality);
  if (!profile) {
    const created = await createNamedProfile(
      base,
      headers,
      profiles,
      opts.profileName,
      opts.fetch,
      currentQuality,
      categoryForProfileName(opts.profileName),
    );
    if (!created) return `Could not create the ${opts.profileName} profile.`;
    profile = created;
  }

  resource.qualityProfileId = profile.id;
  const res = await opts.fetch(resourceUrl, { method: "PUT", headers, body: JSON.stringify(resource) });
  if (!res.ok) return `${opts.kind === "radarr" ? "Radarr" : "Sonarr"} rejected the profile assign (HTTP ${res.status}).`;
  if (opts.kind === "sonarr") return "This Sonarr profile applies to the whole series, including future episodes.";
  return null;
}

async function getRecord(url: string, headers: Record<string, string>, httpFetch: typeof fetch): Promise<Record<string, unknown> | null> {
  const res = await httpFetch(url, { headers });
  if (!res.ok) return null;
  const payload: unknown = await res.json();
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

function movieQualityName(movie: Record<string, unknown> | null): string {
  if (!movie) return "";
  const file = movie.movieFile && typeof movie.movieFile === "object" ? (movie.movieFile as Record<string, unknown>) : null;
  const wrap = file?.quality && typeof file.quality === "object" ? (file.quality as Record<string, unknown>) : null;
  const quality = wrap?.quality && typeof wrap.quality === "object" ? (wrap.quality as Record<string, unknown>) : null;
  return typeof quality?.name === "string" ? quality.name : "";
}

async function createNamedProfile(
  base: string,
  headers: Record<string, string>,
  existing: ProfileRecord[],
  name: string,
  httpFetch: typeof fetch,
  currentQuality = "",
  category?: SizeCategory,
): Promise<ProfileRecord | null> {
  const schemaRes = await httpFetch(`${base}/api/v3/qualityprofile/schema`, { headers });
  const schema = schemaRes.ok ? ((await schemaRes.json()) as Record<string, unknown>) : {};
  const donor =
    existing.find((p) => profileAllowsQuality(p.items, currentQuality)) ?? existing[0];
  const baseBody: Record<string, unknown> = {
    ...(schema && typeof schema === "object" ? schema : {}),
    ...(donor?.raw ?? {}),
    name,
    upgradeAllowed: false,
  };
  const body = category ? configuredProfile(baseBody, name, category) : baseBody;
  delete body.id;
  const res = await httpFetch(`${base}/api/v3/qualityprofile`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const created: unknown = await res.json();
  const parsed = parseProfiles([created]);
  return parsed[0] ?? null;
}

function categoryForProfileName(name: string): SizeCategory | undefined {
  return (Object.keys(PROFILE_NAMES) as SizeCategory[]).find(
    (category) => PROFILE_NAMES[category] === name || legacyProfileName(PROFILE_NAMES[category]) === name,
  );
}

function configuredProfile(raw: Record<string, unknown>, name: string, category: SizeCategory): Record<string, unknown> {
  const items = configureQualityItems(raw.items, category);
  const allowedIds = qualityIds(items);
  return {
    ...raw,
    name,
    upgradeAllowed: false,
    items,
    ...(allowedIds.length > 0 ? { cutoff: allowedIds.at(-1) } : {}),
  };
}

function configureQualityItems(items: unknown[], category: SizeCategory): unknown[];
function configureQualityItems(items: unknown, category: SizeCategory): unknown;
function configureQualityItems(items: unknown, category: SizeCategory): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const row = raw as Record<string, unknown>;
    const nestedItems = Array.isArray(row.items) ? configureQualityItems(row.items, category) : undefined;
    const quality = row.quality && typeof row.quality === "object"
      ? row.quality as Record<string, unknown>
      : null;
    const qualityName = typeof quality?.name === "string" ? quality.name : null;
    const allowed = qualityName
      ? categoryAllowsQuality(category, qualityName)
      : nestedItems
        ? nestedItems.some(containsAllowedQuality)
        : row.allowed;
    return {
      ...row,
      ...(typeof allowed === "boolean" ? { allowed } : {}),
      ...(nestedItems ? { items: nestedItems } : {}),
    };
  });
}

function containsAllowedQuality(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  return row.allowed === true || (Array.isArray(row.items) && row.items.some(containsAllowedQuality));
}

function categoryAllowsQuality(category: SizeCategory, qualityName: string): boolean {
  const name = qualityName.toLowerCase();
  if (name.includes("remux")) return false;
  const is4k = category === "movie4kSdr" || category === "movie4kHdr" || category === "tv4k" || category === "tv4kHdr";
  return is4k ? /2160|4k|uhd/.test(name) : !/2160|4k|uhd/.test(name);
}

function qualityIds(items: unknown): number[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const nested = qualityIds(row.items);
    const quality = row.quality && typeof row.quality === "object"
      ? row.quality as Record<string, unknown>
      : null;
    return row.allowed === true && typeof quality?.id === "number" ? [...nested, quality.id] : nested;
  });
}

function profileNeedsUpdate(profile: ProfileRecord, desired: Record<string, unknown>): boolean {
  return profile.upgradeAllowed || JSON.stringify(profile.items) !== JSON.stringify(desired.items) ||
    (typeof desired.cutoff === "number" && profile.raw.cutoff !== desired.cutoff);
}
