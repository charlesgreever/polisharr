import type { InspectionReport } from "./types.ts";

type ProbeStream = {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  coded_width?: unknown;
  coded_height?: unknown;
  disposition?: unknown;
  tags?: unknown;
  channels?: unknown;
  bits_per_raw_sample?: unknown;
  pix_fmt?: unknown;
  color_transfer?: unknown;
  side_data_list?: unknown;
  bit_rate?: unknown;
  duration?: unknown;
  index?: unknown;
};

export function parseFfprobe(path: string, sizeBytes: number, probe: Record<string, unknown>): InspectionReport {
  const format = asRecord(probe.format);
  const streams = Array.isArray(probe.streams) ? probe.streams.filter(isRecord) : [];
  const durationSec = numberOr(format.duration, 0);
  const video = pickPlayableVideo(streams);
  const width = intOr(video?.width, intOr(video?.coded_width, 0));
  const height = intOr(video?.height, intOr(video?.coded_height, 0));
  const audio = streams.filter((s) => s.codec_type === "audio").map(parseAudio);
  const subtitles = streams.filter((s) => s.codec_type === "subtitle").map(parseSub);
  const hours = durationSec > 0 ? durationSec / 3600 : 0;
  return {
    sourceSig: `${path}|${sizeBytes}`,
    sourceMethod: "ffprobe",
    listingState: "complete",
    durationSec,
    isoPlaylist: null,
    sizeBytes,
    sizePerHourGb: hours > 0 ? sizeBytes / (1024 ** 3) / hours : 0,
    videoCodec: stringOr(video?.codec_name, "unknown"),
    videoIndex: video ? intOr(video.index, 0) : undefined,
    width,
    height,
    bitDepth: bitDepth(video),
    hdr: hdrKind(video, format),
    audio,
    subtitles,
    hasChapters: Array.isArray(probe.chapters) && probe.chapters.length > 0,
    hasAttachments: streams.some((s) => s.codec_type === "attachment"),
    attachmentBytes: streams.filter((s) => s.codec_type === "attachment").reduce((sum, s) => sum + intOr(s.size, 0), 0),
    chapterCount: Array.isArray(probe.chapters) ? probe.chapters.length : 0,
  };
}

export function pickPlayableVideo(streams: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const videos = streams.filter((s) => s.codec_type === "video" && !isCoverArt(s));
  if (videos.length === 0) return streams.find((s) => s.codec_type === "video");
  return videos.sort((a, b) => area(b) - area(a))[0];
}

function isCoverArt(stream: Record<string, unknown>): boolean {
  const disp = asRecord(stream.disposition);
  if (disp.attached_pic === 1 || disp.attached_pic === "1") return true;
  return stringOr(stream.codec_name, "") === "mjpeg";
}

function area(stream: Record<string, unknown>): number {
  const w = intOr(stream.width, intOr(stream.coded_width, 0));
  const h = intOr(stream.height, intOr(stream.coded_height, 0));
  return w * h;
}

function parseAudio(stream: Record<string, unknown>, i: number): InspectionReport["audio"][number] {
  const tags = asRecord(stream.tags);
  const language = normalizeLang(stringOr(tags.language, "und"));
  const title = stringOr(tags.title, "");
  return {
    index: intOr(stream.index, i),
    language,
    channels: intOr(stream.channels, 2),
    codec: stringOr(stream.codec_name, "unknown"),
    title,
    untagged: language === "und",
    commentary: /comment/i.test(title),
    bitrateBps: intOr(stream.bit_rate, 0) || undefined,
    sizeBytes: intOr(tags.NUMBER_OF_BYTES ?? tags.number_of_bytes, 0) || undefined,
    default: dispositionDefault(stream.disposition),
  };
}

