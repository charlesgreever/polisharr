import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ClusterNode, type SuggestionFilters, type SuggestionRow } from "../api";
import { EncodeNodeSelect } from "../components/EncodeNodeSelect";
import { encodeNeedFromAfterCodec } from "../encode-node";
import { PagedListControls } from "../components/PagedListControls";
import { Help, PageHead } from "../components/Shell";
import { FilterChip, MediaSnapshot } from "../components/ui";
import { usePagedList } from "../use-paged-list";

export function SuggestionsPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(q);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState("");
  const [filters, setFilters] = useState<SuggestionFilters>({});
  const [nodes, setNodes] = useState<ClusterNode[]>([]);
  const [defaultNodeId, setDefaultNodeId] = useState("");
  const [encodeNodeId, setEncodeNodeId] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setParams(q ? { q } : {});
      setDebouncedQ(q);
      setSelected({});
    }, 280);
    return () => clearTimeout(t);
  }, [q, setParams]);
  useEffect(() => {
    void api.nodes().then((payload) => {
      setNodes(payload.nodes);
      setDefaultNodeId(payload.defaultEncodeNodeId);
      setEncodeNodeId((current) => current || payload.defaultEncodeNodeId);
    }).catch(() => undefined);
  }, []);
  const list = usePagedList({
    queryKey: JSON.stringify([debouncedQ, filters]),
    loadPage: (offset, limit) => api.suggestions(debouncedQ, filters, offset, limit),
    keyOf: (row: SuggestionRow) => row.id,
  });
  const items = list.items;

  return (
    <section>
      <PageHead title="Suggestions" />
      <Help>
        Suggestions is the work list: only titles that still need something. Open a title for custom work. Tracks-only means keep the video and clean languages. After size stays blank when the video will not shrink.
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
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EncodeNodeSelect
              nodes={nodes}
              value={encodeNodeId}
              defaultNodeId={defaultNodeId}
              need={items.some((row) => encodeNeedFromAfterCodec(row.after.codec) === "av1") ? "av1" : "hevc"}
              onChange={setEncodeNodeId}
            />
            <button className="btn-secondary" type="button" onClick={() => void api.queueFiltered(debouncedQ, filters, encodeNodeId || undefined).then((result) => {
              setMsg(`Queued ${result.queued}; skipped ${result.skipped}.`);
              return list.reload();
            }).catch((error: Error) => setMsg(error.message))}>Queue filtered</button>
            <button
              className="btn"
              type="button"
              disabled={!Object.values(selected).some(Boolean)}
              onClick={() => {
                const ids = items.filter((i) => selected[i.id]).map((i) => i.id);
                void Promise.all(ids.map((id) => api.queue({ suggestionId: id, assignedNodeId: encodeNodeId || undefined }))).then(() => {
                  setMsg(`Queued ${ids.length}.`);
                  setSelected({});
                  return list.reload();
                });
              }}
            >
              Add selected to queue
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["overCap", "extraTracks", "exempt", "hardwareWarning"] as const).map((key) => (
            <FilterChip
              key={key}
              pressed={filters[key] === true}
              onToggle={() => setFilters((current) => ({ ...current, [key]: current[key] ? undefined : true }))}
            >
              {filterLabel(key)}
            </FilterChip>
          ))}
        </div>
      </div>
      {items.length === 0 && list.loading && <div className="empty">Loading suggestions…</div>}
      {items.length === 0 && !list.loading && !list.error && <div className="empty">No open work. Healthy files stay off this list.</div>}
      {items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th className="w-10"></th>
                <th>Title</th>
                <th>Why</th>
                <th>Now</th>
                <th>After</th>
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
                      onChange={(e) => setSelected((s) => ({ ...s, [item.id]: e.target.checked }))}
                      aria-label={`Select ${item.displayTitle}`}
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
