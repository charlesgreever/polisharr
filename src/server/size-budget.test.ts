import { describe, expect, it } from "vitest";
import {
  aggressiveTargetBytes,
  audioFillsSizeCap,
  copiedAudioBitrateBps,
  exceedsSizeCap,
  missedOutputTarget,
  raisedTargetBytes,
  remainingSizeAfterTrackPlan,
  typicalAudioBitrateBps,
  videoBitrateForTarget,
} from "./size-budget.ts";

describe("size budget", () => {
  it("aims video bitrate at the typed file target, not 20% under it", () => {
    const durationSec = 3600;
    const targetBytes = 2.5 * 1024 ** 3;
    const bitrate = videoBitrateForTarget({ targetBytes, durationSec, audioBitrateBps: 0 });
    const raw = (targetBytes * 8) / durationSec;
    expect(bitrate / raw).toBeGreaterThan(0.99);
    expect(bitrate / raw).toBeLessThan(1);
    const av1 = videoBitrateForTarget({ targetBytes, durationSec, audioBitrateBps: 0, codec: "av1" });
    expect(av1).toBe(bitrate);
  });

  it("uses measured TrueHD bytes so a 4.2 GB target is not eaten by a 5 Mbps guess", () => {
    // House of the Dragon S01E08 custom AV1 job: typed 4.20 GB, landed at 2.22 GB.
    const durationSec = 4052.373;
    const targetBytes = 4_509_715_661;
    const tracks = [
      { codec: "truehd", channels: 8, title: "TrueHD 7.1 Atmos", sizeBytes: 1_421_238_866 },
      { codec: "ac3", channels: 6, title: "AC-3 5.1", bitrateBps: 448_000, sizeBytes: 226_931_712 },
      { codec: "aac", channels: 2, sizeBytes: 82_478_280 },
    ];
    const audioBytes = tracks.reduce((sum, track) => sum + (track.sizeBytes ?? 0), 0);
    const audioBps = copiedAudioBitrateBps(tracks, durationSec);
    const videoBps = videoBitrateForTarget({
      targetBytes,
      durationSec,
      audioBitrateBps: audioBps,
      codec: "av1",
    });
    const predictedBytes = Math.round((videoBps / 8) * durationSec) + audioBytes;
    expect(typicalAudioBitrateBps(tracks[0]!, durationSec)).toBeGreaterThan(2_700_000);
    expect(typicalAudioBitrateBps(tracks[0]!, durationSec)).toBeLessThan(2_900_000);
    expect(typicalAudioBitrateBps({ codec: "truehd", channels: 8, title: "TrueHD 7.1 Atmos" })).toBe(5_000_000);
    expect(predictedBytes / targetBytes).toBeGreaterThan(0.95);
    expect(predictedBytes / targetBytes).toBeLessThan(1.05);
  });

  it("flags a custom size-mode output against the typed target, not only GB/hour", () => {
    expect(missedOutputTarget({
      outputBytes: 6 * 1024 ** 3,
      sourceBytes: 10 * 1024 ** 3,
      outputSizePerHourGb: 6,
      categoryCap: 8,
      targetBytes: 4 * 1024 ** 3,
    })).toBe(true);
    expect(missedOutputTarget({
      outputBytes: 4.1 * 1024 ** 3,
      sourceBytes: 10 * 1024 ** 3,
      outputSizePerHourGb: 4.1,
      categoryCap: 8,
      targetBytes: 4 * 1024 ** 3,
    })).toBe(false);
    expect(aggressiveTargetBytes(5_000)).toBe(4_000);
  });

  it("treats a file a little over the cap as still within the cap", () => {
    expect(exceedsSizeCap(8.2, 8)).toBe(false);
    expect(exceedsSizeCap(8.5, 8)).toBe(true);
    expect(exceedsSizeCap(10.69, 8)).toBe(true);
  });

  it("reserves more video bitrate for a TrueHD Atmos movie than a flat 80 MB pad", () => {
    const durationSec = 7139.5;
    const targetBytes = 8 * (durationSec / 3600) * 1024 ** 3;
    const allAudio = [
      { codec: "truehd", channels: 8, title: "Atmos" },
      { codec: "aac", channels: 2, title: "" },
      { codec: "ac3", channels: 6, title: "" },
      { codec: "truehd", channels: 8, title: "TrueHD" },
    ];
    const kept = [allAudio[0]!, allAudio[1]!];
    const withAll = videoBitrateForTarget({
      targetBytes,
      durationSec,
      audioBitrateBps: copiedAudioBitrateBps(allAudio),
    });
    const withKept = videoBitrateForTarget({
      targetBytes,
      durationSec,
      audioBitrateBps: copiedAudioBitrateBps(kept),
    });
    const withoutAudio = videoBitrateForTarget({ targetBytes, durationSec, audioBitrateBps: 0 });
    expect(typicalAudioBitrateBps({ codec: "truehd", channels: 8 })).toBe(5_000_000);
    expect(withAll).toBeLessThan(withoutAudio * 0.6);
    expect(withKept).toBeGreaterThan(withAll);
    expect(withKept).toBeGreaterThan(800_000);
  });

  it("refuses a size target that the kept audio already fills", () => {
    expect(() => videoBitrateForTarget({
      targetBytes: 2 * 1024 ** 3,
      durationSec: 7200,
      audioBitrateBps: 5_000_000,
    })).toThrow(/Kept audio is about 4\.2 GB/);
  });

  it("encodes a small HEVC episode to AV1 instead of blaming 0 GB of audio", () => {
    const durationSec = 22 * 60;
    const targetBytes = Math.round(0.2 * 1024 ** 3);
    const bitrate = videoBitrateForTarget({
      targetBytes,
      durationSec,
      audioBitrateBps: typicalAudioBitrateBps({ codec: "aac", channels: 2 }),
      codec: "av1",
    });
    expect(bitrate).toBeGreaterThanOrEqual(800_000);
    expect(audioFillsSizeCap({
      targetBytes,
      durationSec,
      audioBitrateBps: typicalAudioBitrateBps({ codec: "aac", channels: 2 }),
    })).toBe(false);
  });

  it("scores remaining size after extra-language audio is dropped, not the original blob", () => {
    const extra = Array.from({ length: 8 }, () => ({ codec: "ac3", channels: 6, title: "" }));
    const remaining = remainingSizeAfterTrackPlan({
      sizeBytes: Math.round(3.5 * 1024 ** 3),
      durationSec: 3600,
      stripAudio: extra,
      stripSubs: Array.from({ length: 12 }, () => ({ codec: "hdmv_pgs_subtitle" })),
    });
    expect(remaining.remainingBytes).toBeLessThan(3.5 * 1024 ** 3);
    expect(remaining.remainingSizePerHourGb).toBeLessThan(2.5);
    expect(exceedsSizeCap(3.5, 2.5)).toBe(true);
    expect(exceedsSizeCap(remaining.remainingSizePerHourGb, 2.5)).toBe(false);
  });

  it("does not pretend extra PGS tracks shrink a file under the cap", () => {
    const remaining = remainingSizeAfterTrackPlan({
      sizeBytes: Math.round(8 * 1024 ** 3),
      durationSec: 3600,
      stripAudio: [],
      stripSubs: Array.from({ length: 20 }, () => ({ codec: "hdmv_pgs_subtitle" })),
    });
    expect(remaining.remainingSizePerHourGb).toBeGreaterThan(7);
  });

  it("treats Batman-style TrueHD as filling a 1080p cap and a single AC3 as not", () => {
    const durationSec = 7492.96;
    const capBytes = Math.round(2.5 * (durationSec / 3600) * 1024 ** 3);
    const truehdPlusAc3 = copiedAudioBitrateBps([
      { codec: "truehd", channels: 8, title: "" },
      { codec: "ac3", channels: 6, title: "" },
      { codec: "ac3", channels: 2, title: "" },
    ]);
    expect(audioFillsSizeCap({
      targetBytes: capBytes,
      durationSec,
      audioBitrateBps: truehdPlusAc3,
    })).toBe(true);
    expect(audioFillsSizeCap({
      targetBytes: capBytes,
      durationSec,
      audioBitrateBps: typicalAudioBitrateBps({ codec: "ac3", channels: 6 }),
    })).toBe(false);
  });

  it("raises the cap by kept audio so a codec encode still has room for video", () => {
    const durationSec = 7492.96;
    const capBytes = Math.round(2.5 * (durationSec / 3600) * 1024 ** 3);
    const audioBitrateBps = copiedAudioBitrateBps([
      { codec: "truehd", channels: 8, title: "" },
      { codec: "ac3", channels: 6, title: "" },
      { codec: "ac3", channels: 2, title: "" },
    ]);
    const raised = raisedTargetBytes({ capBytes, durationSec, audioBitrateBps });
    expect(raised).toBeGreaterThan(capBytes);
    const bitrate = videoBitrateForTarget({ targetBytes: raised, durationSec, audioBitrateBps });
    expect(bitrate).toBeGreaterThanOrEqual(800_000);
    expect(bitrate).toBeGreaterThan(4_000_000);
  });
});
