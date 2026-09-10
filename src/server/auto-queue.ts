import type { LibraryItem, Settings, Suggestion } from "./types.ts";
import { isArrSearchOnly } from "./arr-search.ts";

export function shouldQueueNewImport(input: {
  settings: Settings;
  item: Pick<LibraryItem, "fileChangedAt" | "sizeBytes" | "keptSizeBytes">;
  suggestion: Suggestion | null;
}): boolean {
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
