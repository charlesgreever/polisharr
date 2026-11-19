import { describe, expect, it } from "vitest";
import { msUntilNewImportQueue, shouldQueueNewImport } from "./auto-queue.ts";
import { DEFAULT_SETTINGS, type Suggestion } from "./types.ts";

const suggestion: Suggestion = {
  id: "s1",
  itemId: "m1",
  actions: ["tracks"],
  reasons: ["Drop extra audio."],
  warning: null,
  category: "movie1080p",
  estimatedSavingsBytes: null,
  now: { codec: "h264", quality: "WEBDL-1080p", sizeBytes: 1, sizePerHourGb: 1 },
  after: { codec: "h264", quality: null, sizeBytes: null, sizePerHourGb: null },
  dismissed: false,
  keepAudio: [1],
  stripAudio: [2],
  keepSubs: [],
  stripSubs: [],
};

function settings(over: { queueNewImports?: boolean; queueNewImportsSince?: number; languageConfirmed?: boolean; reviewPath?: string } = {}) {
  return {
    ...DEFAULT_SETTINGS,
    languageConfirmed: over.languageConfirmed ?? true,
    reviewPath: over.reviewPath ?? "/review",
    queueNewImportsSince: over.queueNewImportsSince ?? 1_000,
    suggestionDefaults: {
      ...DEFAULT_SETTINGS.suggestionDefaults,
      queueNewImports: over.queueNewImports ?? true,
    },
  };
}

function item(over: { firstSeenAt?: number; fileChangedAt?: number; sizeBytes?: number; keptSizeBytes?: number } = {}) {
  return {
    firstSeenAt: over.firstSeenAt ?? 2_000,
    fileChangedAt: over.fileChangedAt ?? 2_000,
    sizeBytes: over.sizeBytes ?? 8,
    keptSizeBytes: over.keptSizeBytes ?? 0,
  };
}

describe("auto-queue new Arr imports", () => {
  it("queues a sidecar only for files changed after the setting was turned on", () => {
    expect(shouldQueueNewImport({
      settings: settings({ queueNewImports: false }),
      item: item(),
      suggestion,
    })).toBe(false);
    expect(shouldQueueNewImport({
      settings: settings({ queueNewImports: true, queueNewImportsSince: 0 }),
      item: item(),
      suggestion,
    })).toBe(false);
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item({ firstSeenAt: 0, fileChangedAt: 0 }),
      suggestion,
    })).toBe(false);
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item(),
      suggestion: null,
    })).toBe(false);
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item(),
      suggestion: { ...suggestion, actions: ["search_language"], stripAudio: [], keepAudio: [1] },
    })).toBe(false);
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item({ firstSeenAt: 2_000, fileChangedAt: 500 }),
      suggestion,
    })).toBe(false);
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item({ firstSeenAt: 0, fileChangedAt: 2_000 }),
      suggestion,
    })).toBe(true);
    expect(shouldQueueNewImport({
      settings: settings({ languageConfirmed: false }),
      item: item(),
      suggestion,
    })).toBe(false);
  });

  it("queues as soon as the file has changed", () => {
    const changedAt = 10_000;
    const ready = {
      settings: settings(),
      item: item({ fileChangedAt: changedAt }),
      suggestion,
      now: changedAt,
    };
    expect(msUntilNewImportQueue(ready)).toBe(0);
    expect(shouldQueueNewImport(ready)).toBe(true);
    expect(msUntilNewImportQueue({
      settings: settings({ queueNewImports: false }),
      item: item({ fileChangedAt: changedAt }),
      suggestion,
      now: changedAt,
    })).toBeNull();
  });

  it("does not queue the file Polisharr just kept, and does queue a later Arr upgrade", () => {
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item({ sizeBytes: 4, keptSizeBytes: 4 }),
      suggestion,
    })).toBe(false);
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item({ sizeBytes: 9, keptSizeBytes: 4 }),
      suggestion,
    })).toBe(true);
    expect(shouldQueueNewImport({
      settings: settings(),
      item: item({ sizeBytes: 4, keptSizeBytes: 0 }),
      suggestion,
    })).toBe(true);
  });
});
