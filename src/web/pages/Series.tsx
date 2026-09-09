import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ClusterNode, type LibraryRow, type SeriesSummary } from "../api";
import { EncodeNodeSelect } from "../components/EncodeNodeSelect";
import { Help, PageHead } from "../components/Shell";
import { RefreshLibrary } from "../components/RefreshLibrary";
import { AudioMixSelect } from "../components/AudioMixSelect";
import { EncodeTargetSelect } from "../components/EncodeTargetSelect";
import { LibraryMediaCells, LibraryMediaHeaders } from "../components/LibraryMediaCells";
import { Pill } from "../components/ui";
import { loadRetainedPages, mergePage, needsFocusedPage } from "../library-pages";

export function SeriesPage() {
  const [summaries, setSummaries] = useState<SeriesSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [msg, setMsg] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [houseVideoTarget, setHouseVideoTarget] = useState<"hevc" | "av1">("hevc");
  const [av1Available, setAv1Available] = useState(false);
  const [nodes, setNodes] = useState<ClusterNode[]>([]);
  const [defaultNodeId, setDefaultNodeId] = useState("");
  const [encodeNodeId, setEncodeNodeId] = useState("");
  const loadingRef = useRef(false);
  const pendingResetRef = useRef(false);
  const [searchParams] = useSearchParams();
  const focus = searchParams.get("focus");

  async function load(reset = false) {
    if (loadingRef.current) {
      if (reset) pendingResetRef.current = true;
      return;
    }
    const offset = reset ? 0 : nextOffset;
    if (offset == null) return;
    loadingRef.current = true;
    setMsg("");
    try {
      const page = await api.series(offset);
      setSummaries((current) => reset ? page.items : mergePage(current, page.items));
      setNextOffset(page.nextOffset);
    } catch (cause) {
      setMsg(cause instanceof Error ? cause.message : "Series could not be loaded.");
    } finally {
      loadingRef.current = false;
      if (pendingResetRef.current) {
        pendingResetRef.current = false;
        void load(true);
      }
    }
  }

  useEffect(() => {
    void load(true);
    void api.settings().then((settings) => {
      setHouseVideoTarget(settings.videoTarget === "av1" ? "av1" : "hevc");
    }).catch(() => undefined);
    void api.nodes().then((payload) => {
      setAv1Available(Boolean(payload.av1Available));
      setNodes(payload.nodes);
      setDefaultNodeId(payload.defaultEncodeNodeId);
      setEncodeNodeId((current) => current || payload.defaultEncodeNodeId);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!focus) {
      setFocusKey(null);
      return;
    }
    void api.title(focus).then(({ item }) => {
      if (item.type === "episode" && item.arrSeriesId != null) {
        setFocusKey(`${item.instanceId}:${item.arrSeriesId}`);
      }
    }).catch(() => setFocusKey(null));
  }, [focus]);

  useEffect(() => {
    if (focusKey && !summaries.some((summary) => summary.key === focusKey) && nextOffset != null) {
      void load();
    }
  }, [focusKey, summaries, nextOffset]);

  function refreshed() {
    setRefreshVersion((version) => version + 1);
    void load(true);
  }

  return (
    <section>
      <PageHead title="Series">
        <RefreshLibrary onDone={refreshed} />
      </PageHead>
      <Help>Series loads show headers first. Expand one show to load its episodes. Encode target on a show chooses HEVC or AV1 for automatic Suggestions on every episode, including later imports. Prefer stereo replaces surround with AAC stereo and drops the original mix, which is useful for kids TVs. Keep surround turns that off. House default follows Settings, which adds stereo for Atmos and keeps the original mix. Each header shows how many episodes are healthy and how many still have suggestions. Exempt on an episode keeps that file off the size cap so Polisharr only offers language cleanup and stereo. Optimize all episodes queues that show without expanding it.</Help>
      {summaries.length === 0 ? (
        <div className="empty">
          <div className="space-y-3">
            <p>No series loaded yet. Refresh pulls episodes from the Sonarr connections in Settings.</p>
            <RefreshLibrary onDone={refreshed} />
          </div>
        </div>
      ) : (
        summaries.map((summary) => (
          <SeriesGroup
            key={summary.key}
            summary={summary}
            focusId={focusKey === summary.key ? focus : null}
            refreshVersion={refreshVersion}
            houseVideoTarget={houseVideoTarget}
            av1Available={av1Available}
            nodes={nodes}
            defaultNodeId={defaultNodeId}
            encodeNodeId={encodeNodeId}
            onEncodeNodeChange={setEncodeNodeId}
            onMsg={setMsg}
            onPatch={(patch) => {
              setSummaries((current) => current.map((row) => (
                row.key === summary.key ? { ...row, ...patch } : row
              )));
            }}
          />
        ))
      )}
      {nextOffset != null && (
        <div className="mt-4 text-center">
          <button className="btn-secondary" type="button" onClick={() => void load()}>
            Load more shows
          </button>
        </div>
      )}
      {msg && <p className="mt-3 text-sm text-muted">{msg}</p>}
    </section>
  );
}

function SeriesGroup({
  summary,
  focusId,
  refreshVersion,
  houseVideoTarget,
  av1Available,
  nodes,
  defaultNodeId,
  encodeNodeId,
  onEncodeNodeChange,
  onMsg,
  onPatch,
}: {
  summary: SeriesSummary;
  focusId: string | null;
  refreshVersion: number;
  houseVideoTarget: "hevc" | "av1";
  av1Available: boolean;
  nodes: ClusterNode[];
  defaultNodeId: string;
  encodeNodeId: string;
  onEncodeNodeChange: (nodeId: string) => void;
  onMsg: (msg: string) => void;
  onPatch: (patch: Partial<SeriesSummary>) => void;
}) {
  const [open, setOpen] = useState(Boolean(focusId));
  const [episodes, setEpisodes] = useState<LibraryRow[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const loadedRefreshRef = useRef(refreshVersion);
  const pendingRefreshResetRef = useRef(false);
  const pendingRetainRef = useRef(false);
  const episodesRef = useRef<LibraryRow[]>([]);
  episodesRef.current = episodes;

  async function loadEpisodes(reset = false) {
    if (loadingRef.current) {
      if (reset) pendingRefreshResetRef.current = true;
      return;
    }
    const offset = reset ? 0 : nextOffset;
    if (offset == null) return;
    loadingRef.current = true;
    const requestedRefresh = loadedRefreshRef.current;
    setError("");
    try {
      const page = await api.seriesEpisodes(summary.instanceId, summary.arrSeriesId, offset);
      if (requestedRefresh === loadedRefreshRef.current) {
        setEpisodes((current) => {
          const next = reset ? page.items : mergePage(current, page.items);
          episodesRef.current = next;
          return next;
        });
        setNextOffset(page.nextOffset);
      }
    } catch (cause) {
      if (requestedRefresh === loadedRefreshRef.current) {
        setError(cause instanceof Error ? cause.message : "Episodes could not be loaded.");
      }
    } finally {
      loadingRef.current = false;
      if (pendingRefreshResetRef.current) {
        pendingRefreshResetRef.current = false;
        pendingRetainRef.current = false;
        void loadEpisodes(true);
      } else if (pendingRetainRef.current) {
        pendingRetainRef.current = false;
        void refreshLoaded();
      }
    }
  }

  async function refreshLoaded() {
    if (loadingRef.current) {
      pendingRetainRef.current = true;
      return;
    }
    const loadedCount = Math.max(episodesRef.current.length, 1);
    loadingRef.current = true;
    const requestedRefresh = loadedRefreshRef.current;
    setError("");
    try {
      const page = await loadRetainedPages(
        (offset) => api.seriesEpisodes(summary.instanceId, summary.arrSeriesId, offset),
        loadedCount,
      );
      if (requestedRefresh === loadedRefreshRef.current) {
        episodesRef.current = page.items;
        setEpisodes(page.items);
        setNextOffset(page.nextOffset);
      }
    } catch (cause) {
      if (requestedRefresh === loadedRefreshRef.current) {
        setError(cause instanceof Error ? cause.message : "Episodes could not be loaded.");
      }
    } finally {
      loadingRef.current = false;
      if (pendingRefreshResetRef.current) {
        pendingRefreshResetRef.current = false;
        pendingRetainRef.current = false;
        void loadEpisodes(true);
      } else if (pendingRetainRef.current) {
        pendingRetainRef.current = false;
        void refreshLoaded();
      }
    }
  }

  useEffect(() => {
    if (!focusId) return;
    setOpen(true);
    void loadEpisodes(true);
  }, [focusId]);

  useEffect(() => {
    if (open && needsFocusedPage(focusId, episodes, nextOffset)) void loadEpisodes();
  }, [focusId, open, episodes, nextOffset]);

  useEffect(() => {
    if (loadedRefreshRef.current === refreshVersion) return;
    loadedRefreshRef.current = refreshVersion;
    setEpisodes([]);
    setNextOffset(0);
    setError("");
    if (!open) return;
    if (loadingRef.current) pendingRefreshResetRef.current = true;
    else void loadEpisodes(true);
  }, [refreshVersion]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && episodes.length === 0) void loadEpisodes(true);
  }

  return (
    <div className="glass series-block mt-5">
      <div className="series-head">
        <button type="button" className="series-toggle" aria-expanded={open} onClick={toggle}>
          <span className="series-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span>
            <span className="series-title">{summary.showTitle}</span>
            <span className="series-meta">
              <span>{summary.instanceName} · {summary.episodeCount} episodes</span>
              <span className="mt-1 flex flex-wrap gap-1">
                <Pill tone="good">{summary.healthyCount} healthy</Pill>
                <Pill tone={summary.suggestionCount > 0 ? "accent" : "neutral"}>{summary.suggestionCount} suggestions</Pill>
              </span>
            </span>
          </span>
        </button>
        <button className="btn-secondary" type="button" onClick={toggle}>
          {open ? "Collapse" : "Expand"}
        </button>
        <EncodeTargetSelect
          value={summary.videoTarget ?? null}
          houseTarget={houseVideoTarget}
          av1Available={av1Available}
          onChange={(videoTarget) => {
            void api.setSeriesVideoTarget(summary.instanceId, summary.arrSeriesId, videoTarget).then((result) => {
              onPatch({
                videoTarget,
                healthyCount: result.healthyCount,
                suggestionCount: result.suggestionCount,
              });
              onMsg("Encode target saved.");
              if (open) void refreshLoaded();
            }).catch((cause: Error) => onMsg(cause.message));
          }}
        />
        <AudioMixSelect
          value={summary.audioMix ?? null}
          onChange={(audioMix) => {
            void api.setSeriesAudioMix(summary.instanceId, summary.arrSeriesId, audioMix).then((result) => {
              onPatch({
                audioMix,
                healthyCount: result.healthyCount,
                suggestionCount: result.suggestionCount,
              });
              onMsg("Preferred audio saved.");
              if (open) void refreshLoaded();
            }).catch((cause: Error) => onMsg(cause.message));
          }}
        />
        <EncodeNodeSelect
          nodes={nodes}
          value={encodeNodeId}
          defaultNodeId={defaultNodeId}
          need={summary.videoTarget === "av1" || (!summary.videoTarget && houseVideoTarget === "av1") ? "av1" : "hevc"}
          onChange={onEncodeNodeChange}
        />
        <button
          className="btn whitespace-nowrap"
          type="button"
          onClick={() => {
            void api.optimizeShow(summary.instanceId, summary.arrSeriesId, encodeNodeId || undefined).then((result) => {
              const counts = result as { queued: number; skipped: number };
              onMsg(`Queued ${counts.queued}. Skipped ${counts.skipped}.`);
              if (open) void refreshLoaded();
            }).catch((cause: Error) => onMsg(cause.message));
          }}
        >
          Optimize all episodes
        </button>
      </div>
      {open && (
        <div className="series-table-wrap">
          {error && (
            <div className="p-3 text-sm text-rose-400">
              {error} <button className="btn-secondary ml-2" type="button" onClick={() => void loadEpisodes(true)}>Retry</button>
            </div>
          )}
          <table className="dense">
            <thead>
              <tr>
                <th>Episode</th>
                <LibraryMediaHeaders />
              </tr>
            </thead>
            <tbody>
              {episodes.map((item) => (
                <tr key={item.id} id={item.id}>
                  <td className="min-w-52">
                    <Link className="font-medium leading-snug text-ink hover:text-accent" to={item.href || `/series/episodes/${item.id}`}>
                      {item.displayTitle}
                    </Link>
                    {item.sharedFileLabel ? (
                      <div className="mt-1">
                        <Pill>{item.sharedFileLabel}</Pill>
                      </div>
                    ) : null}
                  </td>
                  <LibraryMediaCells item={item} onDone={() => void refreshLoaded()} />
                </tr>
              ))}
            </tbody>
          </table>
          {episodes.length === 0 && !error && <div className="p-3 text-sm text-muted">Loading episodes…</div>}
          {nextOffset != null && episodes.length > 0 && (
            <div className="p-3 text-center">
              <button className="btn-secondary" type="button" onClick={() => void loadEpisodes()}>Load more episodes</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
