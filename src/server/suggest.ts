import type {
  AudioMix,
  InspectionReport,
  LibraryItem,
  Settings,
  SizeCategory,
  Suggestion,
  SuggestionAction,
  VideoTarget,
} from "./types.ts";
import { normalizeLang } from "./inspect.ts";
import {
  audioFillsSizeCap,
  copiedAudioBitrateBps,
  exceedsSizeCap,
  raisedTargetBytes,
  remainingSizeAfterTrackPlan,
  typicalAudioBitrateBps,
} from "./size-budget.ts";
import { soleNonPreferredAudio } from "./arr-search.ts";
import { isDolbyVisionProfile5 } from "./inspect.ts";

export type SuggestInput = {
  item: LibraryItem;
  report: InspectionReport;
  settings: Settings;
  sizeExempt: boolean;
  excluded: boolean;
  forceTranscode?: boolean;
  forceStereo?: boolean;
  videoTarget: VideoTarget;
  av1Available: boolean;
  hardwareAvailable?: boolean;
  audioMix?: AudioMix | null;
};

export function sizeCategory(item: LibraryItem, report: InspectionReport): SizeCategory {
  const isTv = item.type === "episode";
  const fourK = is4k(item, report);
  const hdr = report.hdr !== "none" || /hdr|dolby|dv/i.test(`${item.quality} ${item.resolution}`);
  if (isTv) {
    if (!fourK) return "tv1080p";
    return hdr ? "tv4kHdr" : "tv4k";
  }
  if (fourK) return hdr ? "movie4kHdr" : "movie4kSdr";
  return "movie1080p";
}

export function is4k(item: LibraryItem, report: InspectionReport): boolean {
  const label = `${item.quality} ${item.resolution}`.toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(label)) return true;
  return report.height >= 2160 || report.width >= 3840;
}

