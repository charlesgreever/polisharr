import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatSize, type ActivityOutcomes, type ActivityWeek, type HistoryRow, type HomePayload } from "../api";
import { Card } from "../components/Card";
import { PageHead } from "../components/Shell";
import { nodeActivityLine } from "../nav-work";
import { RefreshLibrary } from "../components/RefreshLibrary";
import { Pill, Tip } from "../components/ui";

const KEPT_TIP = "Counts after you Keep a sidecar or after a successful direct write.";
const STATUS_TIP = "The running title, how many jobs are waiting, or Idle.";
const OUTCOME_LABELS: Record<keyof ActivityOutcomes, string> = {
  kept: "Kept",
  discarded: "Discarded",
  flagged: "Flagged",
  failed: "Failed",
  cancelled: "Cancelled",
  searched: "Asked to search",
  removed: "Removed",
};

export function HomePage() {
  const [data, setData] = useState<HomePayload | null>(null);
  useEffect(() => {
    void api.home().then(setData);
  }, []);
  if (!data) return <p className="help">Loading dashboard…</p>;
  return <HomeDashboard data={data} onRefresh={() => void api.home().then(setData)} />;
}

export function HomeDashboard({ data, onRefresh }: { data: HomePayload; onRefresh?: () => void }) {
  const empty = data.filesOptimized === 0 && data.suggestions === 0 && data.recent.length === 0;
  return (
    <section className="space-y-5">
      <PageHead title="Home">
        <RefreshLibrary onDone={onRefresh} />
      </PageHead>
      <Card>
        <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted">
          Status
          <Tip label="Status">{STATUS_TIP}</Tip>
        </div>
        {data.nodes && data.nodes.length > 1 ? (
          <ul className="mt-2 space-y-1">
            {data.nodes.map((node) => (
              <li key={node.id} className="font-mono text-sm font-medium leading-6 text-ink">
                {node.name} · {nodeActivityLine(node)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 font-mono text-sm font-medium leading-6 text-ink">{data.status}</p>
        )}
      </Card>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted">
            Files optimized
            <Tip label="Files optimized">{KEPT_TIP}</Tip>
          </div>
          <p className="mt-2 font-mono text-2xl font-medium tabular-nums text-ink">{data.filesOptimized}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted">
            Space saved
            <Tip label="Space saved">{KEPT_TIP}</Tip>
          </div>
          <p className="mt-2 font-mono text-2xl font-medium tabular-nums text-ink">{formatSize(data.spaceSavedBytes)}</p>
        </Card>
      </div>
      <ActivityCard data={data} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <WorkStat label="Suggestions" value={data.suggestions} to="/suggestions" />
        <WorkStat label="Queue" value={data.queueActive ?? data.queued} to="/queue" />
        <WorkStat label="Review" value={data.review} to="/review" />
        <WorkStat label="Errors" value={data.errors} to="/errors" />
      </div>
      {empty && (
        <p className="help m-0">
          Nothing has been kept yet. Refresh the library to pull titles, then work Suggestions and Review.
        </p>
      )}
      <Card title="Recent activity" padded={data.recent.length === 0}>
        {data.recent.length === 0 ? (
          <p className="help m-0">No finished work yet.</p>
        ) : (
          <table className="dense">
            <thead>
              <tr>
                <th>Title</th>
                <th>Outcome</th>
                <th>Saved</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((row) => (
                <tr key={row.id}>
                  <td><ActivityTitle row={row} /></td>
                  <td><Pill tone={activityTone(row.outcome)}>{activityOutcomeLabel(row.outcome)}</Pill></td>
                  <td className="font-mono text-sm text-muted">{row.bytesSaved ? formatSize(row.bytesSaved) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

export function activityOutcomeLabel(outcome: HistoryRow["outcome"]): string {
  return OUTCOME_LABELS[outcome];
}

function activityTone(outcome: HistoryRow["outcome"]): "good" | "warn" | "bad" | "neutral" {
  if (outcome === "kept") return "good";
  if (outcome === "flagged") return "warn";
  if (outcome === "failed") return "bad";
  return "neutral";
}

function ActivityTitle({ row }: { row: HistoryRow }) {
  if (!row.href) return <span className="font-medium text-ink">{row.displayTitle}</span>;
  return <Link className="font-medium text-ink hover:text-accent" to={row.href}>{row.displayTitle}</Link>;
}

export function activityWindowIsEmpty(data: Pick<HomePayload, "savingsByWeek" | "outcomes">): boolean {
  return data.savingsByWeek.every((week) => week.bytesSaved === 0) && Object.values(data.outcomes).every((count) => count === 0);
}

function ActivityCard({ data }: { data: HomePayload }) {
  if (activityWindowIsEmpty(data)) {
    return <Card><p className="help m-0">Nothing kept in the last 12 weeks.</p></Card>;
  }
  const saved = data.savingsByWeek.some((week) => week.bytesSaved > 0);
  const outcomeRows = outcomeLegend(data.outcomes);
  return (
    <Card>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(12rem,0.8fr)]">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Space saved, last 12 weeks</h2>
          {saved ? <SavingsChart weeks={data.savingsByWeek} /> : <p className="help m-0 mt-3">No space saved in the last 12 weeks.</p>}
        </div>
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Outcomes, last 12 weeks</h2>
          <ul className="mt-3 space-y-2">
            {outcomeRows.map((row) => (
              <li key={row.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">{OUTCOME_LABELS[row.key]}</span>
                <span className="font-mono tabular-nums text-ink">{row.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function outcomeLegend(outcomes: ActivityOutcomes): Array<{ key: keyof ActivityOutcomes; count: number }> {
  const primary: Array<keyof ActivityOutcomes> = ["kept", "discarded", "failed"];
  const extra: Array<keyof ActivityOutcomes> = ["flagged", "cancelled", "searched", "removed"];
  return [
    ...primary.map((key) => ({ key, count: outcomes[key] })),
    ...extra.filter((key) => outcomes[key] > 0).map((key) => ({ key, count: outcomes[key] })),
  ];
}

export function weekLabel(weekStart: number): string {
  return new Date(weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function SavingsChart({ weeks }: { weeks: ActivityWeek[] }) {
  const captionId = useId();
  const width = 360;
  const height = 128;
  const gap = 6;
  const barWidth = (width - gap * (weeks.length - 1)) / weeks.length;
  const max = Math.max(...weeks.map((week) => week.bytesSaved), 1);
  return (
    <figure className="mt-3">
      <figcaption id={captionId} className="sr-only">
        {weeks.map((week) => `${weekLabel(week.weekStart)}: ${formatSize(week.bytesSaved)}, ${week.files} files`).join(". ")}
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-32 w-full" role="img" aria-labelledby={captionId}>
        {weeks.map((week, index) => {
          const barHeight = week.bytesSaved === 0 ? 0 : Math.max(3, (week.bytesSaved / max) * (height - 8));
          const x = index * (barWidth + gap);
          return (
            <rect
              key={week.weekStart}
              x={x}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx="2"
              fill="var(--accent)"
            />
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{weekLabel(weeks[0]?.weekStart ?? 0)}</span>
        <span>{weekLabel(weeks.at(-1)?.weekStart ?? 0)}</span>
      </div>
    </figure>
  );
}

function WorkStat({ label, value, to }: { label: string; value: number; to: string }) {
  return (
    <Link to={to} className="block rounded-2xl border border-gray-200 bg-white px-5 py-5 shadow-theme-sm hover:border-brand-300 dark:border-gray-800 dark:bg-white/[0.03]">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-2 font-mono text-xl font-medium tabular-nums text-gray-800 dark:text-white/90">{value}</div>
    </Link>
  );
}
