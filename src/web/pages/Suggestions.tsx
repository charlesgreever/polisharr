import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ClusterNode, type SuggestionFilters, type SuggestionRow } from "../api";
import { EncodeNodeSelect } from "../components/EncodeNodeSelect";
import { bulkEncodeNeed } from "../encode-node";
import { PagedListControls } from "../components/PagedListControls";
import { Help, PageHead } from "../components/Shell";
import { FilterChip, MediaSnapshot } from "../components/ui";
import {
  loadedSelection,
  queueAllConfirmCopy,
  queueBatchCopy,
  selectLoaded,
  suggestionViewIsFiltered,
  toggleRange,
} from "../suggestion-selection";
import { usePagedList } from "../use-paged-list";

export function SuggestionsPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(q);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [msg, setMsg] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [filters, setFilters] = useState<SuggestionFilters>({});
  const [sort, setSort] = useState<"title" | "savings">(params.get("sort") === "savings" ? "savings" : "title");
  const [nodes, setNodes] = useState<ClusterNode[]>([]);
  const [defaultNodeId, setDefaultNodeId] = useState("");
  const [encodeNodeId, setEncodeNodeId] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams();
      if (q) next.set("q", q);
      if (sort === "savings") next.set("sort", "savings");
      setParams(next);
      setDebouncedQ(q);
      setSelected({});
      setAnchorId(null);
    }, 280);
    return () => clearTimeout(t);
  }, [q, sort, setParams]);
  useEffect(() => {
    void api.nodes().then((payload) => {
      setNodes(payload.nodes);
      setDefaultNodeId(payload.defaultEncodeNodeId);
      setEncodeNodeId((current) => current || payload.defaultEncodeNodeId);
    }).catch(() => undefined);
  }, []);
  const list = usePagedList({
    queryKey: JSON.stringify([debouncedQ, filters, sort]),
    loadPage: (offset, limit) => api.suggestions(debouncedQ, filters, offset, limit, sort),
    keyOf: (row: SuggestionRow) => row.id,
  });
  const items = list.items;
  const loadedIds = items.map((row) => row.id);
  const selectedIds = loadedIds.filter((id) => selected[id]);
  const header = loadedSelection(loadedIds, selected);
  const filteredView = suggestionViewIsFiltered(debouncedQ, filters);
  const nodeId = encodeNodeId || undefined;

  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = header === "some";
  }, [header]);

  useEffect(() => {
    if (!confirmAll) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmAll(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmAll]);

  async function runBatch(action: () => Promise<{ queued: number; skipped: number }>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await action();
      setMsg(queueBatchCopy(result.queued, result.skipped));
      setSelected({});
      setAnchorId(null);
      await list.reload();
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "The queue request failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section>
      <PageHead title="Suggestions" />
      <Help>
        Suggestions is the work list: only titles that still need something. Open a title for custom work. Tracks-only means keep the video and clean languages. After size stays blank when the video will not shrink. Largest savings puts the biggest estimated disk wins first. Queue next 10 takes the first 10 rows in the current sort. Queue all asks before it adds the rest of this list. Checked rows queue on their own.
      </Help>
      <div className="mt-5 space-y-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <input className="filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search suggestions" />
            <select value={filters.type ?? ""} onChange={(event) => setFilter("type", event.target.value)}>
              <option value="">Movies and TV</option><option value="movie">Movies</option><option value="episode">TV episodes</option>
            </select>
            <select value={filters.resolution ?? ""} onChange={(event) => setFilter("resolution", event.target.value)}>
              <option value="">Any resolution</option><option value="1080p">1080p</option><option value="4k">4K</option>
            </select>
            <select value={filters.hdr ?? ""} onChange={(event) => setFilter("hdr", event.target.value)}>
              <option value="">HDR and SDR</option><option value="hdr">HDR</option><option value="sdr">SDR</option>
            </select>
            <select value={filters.codec ?? ""} onChange={(event) => setFilter("codec", event.target.value)}>
              <option value="">Any codec</option><option value="h264">H.264</option><option value="hevc">HEVC</option><option value="av1">AV1</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-muted">
              <span className="whitespace-nowrap font-medium">Sort by</span>
              <select value={sort} onChange={(event) => setSort(event.target.value === "savings" ? "savings" : "title")}>
                <option value="title">Title</option>
                <option value="savings">Largest savings</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EncodeNodeSelect
              nodes={nodes}
              value={encodeNodeId}
              defaultNodeId={defaultNodeId}
              need={bulkEncodeNeed(items.map((row) => row.after.codec))}
              onChange={setEncodeNodeId}
            />
            <button
              className="btn-secondary"
              type="button"
              disabled={busy || list.total === 0}
              onClick={() => void runBatch(() => api.queueFiltered(debouncedQ, filters, nodeId, { sort, limit: 10 }))}
            >
              Queue next 10
            </button>
            <button
              className="btn-secondary"
              type="button"
              disabled={busy || list.total === 0}
              onClick={() => setConfirmAll(true)}
            >
              {`Queue all (${list.total})`}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || selectedIds.length === 0}
              onClick={() => void runBatch(() => api.queueSelected(selectedIds, nodeId))}
            >
              {`Queue selected (${selectedIds.length})`}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["overCap", "extraTracks", "exempt", "hardwareWarning"] as const).map((key) => (
            <FilterChip
              key={key}
              pressed={filters[key] === true}
              onToggle={() => {
                setSelected({});
                setAnchorId(null);
                setFilters((current) => ({ ...current, [key]: current[key] ? undefined : true }));
              }}
            >
              {filterLabel(key)}
            </FilterChip>
          ))}
        </div>
      </div>
      {confirmAll && (
        <div className="modal-scrim" role="presentation" onClick={() => setConfirmAll(false)}>
          <div
            className="modal-card glass space-y-3 p-5"
            role="dialog"
            aria-labelledby="queue-all-title"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="queue-all-title" className="text-sm font-semibold tracking-wide text-ink">Queue all suggestions?</h2>
            <p className="m-0 text-sm leading-5 text-muted">{queueAllConfirmCopy(list.total, filteredView)}</p>
            <div className="flex flex-wrap gap-2">
              <button
                ref={confirmRef}
                className="btn"
                type="button"
                onClick={() => {
                  setConfirmAll(false);
                  void runBatch(() => api.queueFiltered(debouncedQ, filters, nodeId, { sort }));
                }}
              >
                Queue all
              </button>
              <button className="btn-secondary" type="button" onClick={() => setConfirmAll(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {items.length === 0 && list.loading && <div className="empty">Loading suggestions…</div>}
      {items.length === 0 && !list.loading && !list.error && <div className="empty">No open work. Healthy files stay off this list.</div>}
      {items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th className="w-10">
                  <input
                    ref={headerRef}
                    className="size-4 accent-accent"
                    type="checkbox"
                    checked={header === "all"}
                    aria-label="Select loaded suggestions"
                    onChange={() => undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      setSelected((current) => selectLoaded(loadedIds, current, header !== "all"));
                    }}
                  />
                </th>
                <th>Title</th>
                <th>Why</th>
                <th>Now</th>
                <th>
                  <button type="button" onClick={() => setSort((current) => current === "savings" ? "title" : "savings")}>
                    After
                  </button>
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      className="size-4 accent-accent"
                      type="checkbox"
                      checked={Boolean(selected[item.id])}
                      aria-label={`Select ${item.displayTitle}`}
                      onChange={() => undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        const checked = !selected[item.id];
                        setSelected((current) => (
                          event.shiftKey
                            ? toggleRange(loadedIds, current, anchorId, item.id, checked)
                            : selectLoaded([item.id], current, checked)
                        ));
                        setAnchorId(item.id);
                      }}
                    />
                  </td>
                  <td className="min-w-44">
                    <Link
                      className="font-medium text-ink hover:text-accent"
                      to={item.href || (item.type === "episode" ? `/series/episodes/${item.itemId}` : `/movies/${item.itemId}`)}
                    >
                      {item.displayTitle}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted">{item.instanceName}</div>
                  </td>
                  <td className="max-w-sm">
                    <ul className="space-y-1 text-sm leading-5 text-muted">
                      {item.reasons.map((reason, index) => (
                        <li key={`${index}:${reason}`}>{reason}</li>
                      ))}
                    </ul>
                    {item.warning && <p className="mt-1 text-xs text-warn">{item.warning}</p>}
                  </td>
                  <td><MediaSnapshot snapshot={item.now} /></td>
                  <td><MediaSnapshot snapshot={item.after} savingsBytes={item.estimatedSavingsBytes} emphasize /></td>
                  <td>
                    <div className="flex min-w-24 flex-col gap-1.5">
                      <button className="btn" type="button" onClick={() => void api.queue({ suggestionId: item.id, assignedNodeId: encodeNodeId || undefined }).then(() => setMsg("Added to queue."))}>
                        Queue
                      </button>
                      <button className="btn-secondary danger" type="button" onClick={() => void api.dismiss(item.id).then(list.reload)}>
                        Dismiss
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedListControls loading={list.loading} error={list.error} nextOffset={list.nextOffset} noun="suggestions" onLoadMore={list.loadMore} onRetry={list.reload} />
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </section>
  );

  function setFilter(key: "type" | "resolution" | "hdr" | "codec", value: string) {
    setSelected({});
    setAnchorId(null);
    if (key === "type" && (value === "" || value === "movie" || value === "episode")) {
      setFilters((current) => ({ ...current, type: value || undefined }));
    }
    if (key === "resolution" && (value === "" || value === "1080p" || value === "4k")) {
      setFilters((current) => ({ ...current, resolution: value || undefined }));
    }
    if (key === "hdr" && (value === "" || value === "hdr" || value === "sdr")) {
      setFilters((current) => ({ ...current, hdr: value || undefined }));
    }
    if (key === "codec" && (value === "" || value === "h264" || value === "hevc" || value === "av1")) {
      setFilters((current) => ({ ...current, codec: value || undefined }));
    }
  }
}

function filterLabel(key: "overCap" | "extraTracks" | "exempt" | "hardwareWarning"): string {
  return { overCap: "Over cap", extraTracks: "Extra tracks", exempt: "Exempt", hardwareWarning: "Hardware warnings" }[key];
}
