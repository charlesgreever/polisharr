import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { api, type InspectState, type SearchHit } from "../api";
import { inspectBannerView } from "../inspect-banner";
import { emptyWorkSnapshot, headerWorkLine, navBadgeCount } from "../nav-work";
import { buildReportIssueUrl, type ReportKind } from "../reportIssue";
import { Icons } from "./icons";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { to: "/", label: "Home", icon: Icons.home },
  { to: "/movies", label: "Movies", icon: Icons.movies },
  { to: "/series", label: "Series", icon: Icons.series },
  { to: "/suggestions", label: "Suggestions", icon: Icons.suggestions },
  { to: "/queue", label: "Queue", icon: Icons.queue },
  { to: "/review", label: "Review", icon: Icons.review },
  { to: "/errors", label: "Errors", icon: Icons.errors },
  { to: "/history", label: "History", icon: Icons.history },
  { to: "/settings", label: "Settings", icon: Icons.settings },
];

export function Shell({ children, version }: { children: React.ReactNode; version?: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [inspect, setInspect] = useState<InspectState | null>(null);
  const [work, setWork] = useState(emptyWorkSnapshot());
  const [dismissedFailed, setDismissedFailed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim()) void api.search(q).then((r) => setHits(r.items)).catch(() => setHits([]));
      else setHits([]);
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    void api.refresh().catch(() => undefined);
  }, []);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const [inspectState, workState] = await Promise.all([
          api.inspect(),
          api.work().catch(() => null),
        ]);
        setInspect(inspectState);
        if (workState) {
          setWork({
            queueActive: workState.queueActive,
            review: workState.review,
            suggestions: workState.suggestions,
            movieSuggestions: workState.movieSuggestions,
            seriesSuggestions: workState.seriesSuggestions,
            errors: workState.errors,
            runningTitle: workState.runningTitle,
            nodes: workState.nodes ?? [],
          });
        }
      } catch {
        /* still signed in later */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        menuBtnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const banner = inspectBannerView(inspect, dismissedFailed);
  const inspecting = banner.inspecting;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-gray-900/50 lg:hidden"
          aria-label="Close menu"
          onClick={() => {
            setSidebarOpen(false);
            menuBtnRef.current?.focus();
          }}
        />
      )}
      <aside
        className={`fixed top-0 left-0 z-50 flex h-screen w-72 flex-col border-r border-gray-200 bg-white duration-300 motion-reduce:transition-none lg:static lg:translate-x-0 dark:border-gray-800 dark:bg-gray-900 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-3 px-6 py-6">
          <b className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-semibold text-white">P</b>
          <div className="min-w-0">
            <strong className="block text-base font-semibold text-gray-800 dark:text-white/90">Polisharr</strong>
            {version && <span className="text-xs font-medium text-gray-400">{version}</span>}
          </div>
        </div>
        <nav className="flex flex-col gap-1 overflow-y-auto px-4 pb-6">
          <h2 className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-gray-400">Menu</h2>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                  isActive
                    ? "bg-brand-50 text-brand-500 dark:bg-brand-500/12 dark:text-brand-400"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-gray-300"
                }`
              }
            >
              {item.icon()}
              <span>{item.label}</span>
              {navBadgeCount(item.to, work) != null && (
                <span className="ml-auto rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium tabular-nums text-brand-500 dark:bg-brand-500/15 dark:text-brand-400">{navBadgeCount(item.to, work)}</span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 md:px-6 dark:border-gray-800 dark:bg-gray-900">
          <button
            ref={menuBtnRef}
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-200 text-gray-500 lg:hidden dark:border-gray-800 dark:text-gray-400"
            aria-label="Open menu"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            {Icons.menu()}
          </button>
          <div className="global-search min-w-0 flex-1">
            <label>
              {Icons.search()}
              <input
                placeholder="Search movies and episodes"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search movies and episodes"
              />
            </label>
            {hits.length > 0 && (
              <div className="search-results">
                {hits.map((hit) => (
                  <button
                    key={hit.itemId}
                    type="button"
                    onClick={() => {
                      navigate(hit.href);
                      setQ("");
                      setHits([]);
                      setSidebarOpen(false);
                    }}
                  >
                    {hit.displayTitle}
                    <span className="muted">{hit.instanceName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="hidden shrink-0 font-mono text-xs text-gray-500 dark:text-gray-400 sm:block">
            {headerWorkLine(inspecting, inspect?.pending ?? 0, work.runningTitle, work.nodes)}
          </div>
          <ThemeToggle />
          <ReportBug inspect={inspect} version={version} />
        </header>
        {inspecting && (
          <div className="inspect-banner mx-4 mt-4 md:mx-6">
            Movie and series lists are ready. Inspecting leftover files. {banner.pending} left.
            {banner.failed > 0 ? ` ${banner.failed} files could not be read.` : ""}
          </div>
        )}
        {banner.showFailed && (
          <div className="inspect-banner mx-4 mt-4 flex flex-wrap items-center justify-between gap-2 md:mx-6">
            <span>
              {banner.failed} files could not be probed.{" "}
              <Link className="font-medium text-brand-500 hover:text-brand-600" to="/errors">Open Errors</Link>
            </span>
            <button className="btn-secondary" type="button" onClick={() => setDismissedFailed(true)}>
              Dismiss
            </button>
          </div>
        )}
        <main className="mx-auto w-full max-w-screen-2xl p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

function ReportBug({ inspect, version }: { inspect: InspectState | null; version?: string }) {
  const location = useLocation();
  const [busy, setBusy] = useState(false);

  async function report(kind: ReportKind) {
    setBusy(true);
    try {
      const jobs = await api.jobs();
      const running = jobs.items.find((job) => job.status === "running") ?? null;
      window.open(
        buildReportIssueUrl(kind, { route: location.pathname, inspect, running, version }),
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button className="btn-secondary" type="button" onClick={() => void report("bug")} disabled={busy}>
        Bug
      </button>
      <button className="btn-secondary hidden sm:inline-flex" type="button" onClick={() => void report("change")} disabled={busy}>
        Change request
      </button>
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">POLISHARR</p>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function Help({ children }: { children: string }) {
  return (
    <p className="help flex items-start gap-2">
      <span className="mt-0.5">{Icons.help()}</span>
      <span>{children}</span>
    </p>
  );
}
