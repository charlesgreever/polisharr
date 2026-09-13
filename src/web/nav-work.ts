import type { WorkSnapshot } from "./api";

export type { WorkNode, WorkNodeJob, WorkSnapshot } from "./api";

export function emptyWorkSnapshot(): WorkSnapshot {
  return {
    queueActive: 0,
    review: 0,
    suggestions: 0,
    movieSuggestions: 0,
    seriesSuggestions: 0,
    errors: 0,
    runningTitle: null,
    nodes: [],
  };
}

export function navCount(n: number): number | null {
  return n > 0 ? n : null;
}

export function navBadgeCount(to: string, work: WorkSnapshot): number | null {
  if (to === "/movies") return navCount(work.movieSuggestions);
  if (to === "/series") return navCount(work.seriesSuggestions);
  if (to === "/suggestions") return navCount(work.suggestions);
  if (to === "/queue") return navCount(work.queueActive);
  if (to === "/review") return navCount(work.review);
  if (to === "/errors") return navCount(work.errors);
  return null;
}

export function headerWorkLine(
  inspecting: boolean,
  pending: number,
  runningTitle: string | null,
  nodes: Array<{ name: string; running: number }> = [],
): string {
  if (inspecting) return `Inspecting · ${pending} left`;
  const busy = nodes.filter((node) => node.running > 0);
  const total = busy.reduce((sum, node) => sum + node.running, 0);
  if (total > 1) return `Working · ${busy.map((node) => `${node.running} on ${node.name}`).join(", ")}`;
  if (runningTitle) return `Working · ${runningTitle}`;
  return "● Ready";
}

export function nodeActivityLine(node: {
  online: boolean;
  enabled: boolean;
  running: number;
  concurrency: number;
  waiting: number;
  jobs: Array<{ title: string }>;
}): string {
  if (!node.online) return "Offline";
  if (!node.enabled) return "Drained";
  const slots = `${node.running} of ${node.concurrency}`;
  if (node.running <= 0) return "Idle";
  if (node.running >= node.concurrency && node.waiting > 0) return `${slots} · next job waiting`;
  const title = node.jobs[0]?.title;
  return title ? `${slots} · ${title}` : slots;
}
