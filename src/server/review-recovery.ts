export const KEEP_INTERRUPTED = "Keep was interrupted. Try Keep again.";
export const SIDECAR_GONE = "The sidecar is gone. Discard this card or run the job again.";
export const SOURCE_CHANGED = "The original file changed before replacement. The finished copy is still in Review. Inspect the title again and choose Keep or Discard.";
export const MISSING_REVISION = "This result is missing the original file identity from before the encode. Inspect the title again and choose Keep or Discard.";
export const REPLACEMENT_STARTED = "Replacement already started.";
export const KEEP_ALREADY_WAITING = "Keep is already waiting for this title.";
export const WAITING_TO_REPLACE = "Waiting to replace after playback.";

export type InterruptedKeepKind = "complete" | "interrupted" | "sidecar_gone";

export function classifyInterruptedKeep(input: {
  sidecarExists: boolean;
  libraryBytes: number | null;
  sourceBytes: number;
  sidecarBytes: number;
}): InterruptedKeepKind {
  const libraryLooksLikeSidecar =
    input.libraryBytes != null &&
    input.sidecarBytes > 0 &&
    input.libraryBytes === input.sidecarBytes &&
    input.libraryBytes !== input.sourceBytes;
  if (libraryLooksLikeSidecar) return "complete";
  if (!input.sidecarExists) return "sidecar_gone";
  return "interrupted";
}
