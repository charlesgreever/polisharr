import type { SuggestionFilters } from "./api";

export function toggleRange(
  orderedIds: string[],
  selected: Record<string, boolean>,
  anchorId: string | null,
  clickedId: string,
  checked: boolean,
): Record<string, boolean> {
  const next = { ...selected };
  const start = anchorId == null ? -1 : orderedIds.indexOf(anchorId);
  const end = orderedIds.indexOf(clickedId);
  if (start < 0 || end < 0) {
    setChecked(next, clickedId, checked);
    return next;
  }
  const [from, to] = start < end ? [start, end] : [end, start];
  for (const id of orderedIds.slice(from, to + 1)) setChecked(next, id, checked);
  return next;
}

export function loadedSelection(loadedIds: string[], selected: Record<string, boolean>): "none" | "some" | "all" {
  if (loadedIds.length === 0) return "none";
  const count = loadedIds.filter((id) => selected[id]).length;
  if (count === 0) return "none";
  if (count === loadedIds.length) return "all";
  return "some";
}

export function selectLoaded(
  loadedIds: string[],
  selected: Record<string, boolean>,
  on: boolean,
): Record<string, boolean> {
  const next = { ...selected };
  for (const id of loadedIds) setChecked(next, id, on);
  return next;
}

export function queueAllConfirmCopy(count: number, filtered: boolean): string {
  const noun = count === 1 ? "suggestion" : "suggestions";
  const scope = filtered ? " Only suggestions that match the current search and filters are included." : "";
  return `Queue all ${count} ${noun}? This adds them to the queue. Titles already queued or in Review are skipped. The library file stays until Keep.${scope}`;
}

export function queueBatchCopy(queued: number, skipped: number): string {
  if (skipped === 0) return `Queued ${queued}.`;
  return `Queued ${queued}. Skipped ${skipped}.`;
}

export function suggestionViewIsFiltered(query: string, filters: SuggestionFilters): boolean {
  return Boolean(
    query.trim()
    || filters.type
    || filters.resolution
    || filters.hdr
    || filters.codec
    || filters.overCap
    || filters.extraTracks
    || filters.exempt
    || filters.hardwareWarning,
  );
}

function setChecked(selected: Record<string, boolean>, id: string, checked: boolean): void {
  if (checked) selected[id] = true;
  else delete selected[id];
}
