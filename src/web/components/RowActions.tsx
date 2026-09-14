import { Link } from "react-router-dom";
import { useState } from "react";
import { api, type LibraryRow } from "../api";
import { arrAppName, replaceSearchConfirm, untrackConfirm } from "../library-replace";
import { EncodeTargetSelect } from "./EncodeTargetSelect";
import { Icons } from "./icons";

const iconBtn =
  "inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 transition-colors hover:border-brand-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-800 dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/5";
const queueBtn =
  "inline-flex h-11 items-center justify-center gap-1 rounded-lg border border-brand-500 bg-brand-500 px-2.5 text-xs font-semibold text-white transition-colors hover:border-brand-600 hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40";
const textBtn =
  "inline-flex h-11 items-center justify-center rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-semibold text-gray-700 transition-colors hover:border-brand-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-800 dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/5";

export function RowActions({
  item,
  onDone,
  onHealth,
  houseVideoTarget = "hevc",
  av1Available = false,
}: {
  item: LibraryRow;
  onDone: () => void;
  onHealth?: (health: { healthyCount: number; suggestionCount: number }) => void;
  houseVideoTarget?: "hevc" | "av1";
  av1Available?: boolean;
}) {
  const [msg, setMsg] = useState("");
  const locked = Boolean(item.error) || !item.inspected;
  const href = item.href || (item.type === "movie" ? `/movies/${item.id}` : `/series/episodes/${item.id}`);
  const arrName = arrAppName(item.type);

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMsg(label);
      onDone();
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "The action failed.");
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-nowrap items-center gap-1" role="group" aria-label="Title actions">
        <Link className={iconBtn} to={href} title="Open" aria-label="Open">
          {Icons.open({ width: 14, height: 14 })}
        </Link>
        <button
          className={queueBtn}
          type="button"
          disabled={locked || !item.suggestion}
          title="Queue"
          aria-label="Queue"
          onClick={() => void run("Added to queue.", () => api.queue({ itemId: item.id }))}
        >
          {Icons.queue({ width: 14, height: 14 })}
          Queue
        </button>
        <button
          className={iconBtn}
          type="button"
          disabled={locked}
          title="Force suggestion"
          aria-label="Force suggestion"
          onClick={() => void run("Added this title to Suggestions.", () => api.force(item.id))}
        >
          {Icons.suggestions({ width: 14, height: 14 })}
        </button>
        <button
          className={iconBtn}
          type="button"
          disabled={locked}
          title="Add stereo"
          aria-label="Add stereo"
          onClick={() => void run("Added stereo to the plan.", () => api.stereo(item.id))}
        >
          {Icons.stereo({ width: 14, height: 14 })}
        </button>
        <button
          className={`${iconBtn} ${item.sizeExempt ? "border-brand-200 bg-brand-50 text-brand-500 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-400" : ""}`}
          type="button"
          title={item.sizeExempt ? "Clear size exemption" : "Exempt size"}
          aria-label={item.sizeExempt ? "Clear exemption" : "Exempt"}
          aria-pressed={item.sizeExempt}
          onClick={() => void run(item.sizeExempt ? "Cleared exemption." : "Size cap exemption saved.", () => api.exempt(item.id, !item.sizeExempt))}
        >
          {Icons.exempt({ width: 14, height: 14 })}
          {item.sizeExempt ? "Clear exemption" : "Exempt"}
        </button>
        <button
          className={textBtn}
          type="button"
          title={`Ask ${arrName} to remove this file and search again`}
          aria-label={`Ask ${arrName} to remove this file and search again`}
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
          Search again
        </button>
        <button
          className={`${textBtn} text-error-600 dark:text-error-500`}
          type="button"
          title={`Stop tracking in ${arrName}`}
          aria-label={`Stop tracking in ${arrName}`}
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
          Stop tracking
        </button>
      </div>
      {item.type === "movie" && (
        <EncodeTargetSelect
          value={item.videoTarget ?? null}
          houseTarget={houseVideoTarget}
          av1Available={av1Available}
          onChange={(videoTarget) => {
            void api.setItemVideoTarget(item.id, videoTarget).then((result) => {
              setMsg("Encode target saved.");
              onHealth?.(result);
              onDone();
            }).catch((error: Error) => setMsg(error.message));
          }}
        />
      )}
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}
