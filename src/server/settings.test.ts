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
      videoTarget: "hevc",
      concurrency: 1,
    });
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
});