function parseSub(stream: Record<string, unknown>, i: number): InspectionReport["subtitles"][number] {
  const tags = asRecord(stream.tags);
  const language = normalizeLang(stringOr(tags.language, "und"));
  const title = stringOr(tags.title, "");
  const disp = asRecord(stream.disposition);
  return {
    index: intOr(stream.index, i),
    language,
    codec: stringOr(stream.codec_name, "unknown"),
    title,
    untagged: language === "und",
    forced: disp.forced === 1 || /forced/i.test(title),
    sdh: /sdh|hearing/i.test(title),
    hearingImpaired: /sdh|hearing/i.test(title) || dispositionHearing(disp),
    bitrateBps: intOr(stream.bit_rate, 0) || undefined,
    sizeBytes: intOr(tags.NUMBER_OF_BYTES ?? tags.number_of_bytes, 0) || undefined,
    default: dispositionDefault(disp),
  };
}

function bitDepth(video: Record<string, unknown> | undefined): number {
  if (!video) return 8;
  const raw = intOr(video.bits_per_raw_sample, 0);
  if (raw) return raw;
  const pix = stringOr(video.pix_fmt, "");
  if (pix.includes("p10") || pix.includes("10le")) return 10;
  if (pix.includes("p12")) return 12;
  return 8;
}

function hdrKind(
  video: Record<string, unknown> | undefined,
  format: Record<string, unknown>,
): InspectionReport["hdr"] {
  const tags = { ...asRecord(video?.tags), ...asRecord(format.tags) };
  const blob = JSON.stringify({ video, tags }).toLowerCase();
  if (blob.includes("dolby") || blob.includes("dovi") || blob.includes("dvhe")) return "dolby_vision";
  if (blob.includes("hdr10+") || blob.includes("hdr10plus")) return "hdr10plus";
  const transfer = stringOr(video?.color_transfer, "").toLowerCase();
  if (transfer.includes("smpte2084") || transfer.includes("arib-std-b67") || blob.includes("hdr10")) return "hdr10";
  return "none";
}

export function isUntaggedLanguage(value: string | undefined): boolean {
  const v = (value ?? "und").trim().toLowerCase();
  return v === "" || v === "und" || v === "unknown" || v === "any";
}

export function normalizeLang(value: string): string {
  const v = value.toLowerCase();
  const aliases: Record<string, string> = { en: "eng", english: "eng", fr: "fra", fre: "fra", french: "fra", de: "deu", ger: "deu", german: "deu", es: "spa", spanish: "spa", it: "ita", italian: "ita", pt: "por", portuguese: "por", ja: "jpn", japanese: "jpn", ko: "kor", korean: "kor", zh: "zho", chinese: "zho", ru: "rus", russian: "rus" };
  if (aliases[v]) return aliases[v];
  if (isUntaggedLanguage(v)) return "und";
  return v.slice(0, 3);
}

export function normalizeInspection(raw: Record<string, unknown>, path = "", sizeBytes = 0): InspectionReport {
  const sourceMethod = raw.sourceMethod === "iso_ffmpeg" ? "iso_ffmpeg" : "ffprobe";
  const listingState = raw.listingState === "iso_unlisted" ? "iso_unlisted" : "complete";
  return {
    sourceSig: typeof raw.sourceSig === "string" ? raw.sourceSig : `${path}|${sizeBytes}`,
    sourceMethod,
    listingState,
    durationSec: typeof raw.durationSec === "number" ? raw.durationSec : 0,
    isoPlaylist: typeof raw.isoPlaylist === "number" ? raw.isoPlaylist : null,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : sizeBytes,
    sizePerHourGb: typeof raw.sizePerHourGb === "number" ? raw.sizePerHourGb : 0,
    videoCodec: typeof raw.videoCodec === "string" ? raw.videoCodec : "unknown",
    videoIndex: typeof raw.videoIndex === "number" ? raw.videoIndex : undefined,
    width: typeof raw.width === "number" ? raw.width : 0,
    height: typeof raw.height === "number" ? raw.height : 0,
    bitDepth: typeof raw.bitDepth === "number" ? raw.bitDepth : 8,
    hdr: raw.hdr === "hdr10" || raw.hdr === "hdr10plus" || raw.hdr === "dolby_vision" ? raw.hdr : "none",
    audio: Array.isArray(raw.audio) ? (raw.audio as InspectionReport["audio"]).map(withNormalizedLanguage) : [],
    subtitles: Array.isArray(raw.subtitles) ? (raw.subtitles as InspectionReport["subtitles"]).map(withNormalizedLanguage) : [],
    hasChapters: Boolean(raw.hasChapters),
    hasAttachments: Boolean(raw.hasAttachments),
    attachmentBytes: typeof raw.attachmentBytes === "number" ? raw.attachmentBytes : undefined,
    chapterCount: typeof raw.chapterCount === "number" ? raw.chapterCount : undefined,
  };
}

