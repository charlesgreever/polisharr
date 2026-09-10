import { useEffect, useRef, useState } from "react";
import { api, formatDuration, formatGbHour, formatSize, type ReviewRow } from "../api";
import { reviewEncodeLine } from "../review-copy";
import { PagedListControls } from "../components/PagedListControls";
import { Help, PageHead } from "../components/Shell";
import { usePagedList } from "../use-paged-list";

export function keepAllConfirmCopy(count: number): string {
  const noun = count === 1 ? "file" : "files";
  return `Keep all ${count} ${noun}? This replaces each library file with its new copy.`;
}

export function keepStartedCopy(accepted: number, skipped: number): string {
  if (skipped === 0) return `Keep started for ${accepted}.`;
  return `Keep started for ${accepted}; skipped ${skipped}.`;
}

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

  const pending = items.filter((i) => i.status === "pending");
  const chosen = pending.filter((i) => selected?.[i.id]);
  const pendingCount = list.pendingCount || pending.length;

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

  return (
    <section>
      <PageHead title="Review">
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            type="button"
            disabled={chosen.length === 0}
            onClick={() => void api.keepSelected(chosen.map((i) => i.id)).then((r) => {
              setMsg(keepStartedCopy(r.accepted, r.skipped));
              setSelected({});
              return list.reload();
            })}
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
        Review compares the original and the sidecar: size, codec, duration, tracks, and GB per hour. The card names the encode node, the GPU API, the device, and how long the job ran. Keep replaces the library file. Discard throws the sidecar away. Encode smaller queues a tighter size target after a miss. The original stays until Keep finishes. If Polisharr restarts during Keep, the card comes back so you can try again, unless the new file is already in the library. Keep all promotes every waiting sidecar after you confirm.
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
                  void api.keepAll().then((result) => {
                    setMsg(keepStartedCopy(result.accepted, result.skipped));
                    setSelected({});
                    return list.reload();
                  }).catch((error: Error) => setMsg(error.message));
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
              <label className="flex items-start gap-3">
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
                    <button className="btn" type="button" disabled={item.status !== "pending"} onClick={() => void api.keep(item.id).then(list.reload)}>
                      {item.status === "keeping" ? "Keeping…" : "Keep"}
                    </button>
                    <button className="btn-secondary danger" type="button" disabled={item.status !== "pending"} onClick={() => void api.discard(item.id).then(list.reload)}>
                      Discard
                    </button>
                    {item.flagged && item.status === "pending" && (
                      <button
                        className="btn-secondary"
                        type="button"
                        onClick={() => void api.requeueFlagged(item.id).then(() => {
                          setMsg("Queued a smaller encode.");
                          return list.reload();
                        }).catch((error: Error) => setMsg(error.message))}
                      >
                        Encode smaller
                      </button>
                    )}
                  </div>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
      <PagedListControls loading={list.loading} error={list.error} nextOffset={list.nextOffset} noun="reviews" onLoadMore={list.loadMore} onRetry={list.reload} />
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </section>
  );
}
