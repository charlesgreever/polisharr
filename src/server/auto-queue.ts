import type { LibraryItem, Settings, Suggestion } from "./types.ts";
import { isArrSearchOnly } from "./arr-search.ts";

// The NAS commits a new file's modification time about a second after Radarr or Sonarr closes the import. Queueing in that second snapshots the earlier time, and replacement refuses the finished copy.
export const NEW_IMPORT_QUEUE_DELAY_MS = 5 * 60 * 1000;

type ImportQueueInput = {
  settings: Settings;
  item: Pick<LibraryItem, "fileChangedAt" | "sizeBytes" | "keptSizeBytes">;
  suggestion: Suggestion | null;
  now?: number;
  delayMs?: number;
};

export function msUntilNewImportQueue(input: ImportQueueInput): number | null {
  if (!importQueueEligible(input)) return null;
  const now = input.now ?? Date.now();
  const delayMs = input.delayMs ?? NEW_IMPORT_QUEUE_DELAY_MS;
  const changedAt = input.item.fileChangedAt ?? 0;
  return Math.max(0, changedAt + delayMs - now);
}

export function shouldQueueNewImport(input: ImportQueueInput): boolean {
  return msUntilNewImportQueue(input) === 0;
}

function importQueueEligible(input: ImportQueueInput): boolean {
  const { settings, item, suggestion } = input;
  if (!settings.suggestionDefaults.queueNewImports) return false;
  if (settings.queueNewImportsSince <= 0) return false;
  if (!settings.languageConfirmed || !settings.reviewPath.trim()) return false;
  if (!suggestion) return false;
  if (isArrSearchOnly(suggestion.actions)) return false;
  const kept = item.keptSizeBytes ?? 0;
  if (kept > 0 && item.sizeBytes === kept) return false;
  return (item.fileChangedAt ?? 0) >= settings.queueNewImportsSince;
}
