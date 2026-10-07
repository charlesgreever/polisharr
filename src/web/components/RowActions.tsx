import { useState } from "react";
import { api, type LibraryRow } from "../api";
import { arrAppName, replaceSearchConfirm, untrackConfirm } from "../library-replace";
import { Icons } from "./icons";
import { ActionNote } from "./ui";

const gridBtn =
  "inline-flex h-11 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40 lg:h-8";
const queueBtn =
  `${gridBtn} border border-brand-500 bg-brand-500 text-white hover:border-brand-600 hover:bg-brand-600`;
const textBtn =
  `${gridBtn} border border-gray-200 bg-white text-gray-700 hover:border-brand-300 hover:bg-gray-50 dark:border-gray-800 dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/5`;
const dangerBtn =
  `${gridBtn} border border-error-300 bg-error-50 text-error-600 hover:bg-error-100 dark:border-error-500/35 dark:bg-error-500/10 dark:text-error-500`;

type Note = { tone: "ok" | "bad"; text: string };

export function RowActions({
  item,
  onDone,
  onHealth,
}: {
  item: LibraryRow;
  onDone: () => void;
  onHealth?: (health: { healthyCount: number; suggestionCount: number }) => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const locked = Boolean(item.error) || !item.inspected;
  const arrName = arrAppName(item.type);

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setNote({ tone: "ok", text: label });
      onDone();
    } catch (error) {
      setNote({ tone: "bad", text: error instanceof Error ? error.message : "The action failed." });
    }
  }

  return (
    <div className="flex w-[22rem] max-w-full flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Optimize">
        <button
          className={queueBtn}
          type="button"
          disabled={locked || !item.suggestion}
          aria-label="Queue"
          onClick={() => void run("Added to queue.", () => api.queue({ itemId: item.id }))}
        >
          <span aria-hidden="true">{Icons.queue({ width: 16, height: 16 })}</span>
          Queue
        </button>
        <button
          className={textBtn}
          type="button"
          disabled={locked}
          aria-label="Force suggestion"
          onClick={() => void run("Added this title to Suggestions.", () => api.force(item.id))}
        >
          <span aria-hidden="true">{Icons.suggestions({ width: 16, height: 16 })}</span>
          Force
        </button>
        <button
          className={textBtn}
          type="button"
          disabled={locked}
          aria-label="Add stereo"
          onClick={() => void run("Added stereo to the plan.", () => api.stereo(item.id))}
        >
          <span aria-hidden="true">{Icons.stereo({ width: 16, height: 16 })}</span>
          Stereo
        </button>
        <button
          className={`${textBtn} min-w-[10.5rem] ${item.sizeExempt ? "border-brand-200 bg-brand-50 text-brand-500 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-400" : ""}`}
          type="button"
          aria-label={item.sizeExempt ? "Clear exemption" : "Exempt"}
          aria-pressed={item.sizeExempt}
          onClick={() => void run(item.sizeExempt ? "Cleared exemption." : "Size cap exemption saved.", () => api.exempt(item.id, !item.sizeExempt))}
        >
          <span aria-hidden="true">{Icons.exempt({ width: 16, height: 16 })}</span>
          {item.sizeExempt ? "Clear exemption" : "Exempt"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Library">
        <button
          className={textBtn}
          type="button"
          aria-label={`Replace this file in ${arrName}`}
          onClick={() => {
            if (!window.confirm(replaceSearchConfirm(arrName, item.sharedFileLabel))) return;
            void run(`${arrName} will search for a replacement.`, async () => {
              const health = await api.replaceSearch(item.id);
              if (health.healthyCount != null && health.suggestionCount != null) {
                onHealth?.({ healthyCount: health.healthyCount, suggestionCount: health.suggestionCount });
              }
            });
          }}
        >
          Replace this file
        </button>
        <button
          className={dangerBtn}
          type="button"
          aria-label={`Remove this ${item.type === "episode" ? "series" : "movie"} from ${arrName}`}
          onClick={() => {
            const kind = item.type === "episode" ? "series" : "movie";
            const title = item.type === "episode" ? (item.showTitle || item.displayTitle) : item.displayTitle;
            if (!window.confirm(untrackConfirm(arrName, title, kind))) return;
            void run(`${arrName} stopped tracking this title.`, async () => {
              const health = await api.untrackItem(item.id);
              if (health.healthyCount != null && health.suggestionCount != null) {
                onHealth?.({ healthyCount: health.healthyCount, suggestionCount: health.suggestionCount });
              }
            });
          }}
        >
          {`Remove from ${arrName}`}
        </button>
      </div>
      {note ? <ActionNote tone={note.tone}>{note.text}</ActionNote> : null}
    </div>
  );
}
