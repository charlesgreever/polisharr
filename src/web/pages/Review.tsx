import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { api, formatDuration, formatGbHour, formatSize, type PreviewStatus, type ReviewRow } from "../api";
import { reviewEncodeLine } from "../review-copy";
import { PagedListControls } from "../components/PagedListControls";
import { Help, PageHead } from "../components/Shell";
import { FIELD_CONTROL } from "../settings-copy";
import { usePagedList } from "../use-paged-list";
import {
  PREVIEW_KEYBOARD_COPY,
  PREVIEW_LIMITS_COPY,
  PREVIEW_POLL_MS,
  PREVIEW_PRESETS,
  actualIntervalCopy,
  canCompareStatus,
  cancelPreviewThen,
  commonDurationMs,
  compareHotkey,
  compareLayout,
  createExclusiveRunner,
  defaultPreviewAudio,
  initialLinkedPlayer,
  previewClipUrl,
  previewRequestBody,
  previewStatusCopy,
  previewTrackOption,
  previewTransformLines,
  previewUiKind,
  reduceLinkedPlayer,
  selectionAfterRemoval,
  type CompareLayout,
  type CompareSide,
  type LinkedPlayerEvent,
  type PreviewPresetId,
  type PreviewSample,
} from "../review-compare";

export function keepAllConfirmCopy(count: number): string {
  const noun = count === 1 ? "file" : "files";
  return `Keep all ${count} ${noun}? This replaces each library file with its new copy.`;
}

export function keepStartedCopy(started: number, skipped: number, waiting = 0): string {
  if (waiting === 0 && skipped === 0) return `Keep started for ${started}.`;
  if (waiting === 0) return `Keep started for ${started}; skipped ${skipped}.`;
  if (started === 0 && skipped === 0) return `Waiting for playback on ${waiting}.`;
  if (skipped === 0) return `Keep started for ${started}; waiting for playback on ${waiting}.`;
  if (started === 0) return `Waiting for playback on ${waiting}; skipped ${skipped}.`;
  return `Keep started for ${started}; waiting for playback on ${waiting}; skipped ${skipped}.`;
}

export const WAITING_TO_REPLACE = "Waiting to replace after playback.";

export function frameFacts(frame: ReviewRow["source"]): string {
  return [frame.codec, formatSize(frame.sizeBytes), formatDuration(frame.durationSec), formatGbHour(frame.sizePerHourGb), frame.tracks]
    .filter(Boolean)
    .join(" · ");
}

