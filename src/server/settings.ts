import {
  DEFAULT_SETTINGS,
  type Settings,
  type SizeCaps,
  type SuggestionDefaults,
} from "./types.ts";

type SettingsResult = { ok: true; settings: Settings } | { ok: false; error: string };

const BOOLEAN_FIELDS = [
  "languageConfirmed",
  "conservativeMode",
  "offPeakEnabled",
  "localAuthBypass",
  "profileAutoAssign",
] as const;

export function parseStoredSettings(value: unknown): Settings {
  const raw = record(value);
  const valid: Record<string, unknown> = {};
  for (const field of BOOLEAN_FIELDS) if (typeof raw[field] === "boolean") valid[field] = raw[field];
  for (const field of ["preferredLanguage", "reviewPath", "offPeakStart", "offPeakEnd", "defaultEncodeNodeId"] as const) {
    if (typeof raw[field] === "string") valid[field] = raw[field];
  }
  if (raw.videoTarget === "hevc" || raw.videoTarget === "av1") valid.videoTarget = raw.videoTarget;
  if (raw.writeMode === "sidecar" || raw.writeMode === "direct") valid.writeMode = raw.writeMode;
  if (integerInRange(raw.concurrency, 1, 16)) valid.concurrency = raw.concurrency;
  if (integerInRange(raw.inspectConcurrency, 1, 16)) valid.inspectConcurrency = raw.inspectConcurrency;
  if (typeof raw.queueNewImportsSince === "number" && Number.isFinite(raw.queueNewImportsSince) && raw.queueNewImportsSince >= 0) {
    valid.queueNewImportsSince = raw.queueNewImportsSince;
  }
  const sizeCaps = validSizeCaps(raw.sizeCaps, DEFAULT_SETTINGS.sizeCaps, false);
  const suggestionDefaults = validSuggestionDefaults(raw.suggestionDefaults, DEFAULT_SETTINGS.suggestionDefaults, false);
  return {
    ...DEFAULT_SETTINGS,
    ...valid,
    sizeCaps,
    suggestionDefaults,
  };
}

export function updateSettings(current: Settings, value: unknown): SettingsResult {
  const raw = record(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Settings must be a JSON object." };
  }
  for (const field of BOOLEAN_FIELDS) {
    if (field in raw && typeof raw[field] !== "boolean") return invalid(field);
  }
  if ("preferredLanguage" in raw && (typeof raw.preferredLanguage !== "string" || raw.preferredLanguage.trim().length === 0)) {
    return invalid("preferredLanguage");
  }
  if ("reviewPath" in raw && typeof raw.reviewPath !== "string") return invalid("reviewPath");
  if ("videoTarget" in raw && raw.videoTarget !== "hevc" && raw.videoTarget !== "av1") return invalid("videoTarget");
  if ("writeMode" in raw && raw.writeMode !== "sidecar" && raw.writeMode !== "direct") return invalid("writeMode");
  if ("defaultEncodeNodeId" in raw && typeof raw.defaultEncodeNodeId !== "string") return invalid("defaultEncodeNodeId");
  if ("concurrency" in raw && !integerInRange(raw.concurrency, 1, 16)) return invalid("concurrency");
  if ("inspectConcurrency" in raw && !integerInRange(raw.inspectConcurrency, 1, 16)) return invalid("inspectConcurrency");
  for (const field of ["offPeakStart", "offPeakEnd"] as const) {
    if (field in raw && (typeof raw[field] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw[field]))) return invalid(field);
  }
  const sizeCaps = validSizeCaps(raw.sizeCaps, current.sizeCaps, true);
  if (!sizeCaps) return invalid("sizeCaps");
  const suggestionDefaults = validSuggestionDefaults(raw.suggestionDefaults, current.suggestionDefaults, true);
  if (!suggestionDefaults) return invalid("suggestionDefaults");

  return {
    ok: true,
    settings: {
      preferredLanguage: stringValue(raw.preferredLanguage, current.preferredLanguage),
      languageConfirmed: booleanValue(raw.languageConfirmed, current.languageConfirmed),
      reviewPath: stringValue(raw.reviewPath, current.reviewPath),
      sizeCaps,
      suggestionDefaults,
      videoTarget: raw.videoTarget === "av1" || raw.videoTarget === "hevc" ? raw.videoTarget : current.videoTarget,
      concurrency: integerValue(raw.concurrency, current.concurrency),
      conservativeMode: booleanValue(raw.conservativeMode, current.conservativeMode),
      offPeakEnabled: booleanValue(raw.offPeakEnabled, current.offPeakEnabled),
      offPeakStart: stringValue(raw.offPeakStart, current.offPeakStart),
      offPeakEnd: stringValue(raw.offPeakEnd, current.offPeakEnd),
      localAuthBypass: booleanValue(raw.localAuthBypass, current.localAuthBypass),
      inspectConcurrency: integerValue(raw.inspectConcurrency, current.inspectConcurrency),
      writeMode: raw.writeMode === "direct" || raw.writeMode === "sidecar" ? raw.writeMode : current.writeMode,
      profileAutoAssign: booleanValue(raw.profileAutoAssign, current.profileAutoAssign),
      queueNewImportsSince: !current.suggestionDefaults.queueNewImports && suggestionDefaults.queueNewImports
        ? Date.now()
        : current.queueNewImportsSince,
      defaultEncodeNodeId: stringValue(raw.defaultEncodeNodeId, current.defaultEncodeNodeId),
    },
  };
}

function validSizeCaps(value: unknown, fallback: SizeCaps, strict: true): SizeCaps | null;
function validSizeCaps(value: unknown, fallback: SizeCaps, strict: false): SizeCaps;
function validSizeCaps(value: unknown, fallback: SizeCaps, strict: boolean): SizeCaps | null {
  if (value === undefined) return { ...fallback };
  const raw = record(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return strict ? null : { ...fallback };
  const result = { ...fallback };
  for (const key of Object.keys(fallback) as Array<keyof SizeCaps>) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] <= 0) {
      if (strict) return null;
      continue;
    }
    result[key] = raw[key];
  }
  return result;
}

function validSuggestionDefaults(value: unknown, fallback: SuggestionDefaults, strict: true): SuggestionDefaults | null;
function validSuggestionDefaults(value: unknown, fallback: SuggestionDefaults, strict: false): SuggestionDefaults;
function validSuggestionDefaults(value: unknown, fallback: SuggestionDefaults, strict: boolean): SuggestionDefaults | null {
  if (value === undefined) return { ...fallback };
  const raw = record(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return strict ? null : { ...fallback };
  const result = { ...fallback };
  for (const key of Object.keys(fallback) as Array<keyof SuggestionDefaults>) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== "boolean") {
      if (strict) return null;
      continue;
    }
    result[key] = raw[key];
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function invalid(field: string): SettingsResult {
  return { ok: false, error: `The ${field} setting is invalid.` };
}
