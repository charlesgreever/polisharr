import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ClusterNode, type JobRow } from "../api";
import { EncodeNodeSelect } from "../components/EncodeNodeSelect";
import { encodeNeedFromPlan } from "../encode-node";
import { Card } from "../components/Card";
import { PagedListControls } from "../components/PagedListControls";
import { Help, PageHead } from "../components/Shell";
import { usePagedList } from "../use-paged-list";

export const WORKING_NOW_HEADING = "Working now";
export const WAITING_HEADING = "Waiting";
export const FINISHED_HEADING = "Finished";

export function queueNodeLine(job: { assignedNodeName?: string | null; waitingForNode?: boolean; status: string }): string | null {
  if (!job.assignedNodeName) return null;
  if (job.waitingForNode) return `Waiting for ${job.assignedNodeName}`;
  if (job.status === "running") return `On ${job.assignedNodeName}`;
  return `On ${job.assignedNodeName}`;
}

export function partitionQueueJobs<T extends { status: string }>(items: T[]): {
  working: T[];
  waiting: T[];
  finished: T[];
} {
  const working: T[] = [];
  const waiting: T[] = [];
  const finished: T[] = [];
  for (const job of items) {
    if (job.status === "running") working.push(job);
    else if (job.status === "queued" || job.status === "held" || job.status === "paused") waiting.push(job);
    else finished.push(job);
  }
  return { working, waiting, finished };
}

export function queueToolbar(input: { activeCount: number; finishedCount: number }): { cancelAll: boolean; clearFinished: boolean } {
  return { cancelAll: input.activeCount > 0, clearFinished: input.finishedCount > 0 };
}

export function queueVisibleHeadings(items: Array<{ status: string }>): string[] {
  const groups = partitionQueueJobs(items);
  return [
    groups.working.length > 0 ? WORKING_NOW_HEADING : null,
    groups.waiting.length > 0 ? WAITING_HEADING : null,
    groups.finished.length > 0 ? FINISHED_HEADING : null,
  ].filter((heading): heading is string => heading !== null);
}

