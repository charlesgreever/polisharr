import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type LibraryRow } from "../api";
import { Help, PageHead } from "../components/Shell";
import { RefreshLibrary } from "../components/RefreshLibrary";
import { LibraryMediaCells, LibraryMediaHeaders } from "../components/LibraryMediaCells";
import { Pill } from "../components/ui";
import { loadRetainedPages, mergePage } from "../library-pages";

export function MoviesPage() {
  const [items, setItems] = useState<LibraryRow[]>([]);
  const [sort, setSort] = useState<"title" | "size" | "quality">("title");
  const [error, setError] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [healthyCount, setHealthyCount] = useState(0);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [houseVideoTarget, setHouseVideoTarget] = useState<"hevc" | "av1">("hevc");
  const [av1Available, setAv1Available] = useState(false);
  const loadingRef = useRef(false);
  const activeSortRef = useRef(sort);
  const currentSortRef = useRef(sort);
  const pendingSortResetRef = useRef(false);
  const pendingRetainRef = useRef(false);
  const itemsRef = useRef<LibraryRow[]>([]);
  itemsRef.current = items;

  const load = async (reset = false, requestedSort = currentSortRef.current) => {
    if (loadingRef.current) {
      if (reset) pendingSortResetRef.current = true;
      return;
    }
    const offset = reset ? 0 : nextOffset;
    if (offset == null) return;
    loadingRef.current = true;
    activeSortRef.current = requestedSort;
    setLoading(true);
    setError("");
    try {
      const page = await api.movies(offset, 50, requestedSort);
      setItems((current) => {
        const next = reset ? page.items : mergePage(current, page.items);
        itemsRef.current = next;
        return next;
      });
      setNextOffset(page.nextOffset);
      setTotal(page.total);
      setHealthyCount(page.healthyCount ?? 0);
      setSuggestionCount(page.suggestionCount ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Movies could not be loaded.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (pendingSortResetRef.current) {
        pendingSortResetRef.current = false;
        pendingRetainRef.current = false;
        void load(true, currentSortRef.current);
      } else if (pendingRetainRef.current) {
        pendingRetainRef.current = false;
        void refreshLoaded();
      }
    }
  };

  const refreshLoaded = async () => {
    if (loadingRef.current) {
      pendingRetainRef.current = true;
      return;
    }
    const loadedCount = Math.max(itemsRef.current.length, 1);
    const requestedSort = currentSortRef.current;
    loadingRef.current = true;
    activeSortRef.current = requestedSort;
    setLoading(true);
    setError("");
    try {
      let total = 0;
      let healthyCount = 0;
      let suggestionCount = 0;
      const page = await loadRetainedPages(async (offset) => {
        const result = await api.movies(offset, 50, requestedSort);
        if (offset === 0) {
          total = result.total;
          healthyCount = result.healthyCount ?? 0;
          suggestionCount = result.suggestionCount ?? 0;
        }
        return result;
      }, loadedCount);
      if (activeSortRef.current !== requestedSort) return;
      itemsRef.current = page.items;
      setItems(page.items);
      setNextOffset(page.nextOffset);
      setTotal(total);
      setHealthyCount(healthyCount);
      setSuggestionCount(suggestionCount);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Movies could not be loaded.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (pendingSortResetRef.current) {
        pendingSortResetRef.current = false;
        pendingRetainRef.current = false;
        void load(true, currentSortRef.current);
      } else if (pendingRetainRef.current) {
        pendingRetainRef.current = false;
        void refreshLoaded();
      }
    }
  };
  useEffect(() => {
    void api.settings().then((settings) => {
      setHouseVideoTarget(settings.videoTarget === "av1" ? "av1" : "hevc");
    }).catch(() => undefined);
    void api.nodes().then((payload) => setAv1Available(Boolean(payload.av1Available))).catch(() => undefined);
  }, []);

  useEffect(() => {
    currentSortRef.current = sort;
    if (loadingRef.current) {
      pendingSortResetRef.current = activeSortRef.current !== sort;
      return;
    }
    void load(true, sort);
  }, [sort]);

  return (
    <section>
      <PageHead title="Movies">
        <RefreshLibrary onDone={() => void load(true)} />
      </PageHead>
      <Help>Each row is one movie. Encode target chooses HEVC or AV1 for automatic Suggestions on that movie. House default follows Settings. Open a title for custom work. Queue still uses the automatic suggestion. Exempt keeps a large file off the size cap so Polisharr only offers language cleanup and stereo. The header counts every movie, not just this page.</Help>
      {total > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>{total} movies</span>
          <Pill tone="good">{healthyCount} healthy</Pill>
          <Pill tone={suggestionCount > 0 ? "accent" : "neutral"}>{suggestionCount} suggestions</Pill>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
      {items.length === 0 ? (
        <div className="empty">
          <div className="space-y-3">
            <p>No movies loaded yet. Refresh pulls titles from the Radarr connections in Settings.</p>
            <RefreshLibrary onDone={() => void load(true)} />
          </div>
        </div>
      ) : (
        <div className="table-card">
          <table className="dense">
            <thead>
              <tr>
                <th className="w-12">Poster</th>
                <th><button type="button" onClick={() => setSort("title")}>Title</button></th>
                <LibraryMediaHeaders onQuality={() => setSort("quality")} onSize={() => setSort("size")} />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} id={item.id}>
                  <td>
                    {item.hasPoster ? (
                      <img src={`/api/library/${item.id}/poster`} alt="" className="h-14 w-10 rounded-md object-cover ring-1 ring-white/10" />
                    ) : (
                      <div className="h-14 w-10 rounded-md bg-canvas ring-1 ring-ink/15" />
                    )}
                  </td>
                  <td className="min-w-44">
                    <Link className="font-medium text-ink hover:text-accent" to={item.href || `/movies/${item.id}`}>
                      {item.displayTitle}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted">{item.instanceName}</div>
                  </td>
                  <LibraryMediaCells
                    item={item}
                    onDone={() => void refreshLoaded()}
                    onHealth={(health) => {
                      setHealthyCount(health.healthyCount);
                      setSuggestionCount(health.suggestionCount);
                    }}
                    houseVideoTarget={houseVideoTarget}
                    av1Available={av1Available}
                  />
                </tr>
              ))}
            </tbody>
          </table>
          {nextOffset != null && (
            <div className="p-3 text-center">
              <button className="btn-secondary" type="button" disabled={loading} onClick={() => void load()}>
                {loading ? "Loading…" : "Load more movies"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