export function ReviewPage() {
  const list = usePagedList({ loadPage: api.review, keyOf: (row: ReviewRow) => row.id, pollMs: 3000 });
  const items = list.items;
  const [selected, setSelected] = useState<Record<string, boolean>>();
  const [msg, setMsg] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const [compareItem, setCompareItem] = useState<ReviewRow | null>(null);
  const [compareTaskId, setCompareTaskId] = useState<string | null>(null);

  const pending = items.filter((i) => i.status === "pending");
  const chosen = pending.filter((i) => selected?.[i.id]);
  const pendingCount = list.pendingCount || pending.length;
  const liveCompare = compareItem ? items.find((row) => row.id === compareItem.id) ?? null : null;

  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirmAll) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmAll(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmAll]);

  useEffect(() => {
    if (compareItem && !items.some((row) => row.id === compareItem.id)) {
      setCompareItem(null);
      setCompareTaskId(null);
    }
  }, [items, compareItem]);

  async function cancelOpenPreview(reviewId: string) {
    if (compareItem?.id !== reviewId || !compareTaskId) return;
    await api.cancelReviewPreview(reviewId, compareTaskId).catch(() => undefined);
    setCompareItem(null);
    setCompareTaskId(null);
  }

  async function afterMutation(removedIds: string[]) {
    setSelected((current) => selectionAfterRemoval(current, removedIds));
    await list.refresh();
  }

  return (
    <section>
      <PageHead title="Review">
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            type="button"
            disabled={chosen.length === 0}
            onClick={() => void (async () => {
              const ids = chosen.map((row) => row.id);
              if (compareItem && ids.includes(compareItem.id)) await cancelOpenPreview(compareItem.id);
              const result = await api.keepSelected(ids);
              setMsg(keepStartedCopy(result.started ?? result.accepted, result.skipped, result.waiting ?? 0));
              await afterMutation(ids);
            })()}
          >
            Keep selected ({chosen.length})
          </button>
          <button
            className="btn-secondary"
            type="button"
            disabled={pendingCount === 0}
            onClick={() => setConfirmAll(true)}
          >
            Keep all
          </button>
        </div>
      </PageHead>
      <Help>
        Review compares the original and the sidecar: size, codec, duration, tracks, and GB per hour. The card names the encode node, the GPU API, the device, and how long the job ran. Compare clips plays matching samples after you pick a position; opening Review does not start that work. Keep replaces the library file. Discard throws the sidecar away. Encode smaller queues a tighter size target after a miss. The original stays until Keep finishes. If a file is playing, Keep records the request and waits; Cancel wait leaves both copies in place. If Polisharr restarts during Keep, the card comes back so you can try again, unless the new file is already in the library. Keep all promotes every pending sidecar after you confirm and skips cards that are already waiting.
      </Help>
      {confirmAll && (
        <div className="modal-scrim" role="presentation" onClick={() => setConfirmAll(false)}>
          <div
            className="modal-card glass space-y-3 p-5"
            role="dialog"
            aria-labelledby="keep-all-title"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="keep-all-title" className="text-sm font-semibold tracking-wide text-ink">Keep all files?</h2>
            <p className="m-0 text-sm leading-5 text-muted">{keepAllConfirmCopy(pendingCount)}</p>
            <div className="flex flex-wrap gap-2">
              <button
                ref={confirmRef}
                className="btn"
                type="button"
                onClick={() => {
                  setConfirmAll(false);
                  void (async () => {
                    if (compareItem) await cancelOpenPreview(compareItem.id);
                    try {
                      const result = await api.keepAll();
                      setMsg(keepStartedCopy(result.started ?? result.accepted, result.skipped, result.waiting ?? 0));
                      setSelected({});
                      await list.refresh();
                    } catch (error) {
                      setMsg(error instanceof Error ? error.message : "Keep all failed.");
                    }
                  })();
                }}
              >
                Keep all
              </button>
              <button className="btn-secondary" type="button" onClick={() => setConfirmAll(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {items.length === 0 && list.loading && <div className="empty">Loading review…</div>}
      {items.length === 0 && !list.loading && !list.error && <div className="empty">Nothing is waiting for Keep or Discard.</div>}
      {items.length > 0 && (
        <ul className="mt-5 space-y-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03]">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={item.status !== "pending"}
                  checked={Boolean(selected?.[item.id])}
                  onChange={(e) => setSelected((s) => ({ ...s, [item.id]: e.target.checked }))}
                  aria-label={`Select ${item.displayTitle}`}
                />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="font-semibold">{item.displayTitle}</div>
                  {(() => {
                    const line = reviewEncodeLine(item);
                    return line ? <div className="text-sm text-muted">{line}</div> : null;
                  })()}
                  {item.status === "waiting" && (
                    <div className="text-sm text-muted">{item.waitReason || WAITING_TO_REPLACE}</div>
                  )}
                  {item.flagged && <div className="text-sm text-accent">{item.flagReason}</div>}
                  {item.error && <div className="text-sm text-bad">{item.error}</div>}
                  <div className="contact-sheet">
                    <dl className="contact-frame">
                      <dt>Now</dt>
                      <dd>{frameFacts(item.source)}</dd>
                    </dl>
                    <dl className="contact-frame">
                      <dt>Sidecar</dt>
                      <dd>{frameFacts(item.sidecar)}</dd>
                    </dl>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn"
                      type="button"
                      disabled={item.status !== "pending"}
                      onClick={() => void (async () => {
                        await cancelOpenPreview(item.id);
                        await api.keep(item.id);
                        await afterMutation([item.id]);
                      })()}
                    >
                      {item.status === "keeping" ? "Keeping…" : item.status === "waiting" ? "Waiting…" : "Keep"}
                    </button>
                    {item.status === "waiting" && item.cancellable !== false && (
                      <button
                        className="btn-secondary"
                        type="button"
                        onClick={() => void api.cancelKeep(item.id).then(() => list.refresh())}
                      >
                        Cancel wait
                      </button>
                    )}
                    <button
                      className="btn-secondary danger"
                      type="button"
                      disabled={item.status !== "pending" && item.status !== "waiting"}
                      onClick={() => void (async () => {
                        await cancelOpenPreview(item.id);
                        await api.discard(item.id);
                        await afterMutation([item.id]);
                      })()}
                    >
                      Discard
                    </button>
                    {canCompareStatus(item.status) && (
                      <button className="btn-secondary" type="button" onClick={() => setCompareItem(item)}>
                        Compare clips
                      </button>
                    )}
                    {item.flagged && item.status === "pending" && (
                      <button
                        className="btn-secondary"
                        type="button"
                        onClick={() => void api.requeueFlagged(item.id).then(() => {
                          setMsg("Queued a smaller encode.");
                          return list.refresh();
                        }).catch((error: Error) => setMsg(error.message))}
                      >
                        Encode smaller
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <PagedListControls loading={list.loading} error={list.error} nextOffset={list.nextOffset} noun="reviews" onLoadMore={list.loadMore} onRetry={list.reload} />
      {msg && <p className="mt-3 text-sm">{msg}</p>}
      {liveCompare && (
        <CompareClipsDialog
          item={liveCompare}
          onClose={() => {
            setCompareItem(null);
            setCompareTaskId(null);
          }}
          onTaskChange={setCompareTaskId}
          onMutated={async (kind) => {
            if (kind === "keep") await api.keep(liveCompare.id);
            else if (kind === "discard") await api.discard(liveCompare.id);
            else await api.cancelKeep(liveCompare.id);
            await afterMutation(kind === "cancel-wait" ? [] : [liveCompare.id]);
          }}
        />
      )}
    </section>
  );
}

export function CompareClipsDialog({
  item,
  onClose,
  onTaskChange,
  onMutated,
}: {
  item: ReviewRow;
  onClose: () => void;
  onTaskChange: (taskId: string | null) => void;
  onMutated: (kind: "keep" | "discard" | "cancel-wait") => Promise<void>;
}) {
  const defaults = defaultPreviewAudio(item.source.audio ?? [], item.sidecar.audio ?? []);
  const [sample, setSample] = useState<PreviewSample | null>(null);
  const [customClock, setCustomClock] = useState("0:00");
  const [originalAudioIndex, setOriginalAudioIndex] = useState<number | null>(defaults.originalAudioIndex);
  const [sidecarAudioIndex, setSidecarAudioIndex] = useState<number | null>(defaults.sidecarAudioIndex);
  const [task, setTask] = useState<PreviewStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [audible, setAudible] = useState<CompareSide>("original");
  const [viewSide, setViewSide] = useState<CompareSide>("original");
  const [layout, setLayout] = useState<CompareLayout>("split");
  const firstControl = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const playerRef = useRef<{ dispatch: (event: LinkedPlayerEvent) => void; currentTime: () => number } | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstControl.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);

  useEffect(() => {
    const update = () => setLayout(compareLayout(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    onTaskChange(task?.id ?? null);
  }, [onTaskChange, task?.id]);

  useEffect(() => {
    if (!task || (task.status !== "queued" && task.status !== "running")) return;
    const runner = createExclusiveRunner();
    const controller = new AbortController();
    let stopped = false;
    const poll = () => {
      void runner.run(async () => {
        try {
          const next = await api.reviewPreviewStatus(item.id, task.id, { signal: controller.signal });
          if (!stopped) setTask(next);
        } catch (cause) {
          if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
          if (!stopped) setError(cause instanceof Error ? cause.message : "Preview status could not be loaded.");
        }
      });
    };
    poll();
    const timer = window.setInterval(poll, PREVIEW_POLL_MS);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [item.id, task?.id, task?.status]);

  const loadPreview = useCallback(async (
    nextSample: PreviewSample,
    clock = customClock,
    originalIndex = originalAudioIndex,
    sidecarIndex = sidecarAudioIndex,
  ) => {
    const body = previewRequestBody({
      sample: nextSample,
      customClock: clock,
      durationMs: commonDurationMs(item),
      originalAudioIndex: originalIndex,
      sidecarAudioIndex: sidecarIndex,
    });
    if (!body) {
      setError("Enter a timestamp that still has at least one second left on both copies.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      if (task && (task.status === "queued" || task.status === "running")) {
        await api.cancelReviewPreview(item.id, task.id).catch(() => undefined);
      }
      setTask(await api.requestReviewPreview(item.id, body));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Polisharr could not start that preview.");
    } finally {
      setBusy(false);
    }
  }, [customClock, item, originalAudioIndex, sidecarAudioIndex, task]);

  async function mutate(kind: "keep" | "discard" | "cancel-wait") {
    setBusy(true);
    try {
      await cancelPreviewThen({
        task,
        cancel: () => api.cancelReviewPreview(item.id, task!.id),
        mutate: () => onMutated(kind),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That Review action failed.");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      return;
    }
    const hotkey = compareHotkey(event.key);
    if (!hotkey) return;
    event.preventDefault();
    if (hotkey.action === "close") onClose();
    if (hotkey.action === "playpause") playerRef.current?.dispatch({ type: "toggle" });
    if (hotkey.action === "audible") setAudible(hotkey.side);
    if (hotkey.action === "view") setViewSide(hotkey.side);
    if (hotkey.action === "seek") {
      const time = Math.max(0, (playerRef.current?.currentTime() ?? 0) + hotkey.deltaSec);
      playerRef.current?.dispatch({ type: "seek", timeSec: time });
    }
  }

  return (
    <div className="modal-scrim" role="presentation" onClick={onClose}>
      <div
        className="modal-card compare-modal glass space-y-4 p-5"
        role="dialog"
        aria-labelledby="compare-title"
        aria-describedby="compare-limits"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <CompareClipsView
          item={item}
          task={task}
          sample={sample}
          customClock={customClock}
          originalAudioIndex={originalAudioIndex}
          sidecarAudioIndex={sidecarAudioIndex}
          audible={audible}
          viewSide={viewSide}
          layout={layout}
          error={error}
          busy={busy}
          firstControl={firstControl}
          playerRef={playerRef}
          onClose={onClose}
          onSelectPreset={(id) => {
            setSample(id);
            void loadPreview(id);
          }}
          onCustomClock={setCustomClock}
          onLoadCustom={() => {
            setSample("custom");
            void loadPreview("custom");
          }}
          onOriginalAudio={(index) => {
            setOriginalAudioIndex(index);
            if (sample) void loadPreview(sample, customClock, index, sidecarAudioIndex);
          }}
          onSidecarAudio={(index) => {
            setSidecarAudioIndex(index);
            if (sample) void loadPreview(sample, customClock, originalAudioIndex, index);
          }}
          onAudible={setAudible}
          onViewSide={setViewSide}
          onPlayPause={() => playerRef.current?.dispatch({ type: "toggle" })}
          onRetry={() => {
            if (sample) void loadPreview(sample);
          }}
          onCancelPreview={() => {
            if (!task) return;
            void api.cancelReviewPreview(item.id, task.id).then(() => {
              setTask((current) => current ? { ...current, status: "cancelled", waitReason: null } : current);
            }).catch((cause: Error) => setError(cause.message));
          }}
          onKeep={() => void mutate("keep")}
          onDiscard={() => void mutate("discard")}
          onCancelWait={() => void mutate("cancel-wait")}
        />
      </div>
    </div>
  );
}

export function CompareClipsView({
  item,
  task,
  sample,
  customClock,
  originalAudioIndex,
  sidecarAudioIndex,
  audible,
  viewSide,
  layout,
  error,
  busy = false,
  firstControl,
  playerRef,
  onClose,
  onSelectPreset,
  onCustomClock,
  onLoadCustom,
  onOriginalAudio,
  onSidecarAudio,
  onAudible,
  onViewSide,
  onPlayPause,
  onRetry,
  onCancelPreview,
  onKeep,
  onDiscard,
  onCancelWait,
}: {
  item: ReviewRow;
  task: PreviewStatus | null;
  sample: PreviewSample | null;
  customClock: string;
  originalAudioIndex: number | null;
  sidecarAudioIndex: number | null;
  audible: CompareSide;
  viewSide: CompareSide;
  layout: CompareLayout;
  error?: string;
  busy?: boolean;
  firstControl?: RefObject<HTMLButtonElement | null>;
  playerRef?: RefObject<{ dispatch: (event: LinkedPlayerEvent) => void; currentTime: () => number } | null>;
  onClose: () => void;
  onSelectPreset: (id: PreviewPresetId) => void;
  onCustomClock: (value: string) => void;
  onLoadCustom: () => void;
  onOriginalAudio: (index: number) => void;
  onSidecarAudio: (index: number) => void;
  onAudible: (side: CompareSide) => void;
  onViewSide: (side: CompareSide) => void;
  onPlayPause: () => void;
  onRetry: () => void;
  onCancelPreview: () => void;
  onKeep: () => void;
  onDiscard: () => void;
  onCancelWait: () => void;
}) {
  const kind = previewUiKind(task);
  const originalTracks = item.source.audio ?? [];
  const finishedTracks = item.sidecar.audio ?? [];
  const originalUrl = kind === "ready" && task ? previewClipUrl(item.id, task.id, "original") : null;
  const finishedUrl = kind === "ready" && task ? previewClipUrl(item.id, task.id, "finished") : null;
  const fallbackPlayer = useRef<{ dispatch: (event: LinkedPlayerEvent) => void; currentTime: () => number } | null>(null);
  const linkedPlayer = playerRef ?? fallbackPlayer;
  const intervalCopy = actualIntervalCopy(task?.interval);
  const keepDisabled = item.status !== "pending";
  const discardDisabled = item.status !== "pending" && item.status !== "waiting";

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="compare-title" className="text-sm font-semibold tracking-wide text-ink">Compare clips</h2>
          <p className="m-0 mt-1 text-sm text-muted">{item.displayTitle}</p>
        </div>
        <button className="btn-secondary" type="button" onClick={onClose}>Close</button>
      </div>
      <p id="compare-status" className="m-0 text-sm" aria-live="polite">{previewStatusCopy(task)}</p>
      {intervalCopy && <p className="m-0 text-sm text-muted">{intervalCopy}</p>}
      <div>
        <p className="mb-2 text-sm font-medium">Sample position</p>
        <div className="flex flex-wrap gap-2">
          {PREVIEW_PRESETS.map((preset, index) => (
            <button
              key={preset.id}
              ref={index === 0 ? firstControl : undefined}
              className="btn-secondary"
              type="button"
              aria-pressed={sample === preset.id}
              onClick={() => onSelectPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-muted">Custom timestamp</span>
            <input
              className={FIELD_CONTROL}
              value={customClock}
              onChange={(event) => onCustomClock(event.target.value)}
              inputMode="numeric"
              aria-label="Custom timestamp"
              placeholder="0:00"
            />
          </label>
          <button className="btn-secondary" type="button" onClick={onLoadCustom}>Load custom clip</button>
        </div>
      </div>
      {(originalTracks.length > 0 || finishedTracks.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-muted">Original audio</span>
            <select
              className={FIELD_CONTROL}
              value={originalAudioIndex ?? ""}
              aria-label="Original audio"
              onChange={(event) => onOriginalAudio(Number(event.target.value))}
            >
              {originalTracks.map((track) => (
                <option key={track.index} value={track.index}>{previewTrackOption(track, "original", finishedTracks)}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-muted">Finished copy audio</span>
            <select
              className={FIELD_CONTROL}
              value={sidecarAudioIndex ?? ""}
              aria-label="Finished copy audio"
              onChange={(event) => onSidecarAudio(Number(event.target.value))}
            >
              {finishedTracks.map((track) => (
                <option key={track.index} value={track.index}>{previewTrackOption(track, "finished", originalTracks)}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {layout === "ab" && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Visible side">
          <button className="btn-secondary" type="button" aria-pressed={viewSide === "original"} onClick={() => onViewSide("original")}>
            Show original
          </button>
          <button className="btn-secondary" type="button" aria-pressed={viewSide === "finished"} onClick={() => onViewSide("finished")}>
            Show finished copy
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Audible side">
        <button className="btn-secondary" type="button" aria-pressed={audible === "original"} onClick={() => onAudible("original")}>
          Hear original
        </button>
        <button className="btn-secondary" type="button" aria-pressed={audible === "finished"} onClick={() => onAudible("finished")}>
          Hear finished copy
        </button>
        {kind === "ready" && (
          <button className="btn" type="button" onClick={onPlayPause}>Play or pause</button>
        )}
      </div>
      {originalUrl && finishedUrl ? (
        <LinkedClips
          originalUrl={originalUrl}
          finishedUrl={finishedUrl}
          audible={audible}
          viewSide={viewSide}
          layout={layout}
          playerRef={linkedPlayer}
        />
      ) : (
        <p className="m-0 text-sm text-muted">
          {layout === "ab" ? `Showing ${viewSide === "original" ? "original" : "finished copy"}. ` : ""}
          Clips appear here after you pick a sample.
        </p>
      )}
      <ul className="m-0 list-disc space-y-1 pl-5 text-sm text-muted">
        {previewTransformLines(task?.transform ?? null).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p id="compare-limits" className="m-0 text-sm text-muted">{PREVIEW_LIMITS_COPY}</p>
      <p className="m-0 text-sm text-muted">{PREVIEW_KEYBOARD_COPY}</p>
      {error && <p className="m-0 text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {(kind === "failed" || kind === "unavailable" || kind === "cancelled") && (
          <button className="btn-secondary" type="button" disabled={busy || !sample} onClick={onRetry}>Retry preview</button>
        )}
        {(kind === "queued" || kind === "playback-held" || kind === "generating") && (
          <button className="btn-secondary" type="button" disabled={busy} onClick={onCancelPreview}>Cancel preview</button>
        )}
        <button className="btn" type="button" disabled={keepDisabled || busy} onClick={onKeep}>
          {item.status === "keeping" ? "Keeping…" : item.status === "waiting" ? "Waiting…" : "Keep"}
        </button>
        {item.status === "waiting" && item.cancellable !== false && (
          <button className="btn-secondary" type="button" disabled={busy} onClick={onCancelWait}>Cancel wait</button>
        )}
        <button className="btn-secondary danger" type="button" disabled={discardDisabled || busy} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </>
  );
}

function LinkedClips({
  originalUrl,
  finishedUrl,
  audible,
  viewSide,
  layout,
  playerRef,
}: {
  originalUrl: string;
  finishedUrl: string;
  audible: CompareSide;
  viewSide: CompareSide;
  layout: CompareLayout;
  playerRef: RefObject<{ dispatch: (event: LinkedPlayerEvent) => void; currentTime: () => number } | null>;
}) {
  const originalEl = useRef<HTMLVideoElement>(null);
  const finishedEl = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState(() => initialLinkedPlayer(audible));
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback((event: LinkedPlayerEvent) => {
    setState((current) => {
      const next = reduceLinkedPlayer(current, event);
      const original = originalEl.current;
      const finished = finishedEl.current;
      if (original && finished && (event.type === "play" || event.type === "pause" || event.type === "toggle")) {
        original.muted = next.originalMuted;
        finished.muted = next.finishedMuted;
        if (next.pauseOriginal) original.pause();
        else void original.play().catch(() => undefined);
        if (next.pauseFinished) finished.pause();
        else void finished.play().catch(() => undefined);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setState(initialLinkedPlayer(audible));
    // Reset only when the clip pair changes; audio switching must not rebuild the players.
  }, [originalUrl, finishedUrl]);

  useEffect(() => {
    dispatch({ type: "audible", side: audible });
  }, [audible, dispatch]);

  useEffect(() => {
    playerRef.current = {
      dispatch,
      currentTime: () => {
        const master = stateRef.current.audible === "original" ? originalEl.current : finishedEl.current;
        return master?.currentTime ?? 0;
      },
    };
    return () => {
      playerRef.current = null;
    };
  }, [dispatch, playerRef]);

  useEffect(() => {
    const original = originalEl.current;
    const finished = finishedEl.current;
    if (!original || !finished) return;
    original.muted = state.originalMuted;
    finished.muted = state.finishedMuted;
    if (state.seekToSec != null) {
      const time = state.seekToSec;
      if (Math.abs(original.currentTime - time) > 0.05) original.currentTime = time;
      if (Math.abs(finished.currentTime - time) > 0.05) finished.currentTime = time;
    }
    if (state.pauseOriginal) original.pause();
    else void original.play().catch(() => undefined);
    if (state.pauseFinished) finished.pause();
    else void finished.play().catch(() => undefined);
  }, [state]);

  function onTimeUpdate() {
    const original = originalEl.current;
    const finished = finishedEl.current;
    if (!original || !finished) return;
    dispatch({ type: "tick", originalTimeSec: original.currentTime, finishedTimeSec: finished.currentTime });
  }

  return (
    <div className={`compare-players ${layout}`}>
      <ComparePlayer
        side="original"
        label="Original"
        url={originalUrl}
        videoRef={originalEl}
        active={layout === "split" || viewSide === "original"}
        audible={audible === "original"}
        onWaiting={() => dispatch({ type: "waiting", side: "original" })}
        onReady={() => dispatch({ type: "ready", side: "original" })}
        onTimeUpdate={onTimeUpdate}
      />
      <ComparePlayer
        side="finished"
        label="Finished copy"
        url={finishedUrl}
        videoRef={finishedEl}
        active={layout === "split" || viewSide === "finished"}
        audible={audible === "finished"}
        onWaiting={() => dispatch({ type: "waiting", side: "finished" })}
        onReady={() => dispatch({ type: "ready", side: "finished" })}
        onTimeUpdate={onTimeUpdate}
      />
    </div>
  );
}

function ComparePlayer({
  side,
  label,
  url,
  videoRef,
  active,
  audible,
  onWaiting,
  onReady,
  onTimeUpdate,
}: {
  side: CompareSide;
  label: string;
  url: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  active: boolean;
  audible: boolean;
  onWaiting: () => void;
  onReady: () => void;
  onTimeUpdate: () => void;
}) {
  return (
    <div className="compare-player" data-side={side} data-active={active ? "true" : "false"}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-sm font-medium">{label}</p>
        <p className="m-0 text-xs text-muted">{audible ? "Playing audio" : "Muted"}</p>
      </div>
      {active && <p className="sr-only">{`Showing ${label.toLowerCase()}`}</p>}
      <video
        ref={videoRef}
        src={url}
        playsInline
        muted={!audible}
        preload="metadata"
        onWaiting={onWaiting}
        onPlaying={onReady}
        onCanPlay={onReady}
        onSeeked={onReady}
        onTimeUpdate={onTimeUpdate}
      />
    </div>
  );
}
