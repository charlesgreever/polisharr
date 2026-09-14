import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PlaybackDiagnostic, type PlaybackObservation } from "../api";
import { PagedListControls } from "../components/PagedListControls";
import { Help, PageHead } from "../components/Shell";
import { FilterChip } from "../components/ui";
import { usePagedList } from "../use-paged-list";

const FAMILIES = ["", "audio", "video", "subtitle", "container", "bitrate", "unknown"] as const;

export function problemWindowLabel(total: number, days: number): string {
  const noun = total === 1 ? "problem" : "problems";
  return `${total} ${noun} in the last ${days} days`;
}

export function PlaybackPage() {
  const [view, setView] = useState<"problems" | "observations">("problems");
  const [days, setDays] = useState<7 | 30>(7);
  const [title, setTitle] = useState("");
  const [debouncedTitle, setDebouncedTitle] = useState("");
  const [client, setClient] = useState("");
  const [debouncedClient, setDebouncedClient] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [reasonFamily, setReasonFamily] = useState("");
  const [msg, setMsg] = useState("");
  const [connections, setConnections] = useState<Array<{ connectionId: string; name?: string }>>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTitle(title.trim());
      setDebouncedClient(client.trim());
    }, 280);
    return () => clearTimeout(timer);
  }, [title, client]);
  useEffect(() => {
    void api.playbackSettings().then((payload) => {
      setConnections(payload.connections.map((row) => ({ connectionId: row.connectionId, name: row.name })));
    }).catch(() => undefined);
  }, []);

  const queryKey = JSON.stringify([view, days, debouncedTitle, debouncedClient, connectionId, reasonFamily]);
  const list = usePagedList({
    queryKey,
    pollMs: 10_000,
    loadPage: async (offset, limit) => {
      const query = {
        offset,
        limit,
        days,
        title: debouncedTitle || undefined,
        client: debouncedClient || undefined,
        connectionId: connectionId || undefined,
        reasonFamily: reasonFamily || undefined,
      };
      if (view === "problems") return api.playbackDiagnostics(query);
      return api.playbackObservations(query);
    },
    keyOf: (row: PlaybackDiagnostic | PlaybackObservation) => row.id,
  });

  return (
    <section>
      <PageHead title="Playback" />
      <Help>
        Playback lists Jellyfin conversion problems Polisharr observed. Open a repair plan to review a custom change before anything is queued. Observation never starts work on its own.
      </Help>
      <div className="mt-5 space-y-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03]">
        <div className="flex flex-wrap gap-2">
          <FilterChip pressed={view === "problems"} onToggle={() => setView("problems")}>Recent problems</FilterChip>
          <FilterChip pressed={view === "observations"} onToggle={() => setView("observations")}>Recent observations</FilterChip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="filter" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Search titles" />
          <input className="filter" value={client} onChange={(event) => setClient(event.target.value)} placeholder="Filter by player" />
          <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
            <option value="">Any Jellyfin connection</option>
            {connections.map((row) => (
              <option key={row.connectionId} value={row.connectionId}>{row.name || row.connectionId}</option>
            ))}
          </select>
          <select value={reasonFamily} onChange={(event) => setReasonFamily(event.target.value)}>
            <option value="">Any reason</option>
            {FAMILIES.filter(Boolean).map((family) => (
              <option key={family} value={family}>{family}</option>
            ))}
          </select>
          <select value={String(days)} onChange={(event) => setDays(event.target.value === "30" ? 30 : 7)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
        {view === "problems" && (
          <p className="m-0 text-sm text-muted">{problemWindowLabel(list.total, days)}</p>
        )}
      </div>
      {list.items.length === 0 && list.loading && <div className="empty">Loading playback…</div>}
      {list.items.length === 0 && !list.loading && !list.error && (
        <div className="empty">{view === "problems" ? "No conversion problems in this window." : "No playback observations in this window."}</div>
      )}
      {view === "problems" && list.items.length > 0 && (
        <PlaybackProblemList
          items={list.items as PlaybackDiagnostic[]}
          onDismiss={(id) => {
            void api.dismissPlaybackDiagnostic(id).then(() => {
              setMsg("Recommendation dismissed for this file, player, and reason.");
              return list.reload();
            }).catch((error: Error) => setMsg(error.message));
          }}
        />
      )}
      {view === "observations" && list.items.length > 0 && (
        <PlaybackObservationList items={list.items as PlaybackObservation[]} />
      )}
      {msg && <p className="ok mt-3 text-sm">{msg}</p>}
      <PagedListControls
        loading={list.loading}
        error={list.error}
        nextOffset={list.nextOffset}
        noun={view === "problems" ? "problems" : "observations"}
        onLoadMore={list.loadMore}
        onRetry={list.reload}
      />
    </section>
  );
}

export function PlaybackProblemList({
  items,
  onDismiss,
}: {
  items: PlaybackDiagnostic[];
  message?: string;
  onDismiss?: (id: string) => void;
}) {
  return (
    <ul className="mt-5 space-y-3">
      {items.map((row) => (
        <li key={row.id} className="table-card p-4">
          <PlaybackProblemCard row={row} onDismiss={onDismiss} />
        </li>
      ))}
    </ul>
  );
}

export function PlaybackProblemCard({ row, onDismiss }: { row: PlaybackDiagnostic; onDismiss?: (id: string) => void }) {
  const href = row.href ? `${row.href}?repair=${encodeURIComponent(row.id)}` : "";
  return (
    <article className="space-y-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink">
            {row.href ? <Link className="hover:text-accent" to={row.href}>{row.itemName}</Link> : row.itemName}
          </h2>
          <p className="m-0 text-sm text-muted">{row.deviceLabel} · {row.connectionName || "Jellyfin"} · {new Date(row.lastSeenAt).toLocaleString()}</p>
        </div>
        <p className="m-0 text-xs font-medium uppercase tracking-wide text-muted">{row.occurrenceCount === 1 ? "1 viewing" : `${row.occurrenceCount} viewings`}</p>
      </div>
      <p className="m-0 text-sm text-ink">{row.summary}</p>
      <p className="m-0 text-sm text-muted">{row.recommendation.explanation}</p>
      {row.afterKeep.sentence && <p className="m-0 text-sm text-ink">{row.afterKeep.sentence}</p>}
      {row.stale && <p className="m-0 text-sm text-warn">This Jellyfin connection looks stale.</p>}
      <details className="text-sm text-muted">
        <summary className="min-h-11 cursor-pointer py-2">Show details</summary>
        <p className="m-0">Playback method: {row.playMethod || "unknown"}</p>
        <p className="m-0">Match: {row.match}</p>
        <p className="m-0">Reported reason: {row.rawReasons.length ? row.rawReasons.join(", ") : "Jellyfin did not report the reason."}</p>
      </details>
      <div className="flex flex-wrap gap-2">
        {row.recommendation.openEditor && href && (
          <Link className="btn min-h-11" to={href}>Open repair plan</Link>
        )}
        {onDismiss && (
          <button className="btn-secondary min-h-11" type="button" onClick={() => onDismiss(row.id)}>
            Dismiss
          </button>
        )}
      </div>
    </article>
  );
}

export function PlaybackObservationList({ items }: { items: PlaybackObservation[] }) {
  return (
    <div className="table-card mt-5">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Title</th>
            <th>Player</th>
            <th>What happened</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id}>
              <td>{new Date(row.lastSeenAt).toLocaleString()}</td>
              <td className="font-medium text-ink">{row.itemName}</td>
              <td>{row.deviceLabel}</td>
              <td>{row.summary}{row.stale ? " Connection looks stale." : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