export function QueuePage() {
  const list = usePagedList({ loadPage: api.jobs, keyOf: (row: JobRow) => row.id, pollMs: 1000 });
  const items = list.items;
  const [nodes, setNodes] = useState<ClusterNode[]>([]);
  const [defaultNodeId, setDefaultNodeId] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  useEffect(() => {
    void api.nodes().then((payload) => {
      setNodes(payload.nodes);
      setDefaultNodeId(payload.defaultEncodeNodeId);
    }).catch(() => undefined);
  }, []);
  const { working, waiting, finished } = partitionQueueJobs(items);
  const waitingIds = waiting.map((job) => job.id);
  const finishedCount = Math.max(list.finishedCount, finished.length);
  const toolbar = queueToolbar({
    activeCount: working.length + waiting.length,
    finishedCount,
  });

  async function moveJob(id: string, delta: number) {
    const index = waitingIds.indexOf(id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= waitingIds.length) return;
    const ids = [...waitingIds];
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(next, 0, moved);
    await mutate(() => api.reorderJobs(ids));
  }

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setMutationError("");
    try {
      await action();
      await list.reload();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Queue could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  const actions = {
    busy,
    waitingIds,
    logs,
    nodes,
    defaultNodeId,
    onMove: moveJob,
    onMutate: mutate,
    onReload: list.reload,
    onLogs: (id: string, log: string) => setLogs((current) => ({ ...current, [id]: log })),
  };

  return (
    <section>
      <PageHead title="Queue" />
      <Help>
        Working now is the job that is running. Waiting jobs run next; pause, resume, or reorder them. Finished jobs stay until you remove them. Open a title for the same media page as Movies and Series. Progress is elapsed media time, updated about once a second. Cancel never replaces the library file. A sidecar waits in Review; direct write replaces the library file after an integrity check.
      </Help>
      <div className="mt-3 flex flex-wrap gap-2">
        {toolbar.cancelAll && (
          <button className="btn-secondary" type="button" disabled={busy} onClick={() => void mutate(api.cancelAll)}>
            Cancel all
          </button>
        )}
        {toolbar.clearFinished && (
          <button className="btn-secondary" type="button" disabled={busy} onClick={() => void mutate(api.clearFinishedJobs)}>
            Clear finished
          </button>
        )}
      </div>
      {mutationError && <p className="mt-3 text-sm text-rose-400">{mutationError}</p>}
      {items.length === 0 && list.loading && <div className="empty">Loading queue…</div>}
      {items.length === 0 && !list.loading && !list.error && <div className="empty">The queue is idle. Approve a suggestion to add work.</div>}
      {working.length > 0 && (
        <div className="mt-5 space-y-3">
          <h2 className="text-base font-semibold text-ink">{WORKING_NOW_HEADING}</h2>
          {working.map((job) => (
            <WorkingNowCard key={job.id} job={job} actions={actions} />
          ))}
        </div>
      )}
      {waiting.length > 0 && (
        <QueueTable heading={WAITING_HEADING} jobs={waiting} actions={actions} kind="waiting" />
      )}
      {finished.length > 0 && (
        <QueueTable heading={FINISHED_HEADING} jobs={finished} actions={actions} kind="finished" />
      )}
      <PagedListControls loading={list.loading} error={list.error} nextOffset={list.nextOffset} noun="jobs" onLoadMore={list.loadMore} onRetry={list.reload} />
    </section>
  );
}

type JobActions = {
  busy: boolean;
  waitingIds: string[];
  logs: Record<string, string>;
  nodes: ClusterNode[];
  defaultNodeId: string;
  onMove: (id: string, delta: number) => Promise<void>;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
  onReload: () => Promise<void>;
  onLogs: (id: string, log: string) => void;
};

function WorkingNowCard({ job, actions }: { job: JobRow; actions: JobActions }) {
  const nodeLine = queueNodeLine(job);
  return (
    <Card
      title={<JobTitle job={job} />}
      actions={<JobButtons job={job} actions={actions} kind="working" />}
    >
      <p className="m-0 text-sm text-muted">{phaseLabel(job.phase, job.status)}</p>
      {nodeLine && <p className="mt-1 text-sm text-muted">{nodeLine}</p>}
      <p className="mt-1 text-sm text-muted">{planLabel(job)}</p>
      <div className="job-progress mt-3">
        <div className="job-progress-bar" style={{ width: `${Math.max(1, Math.round(job.progress * 100))}%` }} />
        <span>{Math.round(job.progress * 100)}%</span>
      </div>
      <JobNotes job={job} log={actions.logs[job.id]} />
    </Card>
  );
}

function QueueTable({
  heading,
  jobs,
  actions,
  kind,
}: {
  heading: string;
  jobs: JobRow[];
  actions: JobActions;
  kind: "waiting" | "finished";
}) {
  return (
    <div className="mt-5">
      <h2 className="text-base font-semibold text-ink">{heading}</h2>
      <div className="table-card mt-3">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Plan</th>
              {kind === "waiting" && <th>Phase</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td className="min-w-44">
                  <JobTitle job={job} />
                </td>
                <td>{job.waitingForNode && job.assignedNodeName ? `Waiting for ${job.assignedNodeName}` : job.status}</td>
                <td>{planLabel(job)}</td>
                {kind === "waiting" && <td>{phaseLabel(job.phase, job.status)}</td>}
                <td>
                  <JobButtons job={job} actions={actions} kind={kind} />
                  <JobNotes job={job} log={actions.logs[job.id]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JobTitle({ job }: { job: JobRow }) {
  if (job.href) {
    return (
      <Link className="font-medium text-ink hover:text-accent" to={job.href}>
        {job.displayTitle}
      </Link>
    );
  }
  return <span className="font-medium text-ink">{job.displayTitle}</span>;
}

function JobButtons({ job, actions, kind }: { job: JobRow; actions: JobActions; kind: "working" | "waiting" | "finished" }) {
  return (
    <>
      {kind === "waiting" && (job.status === "queued" || job.status === "held") && (
        <button className="btn-secondary ml-1" type="button" onClick={() => void actions.onMutate(() => api.pauseJob(job.id))}>
          Pause
        </button>
      )}
      {kind === "waiting" && job.status === "paused" && (
        <button className="btn ml-1" type="button" onClick={() => void actions.onMutate(() => api.resumeJob(job.id))}>
          Resume
        </button>
      )}
      {kind === "waiting" && (
        <>
          <button className="btn-secondary ml-1" type="button" disabled={actions.waitingIds.indexOf(job.id) <= 0} onClick={() => void actions.onMove(job.id, -1)}>
            Up
          </button>
          <button className="btn-secondary ml-1" type="button" disabled={actions.waitingIds.indexOf(job.id) === actions.waitingIds.length - 1} onClick={() => void actions.onMove(job.id, 1)}>
            Down
          </button>
        </>
      )}
      {kind !== "finished" && (
        <button className="btn-secondary" type="button" onClick={() => void api.cancel(job.id).then(actions.onReload)}>
          Cancel
        </button>
      )}
      {kind === "waiting" && (
        <span className="ml-1 inline-block min-w-[10rem] align-middle">
          <EncodeNodeSelect
            nodes={actions.nodes}
            value={job.assignedNodeId ?? actions.defaultNodeId}
            defaultNodeId={actions.defaultNodeId}
            need={encodeNeedFromPlan(job.plan)}
            disabled={actions.busy}
            onChange={(nodeId) => void actions.onMutate(() => api.assignJob(job.id, nodeId))}
          />
        </span>
      )}
      {kind === "waiting" && job.status === "held" && (
        <button className="btn ml-1" type="button" onClick={() => void api.runNow(job.id).then(actions.onReload)}>
          Run now
        </button>
      )}
      <button className="btn-secondary ml-1" type="button" onClick={() => void api.jobLogs(job.id).then((result) => actions.onLogs(job.id, result.log || "(empty)"))}>
        Logs
      </button>
      {kind === "finished" && (
        <button className="btn-secondary ml-1" type="button" disabled={actions.busy} onClick={() => void actions.onMutate(() => api.removeJob(job.id))}>
          Remove
        </button>
      )}
    </>
  );
}

function JobNotes({ job, log }: { job: JobRow; log?: string }) {
  return (
    <>
      {job.error && <div className="text-xs text-rose-400">{job.error}</div>}
      {job.warning && <div className="text-xs text-amber-300">{job.warning}</div>}
      {job.promoteError && <div className="text-xs text-amber-300">{job.promoteError}</div>}
      {log != null && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted">{log}</pre>}
    </>
  );
}

function planLabel(job: JobRow): string {
  const mode = job.plan?.video?.kind;
  const write = job.writeMode ?? job.plan?.writeMode ?? "sidecar";
  const aim = mode === "size" ? "target size" : mode === "quality" ? "encoder quality" : "copy / remux";
  return `${aim} · ${write === "direct" ? "direct write" : "sidecar"}`;
}

function phaseLabel(phase: string, status: string): string {
  if (status === "held") return "Waiting for the off-peak window";
  if (status === "queued") return "Waiting for a slot";
  if (phase === "muxing") return "Muxing tracks";
  if (phase === "creating_stereo") return "Creating stereo audio";
  if (phase === "transcoding") return "Transcoding video";
  if (phase === "finishing") return "Checking the finished file";
  return status;
}