export function buildSuggestion(input: SuggestInput): Suggestion | null {
  if (input.excluded) return null;
  if (input.report.listingState === "iso_unlisted" && !input.settings.suggestionDefaults.convertIsoToMkv) return null;
  const { item, report, settings } = input;
  const category = sizeCategory(item, report);
  const cap = settings.sizeCaps[category];
  const lang = normalizeLang(settings.preferredLanguage);
  const onlyWrongLanguage = soleNonPreferredAudio(report.audio, lang);
  let keepAudio = onlyWrongLanguage
    ? report.audio.filter((track) => track.channels > 0)
    : settings.suggestionDefaults.removeNonPreferredAudio
      ? report.audio.filter((t) => shouldKeepAudio(t, lang, report.audio.length))
      : report.audio;
  let stripAudio = report.audio.filter((t) => !keepAudio.includes(t));
  if (keepAudio.length === 0) {
    const fallback = report.audio.find((track) => track.channels > 0 && !track.commentary)
      ?? report.audio.find((track) => track.channels > 0);
    if (fallback) {
      keepAudio = [fallback];
      stripAudio = stripAudio.filter((track) => track.index !== fallback.index);
    }
  }
  const keepSubs = settings.suggestionDefaults.removeNonPreferredSubtitles
    ? report.subtitles.filter((t) => t.language === lang || (t.untagged && report.subtitles.length === 1))
    : report.subtitles;
  const stripSubs = report.subtitles.filter((t) => !keepSubs.includes(t));
  const surroundToReplace = input.audioMix === "stereo" ? keepAudio.filter((track) => track.channels > 2) : [];
  if (surroundToReplace.length) {
    keepAudio = keepAudio.filter((track) => track.channels <= 2);
    stripAudio = [...stripAudio, ...surroundToReplace];
  }
  const extraTracks = stripAudio.length + stripSubs.length > 0;
  const alreadyStereo = keepAudio.some((t) => t.channels <= 2 && (t.language === lang || t.language === "und"));
  const addStereo = surroundToReplace.length
    ? !alreadyStereo
    : shouldSuggestStereo({
      audio: report.audio,
      lang,
      addStereoDefault: settings.suggestionDefaults.addStereo,
      audioMix: input.audioMix,
      forceStereo: input.forceStereo,
      alreadyStereo,
    });
  const stereoSource = addStereo
    ? surroundToReplace[0]?.index ?? keepAudio.find((track) => track.channels > 2)?.index ?? keepAudio[0]?.index
    : undefined;
  const extraAudioBitrateBps = addStereo ? typicalAudioBitrateBps({ codec: "aac", channels: 2 }) : 0;
  const hours = report.durationSec > 0 ? report.durationSec / 3600 : 0;
  const scoredBytes = hours > 0 && report.sizePerHourGb > 0
    ? Math.round(report.sizePerHourGb * hours * 1024 ** 3)
    : report.sizeBytes;
  const remaining = remainingSizeAfterTrackPlan({
    sizeBytes: scoredBytes,
    durationSec: report.durationSec,
    stripAudio,
    stripSubs,
    extraAudioBitrateBps,
  });
  const remainingGbPerHour = stripAudio.length === 0 && stripSubs.length === 0 && extraAudioBitrateBps === 0
    ? report.sizePerHourGb
    : remaining.remainingSizePerHourGb;
  const overCap = exceedsSizeCap(remainingGbPerHour, cap);
  const keptAudioBps = copiedAudioBitrateBps(keepAudio, report.durationSec) + extraAudioBitrateBps;
  const capBytes = Math.round(cap * hours * 1024 ** 3);
  const audioBound = audioFillsSizeCap({
    targetBytes: capBytes,
    durationSec: report.durationSec,
    audioBitrateBps: keptAudioBps,
  });
  const codec = report.videoCodec.toLowerCase();
  const alreadyAv1 = codec.includes("av1");
  const belowHevc = !codecIsAtLeastHevc(report.videoCodec);
  const target: VideoTarget = input.videoTarget === "av1" && input.av1Available ? "av1" : "hevc";
  const transcodeForCap = settings.suggestionDefaults.transcodeToSizeCap && overCap && !audioBound && (belowHevc || /hevc|h265/.test(codec));
  const transcodeForCodec = settings.suggestionDefaults.transcodeBelowHevc && codecIsBelowEncodeTarget(report.videoCodec, target);
  const wantTranscode =
    !alreadyAv1 &&
    !input.sizeExempt &&
    (input.forceTranscode || transcodeForCap || transcodeForCodec);
  const skipDvP5 = isDolbyVisionProfile5(report);
  const transcode = wantTranscode && !skipDvP5;
  const remux = (settings.suggestionDefaults.convertMp4ToMkv && /\.mp4$/i.test(item.path))
    || (settings.suggestionDefaults.convertIsoToMkv && /\.iso$/i.test(item.path));

  const actions: SuggestionAction[] = [];
  if (transcode) actions.push("transcode");
  if (remux) actions.push("remux");
  if (extraTracks) actions.push("tracks");
  if (addStereo) actions.push("add_stereo");
  const searchLanguage = settings.suggestionDefaults.searchPreferredLanguage && onlyWrongLanguage;
  if (searchLanguage && actions.length === 0) actions.push("search_language");
  if (skipDvP5 && !actions.includes("search_release")) actions.push("search_release");
  if (actions.length === 0) return null;

  const reasons: string[] = [];
  if (transcode && transcodeForCap) {
    reasons.push(
      extraTracks
        ? `Over the size cap after dropping extra languages: ${remainingGbPerHour.toFixed(2)} GB/hr left, ${cap.toFixed(2)} GB/hr allowed.`
        : `Over the size cap: ${remainingGbPerHour.toFixed(2)} GB/hr now, ${cap.toFixed(2)} GB/hr allowed.`,
    );
  }
  if (transcode && transcodeForCodec) {
    reasons.push(`This video is ${codecLabel(report.videoCodec)}. Re-encode to ${target.toUpperCase()}.`);
  } else if (transcode && input.forceTranscode && !transcodeForCap) {
    reasons.push(`Re-encode to ${target.toUpperCase()} because you asked to force this title.`);
  }
  if (remux && /\.iso$/i.test(item.path)) reasons.push("Convert the disc image to MKV.");
  else if (remux) reasons.push("Convert the MP4 container to MKV before any video encode.");
  if (stripAudio.length) reasons.push("Drop audio tracks that are not in your preferred language.");
  if (stripSubs.length) reasons.push("Drop subtitle tracks that are not in your preferred language.");
  if (surroundToReplace.length && addStereo) {
    reasons.push("Replace surround audio with AAC stereo so a TV can play dialogue.");
  } else if (surroundToReplace.length) {
    reasons.push("Drop surround audio and keep the stereo track.");
  } else if (addStereo) {
    reasons.push("Add an AAC stereo track so a TV can play dialogue without surround.");
  }
  if (searchLanguage) reasons.push("The only audio track is not in your preferred language.");

  const warnings: string[] = [];
  if (transcode && input.hardwareAvailable === false) {
    warnings.push("Hardware encode is unavailable. This transcode will fail until NVIDIA, Intel/AMD, or an Apple media engine is available.");
  }
  if (skipDvP5) {
    warnings.push("This file is Dolby Vision Profile 5. Re-encoding it as ordinary HDR makes the picture look yellow.");
    reasons.push("Ask Radarr or Sonarr to search for an HDR10 or Dolby Vision Profile 8 release.");
  } else if (transcode && (report.hdr === "dolby_vision" || report.hdr === "hdr10plus")) {
    warnings.push("Dolby Vision or HDR10+ metadata may be lost when this file is re-encoded.");
  }
  if (audioBound && (overCap || transcode)) {
    warnings.push(
      `The soundtrack you keep already uses the ${cap.toFixed(2)} GB/hr size cap, so Polisharr will not re-encode just to meet that cap.`,
    );
  }
  const warning = warnings.length > 0 ? warnings.join(" ") : null;

  const afterCodec = transcode ? target.toUpperCase() : report.videoCodec;
  let encodeGbPerHour: number | null = null;
  let afterBytes: number | null = null;
  let estimated: number | null = null;
  if (transcode && transcodeForCap) {
    encodeGbPerHour = cap;
    afterBytes = capBytes;
    estimated = Math.max(0, report.sizeBytes - capBytes);
  } else if (transcode && audioBound) {
    const raised = raisedTargetBytes({
      capBytes,
      durationSec: report.durationSec,
      audioBitrateBps: keptAudioBps,
    });
    afterBytes = Math.min(raised, report.sizeBytes);
    encodeGbPerHour = hours > 0 ? afterBytes / 1024 ** 3 / hours : cap;
    estimated = Math.max(0, report.sizeBytes - afterBytes);
  } else if (transcode) {
    encodeGbPerHour = Math.min(remainingGbPerHour, cap);
  }

  return {
    id: "",
    itemId: item.id,
    actions,
    reasons,
    warning,
    category,
    estimatedSavingsBytes: estimated,
    now: {
      codec: report.videoCodec,
      quality: item.quality || null,
      sizeBytes: report.sizeBytes,
      sizePerHourGb: report.sizePerHourGb,
    },
    after: {
      codec: afterCodec,
      quality: null,
      sizeBytes: afterBytes,
      sizePerHourGb: encodeGbPerHour,
    },
    dismissed: false,
    keepAudio: keepAudio.map((t) => t.index),
    keepAudioLanguages: Object.fromEntries(keepAudio.filter((t) => t.languagePending && t.language !== "und").map((t) => [String(t.index), t.language])),
    stripAudio: stripAudio.map((t) => t.index),
    keepSubs: keepSubs.map((t) => t.index),
    stripSubs: stripSubs.map((t) => t.index),
    stereoSource,
    mustEncode: transcode ? Boolean(input.forceTranscode || transcodeForCodec) : undefined,
  };
}

