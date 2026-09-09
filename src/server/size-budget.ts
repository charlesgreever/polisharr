/** Fraction of the GB/hr cap a file may exceed before Polisharr treats it as over. */
export const SIZE_CAP_TOLERANCE = 0.05;
/** Fraction of the file-size target left unused so CBR/VBR overshoot still lands under the cap. */
const ENCODER_SLACK = 0.2;
const MUX_OVERHEAD_BYTES = 8_000_000;
const MIN_VIDEO_BPS = 800_000;
const MAX_VIDEO_BPS = 300_000_000;
const BITMAP_SUBTITLE_BPS = 40_000;

export type AudioBitrateTrack = { codec: string; channels: number; title?: string; bitrateBps?: number; sizeBytes?: number };
export type SubtitleSizeTrack = { codec: string; bitrateBps?: number; sizeBytes?: number };

export function exceedsSizeCap(sizePerHourGb: number, cap: number): boolean {
  return sizePerHourGb > cap * (1 + SIZE_CAP_TOLERANCE);
}

export function missedOutputTarget(opts: {
  outputBytes: number;
  sourceBytes: number;
  outputSizePerHourGb: number;
  categoryCap: number;
  targetBytes?: number | null;
}): boolean {
  if (opts.outputBytes > opts.sourceBytes) return true;
  if (opts.targetBytes != null && opts.targetBytes > 0) {
    return opts.outputBytes > opts.targetBytes * (1 + SIZE_CAP_TOLERANCE);
  }
  return exceedsSizeCap(opts.outputSizePerHourGb, opts.categoryCap);
}

export function aggressiveTargetBytes(previousTargetBytes: number): number {
  return Math.max(1, Math.round(previousTargetBytes * 0.8));
}

export function typicalAudioBitrateBps(track: AudioBitrateTrack): number {
  if (track.bitrateBps && track.bitrateBps > 0) return track.bitrateBps;
  const codec = `${track.codec} ${track.title ?? ""}`.toLowerCase();
  const channels = Math.max(1, track.channels || 2);
  if (/truehd|mlp/.test(codec)) return channels > 6 ? 5_000_000 : 3_000_000;
  if (/dts/.test(codec) && /ma|hd|atmos/.test(codec)) return 3_840_000;
  if (/\bdts\b/.test(codec)) return 1_536_000;
  if (/flac/.test(codec)) return Math.round(1_000_000 * (channels / 2));
  if (/pcm|lpcm/.test(codec)) return 768_000 * channels;
  if (/eac3|ec-3/.test(codec)) return channels > 2 ? 768_000 : 192_000;
  if (/ac3/.test(codec)) return channels > 2 ? 640_000 : 192_000;
  if (/aac/.test(codec)) return channels > 2 ? 384_000 : 192_000;
  if (/opus/.test(codec)) return 160_000;
  return 256_000;
}

export function copiedAudioBitrateBps(tracks: AudioBitrateTrack[]): number {
  return tracks.reduce((sum, track) => sum + typicalAudioBitrateBps(track), 0);
}

export function typicalSubtitleBitrateBps(track: SubtitleSizeTrack): number {
  if (track.bitrateBps && track.bitrateBps > 0) return track.bitrateBps;
  if (/pgs|dvd_sub|dvb_sub|xsub|vobsub|hdmv/i.test(track.codec)) return BITMAP_SUBTITLE_BPS;
  return 0;
}

export function bytesForBitrate(bps: number, durationSec: number): number {
  if (!(bps > 0) || !(durationSec > 0)) return 0;
  return Math.round((bps / 8) * durationSec);
}

export function remainingSizeAfterTrackPlan(input: {
  sizeBytes: number;
  durationSec: number;
  stripAudio: AudioBitrateTrack[];
  stripSubs?: SubtitleSizeTrack[];
  extraAudioBitrateBps?: number;
}): { remainingBytes: number; remainingSizePerHourGb: number } {
  const strippedAudio = copiedAudioBitrateBps(input.stripAudio);
  const strippedSubs = (input.stripSubs ?? []).reduce((sum, track) => sum + typicalSubtitleBitrateBps(track), 0);
  const extra = input.extraAudioBitrateBps ?? 0;
  const remainingBytes = Math.max(
    0,
    input.sizeBytes - bytesForBitrate(strippedAudio, input.durationSec) - bytesForBitrate(strippedSubs, input.durationSec) + bytesForBitrate(extra, input.durationSec),
  );
  const hours = input.durationSec > 0 ? input.durationSec / 3600 : 0;
  return {
    remainingBytes,
    remainingSizePerHourGb: hours > 0 ? remainingBytes / 1024 ** 3 / hours : 0,
  };
}

export function audioFillsSizeCap(input: {
  targetBytes: number;
  durationSec: number;
  audioBitrateBps: number;
}): boolean {
  if (!(input.durationSec > 1) || !(input.targetBytes > 0)) return false;
  const audioBytes = bytesForBitrate(input.audioBitrateBps, input.durationSec);
  const usable = Math.max(0, input.targetBytes * (1 - ENCODER_SLACK) - audioBytes - MUX_OVERHEAD_BYTES);
  const bitrate = Math.round((usable * 8) / input.durationSec);
  return bitrate < MIN_VIDEO_BPS && audioBytes >= bytesForBitrate(MIN_VIDEO_BPS, input.durationSec);
}

export function raisedTargetBytes(input: {
  capBytes: number;
  durationSec: number;
  audioBitrateBps: number;
}): number {
  const audioBytes = bytesForBitrate(input.audioBitrateBps, input.durationSec);
  return Math.max(input.capBytes, Math.round((input.capBytes + audioBytes + MUX_OVERHEAD_BYTES) / (1 - ENCODER_SLACK)));
}

export function videoBitrateForTarget(input: {
  targetBytes: number;
  durationSec: number;
  audioBitrateBps: number;
  codec?: "hevc" | "av1";
}): number {
  const audioBytes = (input.audioBitrateBps / 8) * input.durationSec;
  const usable = Math.max(0, input.targetBytes * (1 - ENCODER_SLACK) - audioBytes - MUX_OVERHEAD_BYTES);
  let bitrate = Math.round((usable * 8) / input.durationSec);
  if (bitrate > MAX_VIDEO_BPS) {
    const gb = (input.targetBytes / 1024 ** 3).toFixed(1);
    const minutes = Math.max(1, Math.round(input.durationSec / 60));
    throw new Error(
      `A ${gb} GB target over ${minutes} minutes needs ${(bitrate / 1_000_000).toFixed(0)} Mbps, which the hardware encoder will reject. The remux is probably a short title, not the feature.`,
    );
  }
  if (bitrate < MIN_VIDEO_BPS) {
    if (audioBytes >= bytesForBitrate(MIN_VIDEO_BPS, input.durationSec)) {
      const audioGb = audioBytes / 1024 ** 3;
      const targetGb = input.targetBytes / 1024 ** 3;
      throw new Error(
        `Kept audio is about ${audioGb.toFixed(1)} GB; a ${targetGb.toFixed(1)} GB target leaves too little room for video. Exempt this title or drop extra lossless tracks.`,
      );
    }
    bitrate = MIN_VIDEO_BPS;
  }
  return bitrate;
}
