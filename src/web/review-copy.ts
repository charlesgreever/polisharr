export function formatEncodeDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 90) return `${sec} sec`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function reviewEncodeLine(item: {
  nodeName?: string | null;
  encodeApi?: string | null;
  gpuName?: string | null;
  encodeMs?: number | null;
}): string | null {
  const parts = [
    item.nodeName ? `Ran on ${item.nodeName}` : null,
    item.encodeApi ?? null,
    item.gpuName ?? null,
    item.encodeMs != null ? formatEncodeDuration(item.encodeMs) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