export function shouldSuggestStereo(opts: {
  audio: InspectionReport["audio"];
  lang: string;
  addStereoDefault: boolean;
  audioMix?: AudioMix | null;
  forceStereo?: boolean;
  alreadyStereo: boolean;
}): boolean {
  if (opts.alreadyStereo) return false;
  if (opts.forceStereo) return true;
  if (opts.audioMix === "surround") return false;
  const hasSurround = opts.audio.some((track) => track.channels > 2);
  if (opts.audioMix === "stereo") return hasSurround;
  return opts.addStereoDefault && opts.audio.some(
    (track) => track.channels > 6 || /atmos|truehd|eac3/i.test(`${track.codec} ${track.title}`),
  );
}

export function codecIsAtLeastHevc(codec: string): boolean {
  return /hevc|h265|av1/i.test(codec);
}

export function codecIsBelowEncodeTarget(codec: string, target: VideoTarget): boolean {
  const value = codec.toLowerCase();
  if (value.includes("av1")) return false;
  if (target === "hevc") return !/hevc|h265/.test(value);
  return true;
}

export function codecLabel(codec: string): string {
  const value = codec.toLowerCase();
  if (/h264|avc/.test(value)) return "H.264";
  if (/hevc|h265/.test(value)) return "HEVC";
  if (/av1/.test(value)) return "AV1";
  if (/mpeg2/.test(value)) return "MPEG-2";
  if (/vc1|wmv3/.test(value)) return "VC-1";
  if (/mpeg4|xvid|divx/.test(value)) return "MPEG-4";
  if (/vp8/.test(value)) return "VP8";
  if (/vp9/.test(value)) return "VP9";
  return codec || "unknown video";
}

function shouldKeepAudio(
  track: InspectionReport["audio"][number],
  lang: string,
  audioCount: number,
): boolean {
  if (track.language === lang) return true;
  if (track.untagged && audioCount === 1) return true;
  return false;
}