function dispositionDefault(value: unknown): boolean {
  const d = asRecord(value);
  return d.default === 1 || d.default === "1";
}

function dispositionHearing(value: unknown): boolean {
  const d = asRecord(value);
  return d.hearing_impaired === 1 || d.hearing_impaired === "1";
}

function withNormalizedLanguage<T extends { language: string; untagged: boolean; languagePending?: boolean }>(track: T): T {
  const language = normalizeLang(track.language);
  const untagged = track.untagged || language === "und";
  return {
    ...track,
    language,
    untagged,
    languagePending: Boolean(track.languagePending) && language !== "und",
  };
}

export function parseFfmpegListing(path: string, sizeBytes: number, listing: string): InspectionReport {
  const streams = [...listing.matchAll(/Stream #0:(\d+)(?:\[[^\]]*\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): ([^\n]+)/g)];
  if (streams.length === 0) return unlistedIsoReport(path, sizeBytes);
  const videoLine = streams.find((m) => m[3] === "Video")?.[4] ?? "";
  const size = videoLine.match(/(\d{3,5})x(\d{3,5})/);
  const langs = parseBlurayStreamLanguages(listing);
  const audio = streams.filter((m) => m[3] === "Audio").map((m, i) => withListedLanguage(parseListedAudio(m, i), langs));
  const subtitles = streams.filter((m) => m[3] === "Subtitle").map((m, i) => withListedLanguage(parseListedSub(m, i), langs));
  const playlist = longestBlurayPlaylist(listing);
  const listedDuration = parseListedDuration(listing);
  const durationSec = featureDurationSec(listedDuration, playlist?.durationSec ?? 0);
  const hours = durationSec > 0 ? durationSec / 3600 : 0;
  const codec = videoLine.split(",")[0]?.trim().split(" ")[0] ?? "unknown";
  return {
    sourceSig: `${path}|${sizeBytes}`,
    sourceMethod: "iso_ffmpeg",
    listingState: "complete",
    durationSec,
    isoPlaylist: playlist?.id ?? null,
    sizeBytes,
    sizePerHourGb: hours > 0 ? sizeBytes / 1024 ** 3 / hours : 0,
    videoCodec: codec,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    bitDepth: /10\s*bit|p10|yuv420p10/i.test(videoLine) ? 10 : 8,
    hdr: /dolby|dovi|hdr10\+|hdr10|smpte2084/i.test(listing) ? (/dolby|dovi/i.test(listing) ? "dolby_vision" : "hdr10") : "none",
    audio,
    subtitles,
    hasChapters: /Chapter #/i.test(listing),
    hasAttachments: false,
  };
}

export function parseListedDuration(listing: string): number {
  const match = listing.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return clockToSeconds(match[1], match[2], match[3]);
}

export function parseBlurayStreamLanguages(listing: string): Map<number, string> {
  const langs = new Map<number, string>();
  for (const row of listing.matchAll(/stream\s+(\d+)\s*:[^\n]*\blang(?:uage)?\s*[=:]\s*([A-Za-z]{2,3})\b/gi)) {
    const language = normalizeLang(row[2] ?? "und");
    if (language !== "und") langs.set(Number(row[1]), language);
  }
  return langs;
}

function withListedLanguage<T extends { index: number; language: string; untagged: boolean }>(
  track: T,
  langs: Map<number, string>,
): T {
  if (track.language !== "und") return track;
  const language = langs.get(track.index);
  if (!language) return track;
  return { ...track, language, untagged: false };
}

export function parseBlurayPlaylists(listing: string): Array<{ id: number; durationSec: number }> {
  return [...listing.matchAll(/playlist\s+(\d+)\.mpls\s+\(([^)]+)\)/gi)].map((row) => {
    const parts = row[2]?.split(":") ?? [];
    const durationSec = parts.length === 3
      ? clockToSeconds(parts[0], parts[1], parts[2])
      : parts.length === 2
        ? clockToSeconds("0", parts[0], parts[1])
        : 0;
    return { id: Number(row[1]), durationSec };
  });
}

export function longestBlurayPlaylist(listing: string): { id: number; durationSec: number } | undefined {
  return parseBlurayPlaylists(listing).sort((a, b) => b.durationSec - a.durationSec)[0];
}

export const MAX_FEATURE_SEC = 8 * 3600;

export function featureDurationSec(listedDuration: number, playlistDuration: number): number {
  if (listedDuration > MAX_FEATURE_SEC && playlistDuration > 0) return playlistDuration;
  if (listedDuration > MAX_FEATURE_SEC) return 0;
  return Math.max(listedDuration, playlistDuration);
}

export function isoInspectionLooksStale(report: InspectionReport | undefined, path: string): boolean {
  if (!isIsoPath(path)) return false;
  if (!report) return true;
  return report.sourceMethod !== "iso_ffmpeg";
}

export function isoListingLooksUsable(listing: string): boolean {
  if (!/Stream #0:\d+[^\n]*: Video:/i.test(listing)) return false;
  const duration = featureDurationSec(parseListedDuration(listing), longestBlurayPlaylist(listing)?.durationSec ?? 0);
  if (duration <= 0) return true;
  return duration >= 60 && duration <= MAX_FEATURE_SEC;
}

function clockToSeconds(hours: string, minutes: string, seconds: string): number {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function listedChannels(detail: string): number {
  if (/\b0\s*channels\b/i.test(detail)) return 0;
  if (/\b7\.1\b/.test(detail)) return 8;
  if (/\b5\.1\b/.test(detail)) return 6;
  if (/\bmono\b/i.test(detail)) return 1;
  return 2;
}

function parseListedAudio(match: RegExpMatchArray, i: number): InspectionReport["audio"][number] {
  const detail = match[4] ?? "";
  const language = normalizeLang(match[2] ?? "und");
  return {
    index: Number(match[1] ?? i),
    language,
    channels: listedChannels(detail),
    codec: detail.split(",")[0]?.trim().split(" ")[0] ?? "unknown",
    title: "",
    untagged: language === "und",
    commentary: /comment/i.test(detail),
  };
}

function parseListedSub(match: RegExpMatchArray, i: number): InspectionReport["subtitles"][number] {
  const detail = match[4] ?? "";
  const language = normalizeLang(match[2] ?? "und");
  return {
    index: Number(match[1] ?? i),
    language,
    codec: detail.split(",")[0]?.trim().split(" ")[0] ?? "unknown",
    title: "",
    untagged: language === "und",
    forced: /forced/i.test(detail),
    sdh: /sdh|hearing/i.test(detail),
  };
}

export function isIsoPath(path: string): boolean {
  return path.toLowerCase().endsWith(".iso");
}

export function isMediaFilePath(path: string): boolean {
  return /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|mts|iso|mk3d|webm)$/i.test(path);
}

export function trackEditingAvailable(report: InspectionReport): boolean {
  return report.listingState === "complete";
}

export function unlistedIsoReport(path: string, sizeBytes: number): InspectionReport {
  return {
    sourceSig: `${path}|${sizeBytes}`,
    sourceMethod: "iso_ffmpeg",
    listingState: "iso_unlisted",
    durationSec: 0,
    isoPlaylist: null,
    sizeBytes,
    sizePerHourGb: 0,
    videoCodec: "unknown",
    width: 0,
    height: 0,
    bitDepth: 8,
    hdr: "none",
    audio: [],
    subtitles: [],
    hasChapters: false,
    hasAttachments: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function intOr(value: unknown, fallback: number): number {
  return Math.round(numberOr(value, fallback));
}
