import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./types.ts";
import { parseStoredSettings, updateSettings } from "./settings.ts";

describe("settings boundary", () => {
  it("rejects invalid HTTP fields instead of coercing them", () => {
    const result = updateSettings(DEFAULT_SETTINGS, {
      concurrency: "4",
      localAuthBypass: "yes",
      sizeCaps: { movie1080p: -1 },
    });

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/invalid/i) });
  });

  it("normalizes persisted values into closed domain types", () => {
    expect(parseStoredSettings({ sizeCaps: { movie1080p: 2.5, movie4kSdr: 6, movie4kHdr: 8, tv1080p: 1, tv4k: 4 } }).sizeCaps.tv4kHdr).toBe(6);
    expect(parseStoredSettings({ writeMode: "erase", videoTarget: "vp9", concurrency: 0 })).toMatchObject({
      writeMode: "sidecar",
      movieVideoTarget: "hevc",
      tvVideoTarget: "hevc",
      concurrency: 1,
    });
    expect(parseStoredSettings({ videoTarget: "av1" })).toMatchObject({
      movieVideoTarget: "av1",
      tvVideoTarget: "av1",
    });
    expect(parseStoredSettings({ videoTarget: "hevc", tvVideoTarget: "av1" })).toMatchObject({
      movieVideoTarget: "hevc",
      tvVideoTarget: "av1",
    });
    expect(parseStoredSettings({ videoTarget: "av1" })).not.toHaveProperty("videoTarget");
  });

  it("keeps movie and TV encode targets independent", () => {
    const legacy = updateSettings(DEFAULT_SETTINGS, { videoTarget: "av1" });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.settings.movieVideoTarget).toBe("av1");
    expect(legacy.settings.tvVideoTarget).toBe("av1");
    expect(legacy.settings).not.toHaveProperty("videoTarget");

    const split = updateSettings(DEFAULT_SETTINGS, { videoTarget: "av1", movieVideoTarget: "hevc", tvVideoTarget: "av1" });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.settings.movieVideoTarget).toBe("hevc");
    expect(split.settings.tvVideoTarget).toBe("av1");

    const tvOnly = updateSettings(
      { ...DEFAULT_SETTINGS, movieVideoTarget: "av1", tvVideoTarget: "hevc" },
      { tvVideoTarget: "av1" },
    );
    expect(tvOnly.ok).toBe(true);
    if (!tvOnly.ok) return;
    expect(tvOnly.settings.movieVideoTarget).toBe("av1");
    expect(tvOnly.settings.tvVideoTarget).toBe("av1");
    expect(updateSettings(DEFAULT_SETTINGS, { tvVideoTarget: "vp9" }).ok).toBe(false);
    expect(updateSettings(DEFAULT_SETTINGS, { movieVideoTarget: "vp9" }).ok).toBe(false);
  });

  it("keeps an empty default encode node as this machine", () => {
    expect(parseStoredSettings({}).defaultEncodeNodeId).toBe("");
    const updated = updateSettings(DEFAULT_SETTINGS, { defaultEncodeNodeId: "node-5090" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.settings.defaultEncodeNodeId).toBe("node-5090");
    expect(updateSettings(DEFAULT_SETTINGS, { defaultEncodeNodeId: 12 }).ok).toBe(false);
  });

  it("stamps queueNewImportsSince when the import auto-queue setting is turned on", () => {
    const before = Date.now();
    const enabled = updateSettings(DEFAULT_SETTINGS, {
      suggestionDefaults: { ...DEFAULT_SETTINGS.suggestionDefaults, queueNewImports: true },
    });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    expect(enabled.settings.suggestionDefaults.queueNewImports).toBe(true);
    expect(enabled.settings.queueNewImportsSince).toBeGreaterThanOrEqual(before);
    const stillOn = updateSettings(enabled.settings, {
      suggestionDefaults: { ...enabled.settings.suggestionDefaults, queueNewImports: true },
    });
    expect(stillOn.ok).toBe(true);
    if (!stillOn.ok) return;
    expect(stillOn.settings.queueNewImportsSince).toBe(enabled.settings.queueNewImportsSince);
  });

  it("keeps automatic imports on sidecar until a saved choice says otherwise", () => {
    expect(parseStoredSettings({}).queueNewImportWriteMode).toBe("sidecar");
    expect(parseStoredSettings({ queueNewImportWriteMode: "erase" }).queueNewImportWriteMode).toBe("sidecar");
    const direct = updateSettings(DEFAULT_SETTINGS, { queueNewImportWriteMode: "direct" });
    const house = updateSettings(DEFAULT_SETTINGS, { queueNewImportWriteMode: "follow" });
    const stored = updateSettings(DEFAULT_SETTINGS, { queueNewImportWriteMode: "default" });
    expect(direct.ok && direct.settings.queueNewImportWriteMode).toBe("direct");
    expect(house.ok && house.settings.queueNewImportWriteMode).toBe("follow");
    expect(stored.ok && stored.settings.queueNewImportWriteMode).toBe("follow");
    expect(parseStoredSettings({ queueNewImportWriteMode: "default" }).queueNewImportWriteMode).toBe("follow");
    expect(parseStoredSettings({ queueNewImportWriteMode: "follow" }).queueNewImportWriteMode).toBe("follow");
    expect(updateSettings(DEFAULT_SETTINGS, { queueNewImportWriteMode: "overwrite" }).ok).toBe(false);
  });
});
