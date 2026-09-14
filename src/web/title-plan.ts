export function titleOptimizeLocked(item: {
  mediaState?: "waiting" | "unreadable" | "inspected";
  inspected?: boolean;
  error?: string | null;
  path?: string;
}): boolean {
  const iso = (item.path ?? "").toLowerCase().endsWith(".iso");
  if (iso) return false;
  if (item.mediaState === "unreadable" || item.mediaState === "waiting") return true;
  if (item.error) return true;
  if (item.inspected === false) return true;
  return false;
}

export const audioActionSelectClass = "h-10 w-56 max-w-full shrink-0";
export const audioChannelSelectClass = "h-10 w-24 shrink-0";

export function canQueueCustomPlan(
  plan: { video?: { kind?: string } } | null,
  errors: string[],
  locked: boolean,
): boolean {
  return Boolean(plan) && errors.length === 0 && !locked;
}

export function isUntaggedTrack(track: { language?: string; untagged?: boolean } | undefined): boolean {
  if (!track) return false;
  if (track.untagged === true) return true;
  const language = (track.language ?? "und").trim().toLowerCase();
  return language === "" || language === "und" || language === "unknown" || language === "any";
}

export function canIdentifyLanguage(track: { language?: string; untagged?: boolean; channels?: number } | undefined, available: boolean, locked: boolean): boolean {
  if (!available || locked || !track) return false;
  if ((track.channels ?? 0) <= 0) return false;
  return isUntaggedTrack(track);
}

export const MISSING_WHISPER_LID = "Identify language needs WHISPER_LID. Polisharr will not pretend to listen.";

export function untaggedAudioNeedsLanguageIdHint(
  track: { language?: string; untagged?: boolean; channels?: number } | undefined,
  available: boolean,
  locked: boolean,
): boolean {
  if (available || locked || !track) return false;
  if ((track.channels ?? 0) <= 0) return false;
  return isUntaggedTrack(track);
}

const TEXT_SUBTITLE_CODECS = new Set([
  "mov_text",
  "eia_608",
  "eia_608_closed_captions",
  "webvtt",
  "subrip",
  "srt",
  "ass",
  "ssa",
  "text",
  "ttxt",
]);

export function canIdentifySubtitle(
  track: { language?: string; untagged?: boolean; codec?: string } | undefined,
  locked: boolean,
  pgsAvailable = false,
): boolean {
  if (locked || !track) return false;
  if (!isUntaggedTrack(track)) return false;
  const codec = (track.codec ?? "").toLowerCase().replace(/-/g, "_");
  if (TEXT_SUBTITLE_CODECS.has(codec)) return true;
  return pgsAvailable && codec.includes("pgs");
}

export type AudioAction = "keep" | "remove" | "replace_aac" | "replace_downmix" | "add_downmix";

export function applyPlaybackAudioDraft(
  current: Record<number, { action: AudioAction; channels?: number }>,
  choices: Array<{ index?: number; action?: string; channels?: number }> | undefined,
): Record<number, { action: AudioAction; channels?: number }> {
  if (!choices) return current;
  const next = { ...current };
  for (const choice of choices) {
    if (typeof choice.index !== "number") continue;
    const action = parseAudioAction(choice.action);
    next[choice.index] = { action, channels: choice.channels ?? next[choice.index]?.channels ?? 2 };
  }
  return next;
}

export function playbackVideoMode(draft: { video?: { mode?: string } } | null | undefined): "copy" | "size" | "quality" {
  const mode = draft?.video?.mode;
  if (mode === "size" || mode === "quality") return mode;
  return "copy";
}

function parseAudioAction(value: string | undefined): AudioAction {
  if (value === "keep" || value === "remove" || value === "replace_aac" || value === "replace_downmix" || value === "add_downmix") {
    return value;
  }
  return "keep";
}

export function isImageSubtitle(codec: string | undefined): boolean {
  const name = (codec ?? "").toLowerCase();
  return name.includes("pgs") || name.includes("dvd_subtitle") || name.includes("dvb_subtitle") || name.includes("xsub") || name.includes("vobsub");
}

export function formatClipClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function parseClipClock(value: string): number | null {
  const trimmed = value.trim();
  const clock = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Math.floor(Number(trimmed));
}
