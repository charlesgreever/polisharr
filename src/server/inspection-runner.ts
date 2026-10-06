import { access, stat } from "node:fs/promises";
import type { Store } from "./store.ts";
import type { InspectionReport, LibraryItem } from "./types.ts";
import { isIsoPath, isMediaFilePath, isoInspectionLooksStale, isoListingLooksUsable, parseFfmpegListing, parseFfprobe, referenceDurationSec, shouldConfirmMediaEnd, truncatedSourceReason, unlistedIsoReport } from "./inspect.ts";
import { isoInputAttempts, toolLocaleEnv } from "./optimize.ts";

export type InspectionRunnerOptions = {
  store: Store;
  ffmpeg: string;
  ffprobe: string;
  readable?: (path: string) => Promise<boolean>;
  probe?: (path: string, size: number) => Promise<Record<string, unknown>>;
  probeEnd?: (path: string) => Promise<number | null>;
  listIso?: (path: string, size: number) => Promise<string>;
  recomputeSuggestion: (itemId: string) => unknown;
};

export type ReinspectionResult =
  | { ok: true; report: InspectionReport }
  | { ok: false; warning: string; report?: undefined };

export function createInspectionRunner(opts: InspectionRunnerOptions) {
  let requestedVersion = 0;
  let completedVersion = 0;
  let walkPromise: Promise<void> | null = null;
  const priority = new Set<string>();

  function inspectPending(): Promise<void> {
    requestedVersion += 1;
    if (!walkPromise) walkPromise = drainWalks();
    return walkPromise;
  }

  async function drainWalks(): Promise<void> {
    try {
      while (completedVersion < requestedVersion) {
        const targetVersion = requestedVersion;
        await runInspectWalk();
        completedVersion = targetVersion;
      }
    } finally {
      walkPromise = null;
    }
  }

  async function runInspectWalk(): Promise<void> {
    try {
      await walkPending();
    } catch (error) {
      if (error instanceof Error && /not open/i.test(error.message)) return;
      throw error;
    }
  }

  async function walkPending(): Promise<void> {
    for (;;) {
      const items = opts.store.listItems();
      const pending = items
        .filter((item) => inspectStillOpen(item))
        .sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)));
      if (pending.length === 0) {
        publishInspect(false, 0, items.length);
        return;
      }
      publishInspect(true, pending.length, items.length);
      let remaining = pending.length;
      for (const item of pending) {
        remaining -= 1;
        publishInspect(true, remaining, items.length);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await inspectItem(item);
        priority.delete(item.id);
      }
      const leftover = leftoverCount();
      if (leftover === 0 || leftover >= pending.length) {
        publishInspect(false, leftover, opts.store.listItems().length);
        return;
      }
    }
  }

  function applyReport(item: LibraryItem, report: InspectionReport): void {
    opts.store.saveInspection(item.id, report);
    opts.store.clearFileErrorsForItem(item.id);
    opts.store.clearFileError(item.path);
    opts.recomputeSuggestion(item.id);
  }

  function siblingInspection(item: LibraryItem): InspectionReport | undefined {
    const sourceSig = `${item.path}|${item.sizeBytes}`;
    for (const sibling of opts.store.itemsForPath(item.path, item.instanceId)) {
      if (sibling.id === item.id || sibling.sizeBytes !== item.sizeBytes) continue;
      const report = opts.store.getInspection(sibling.id);
      if (report?.sourceSig === sourceSig) return report;
    }
    return undefined;
  }

  function applyReportToPathSiblings(item: LibraryItem, report: InspectionReport): void {
    for (const sibling of opts.store.itemsForPath(item.path, item.instanceId)) {
      if (sibling.id === item.id || sibling.sizeBytes !== item.sizeBytes) continue;
      applyReport(sibling, report);
    }
  }

  async function inspectItem(item: LibraryItem): Promise<ReinspectionResult> {
    if (!item.path) return { ok: false, warning: "This title has no file path to inspect." };
    const copied = siblingInspection(item);
    if (copied) {
      applyReport(item, copied);
      return { ok: true, report: copied };
    }
    let access: "ok" | "missing" | "denied";
    try {
      access = opts.readable
        ? (await opts.readable(item.path) ? "ok" : "denied")
        : await pathAccess(item.path);
    } catch (error) {
      const warning = error instanceof Error ? error.message : "The file path could not be checked.";
      if (!isIsoPath(item.path)) opts.store.setFileError(item.path, item.id, warning);
      return { ok: false, warning };
    }
    if (access === "missing") {
      return { ok: false, warning: "This title has no file yet." };
    }
    if (access === "denied") {
      const warning = "This path is not readable inside the container. Check the volume mount.";
      opts.store.setFileError(item.path, item.id, warning);
      return { ok: false, warning };
    }
    try {
      const probed = isIsoPath(item.path) ? null : (
        opts.probe
          ? await opts.probe(item.path, item.sizeBytes)
          : await defaultProbe(opts.ffprobe, item.path)
      );
      const report = probed
        ? parseFfprobe(item.path, item.sizeBytes, probed)
        : parseFfmpegListing(
            item.path,
            item.sizeBytes,
            opts.listIso
              ? await opts.listIso(item.path, item.sizeBytes)
              : await defaultIsoListing(opts.ffmpeg, item.path),
          );
      applyReport(item, report);
      applyReportToPathSiblings(item, report);
      const reason = probed ? await truncatedCopyReason(opts, item.path, item.sizeBytes, probed) : null;
      if (reason) {
        opts.store.setFileError(item.path, item.id, reason);
        opts.store.saveSuggestion(item.id, null);
        for (const sibling of opts.store.itemsForPath(item.path, item.instanceId)) {
          if (sibling.id !== item.id) opts.store.saveSuggestion(sibling.id, null);
        }
      }
      return { ok: true, report };
    } catch (error) {
      if (isIsoPath(item.path)) {
        const report = unlistedIsoReport(item.path, item.sizeBytes);
        applyReport(item, report);
        applyReportToPathSiblings(item, report);
        return { ok: true, report };
      }
      const warning = error instanceof Error ? error.message : "ffprobe failed.";
      opts.store.setFileError(item.path, item.id, warning);
      return { ok: false, warning };
    }
  }

  async function reinspectChangedItem(itemId: string, oldPath: string): Promise<ReinspectionResult> {
    const item = opts.store.getItem(itemId);
    if (!item) return { ok: false, warning: "The promoted title is no longer in the library." };
    opts.store.deleteInspection(itemId);
    opts.store.saveSuggestion(itemId, null);
    opts.store.clearFileError(oldPath);
    opts.store.clearFileError(item.path);
    priority.add(itemId);
    try {
      await inspectPending();
    } catch (error) {
      const warning = error instanceof Error ? error.message : "The promoted file could not be inspected.";
      opts.store.setFileError(item.path, item.id, warning);
      return { ok: false, warning };
    }
    const report = opts.store.getInspection(itemId);
    if (report?.sourceSig === `${item.path}|${item.sizeBytes}`) return { ok: true, report };
    const error = opts.store.listErrors().find((row) => row.itemId === itemId);
    return { ok: false, warning: error?.reason ?? "The promoted file could not be inspected." };
  }

  function inspectStillOpen(item: LibraryItem): boolean {
    if (!item.path) return false;
    if (!isMediaFilePath(item.path)) return false;
    if (isoInspectionLooksStale(opts.store.getInspection(item.id), item.path)) return true;
    if (opts.store.getInspectionSig(item.id) === `${item.path}|${item.sizeBytes}`) return false;
    return !opts.store.listErrors().some((error) => error.path === item.path);
  }

  function leftoverCount(): number {
    return opts.store.countInspectLeftovers();
  }

  function publishInspect(walking: boolean, pending: number, total: number): void {
    opts.store.setInspectState({
      walking,
      pending,
      inspected: Math.max(0, total - pending - opts.store.listErrors().length),
      failed: opts.store.listErrors().length,
    });
  }

  async function inspectOne(itemId: string): Promise<ReinspectionResult> {
    const item = opts.store.getItem(itemId);
    if (!item) return { ok: false, warning: "The title is no longer in the library." };
    return inspectItem(item);
  }

  return { inspectPending, inspectOne, reinspectChangedItem, leftoverCount };
}

async function pathAccess(path: string): Promise<"ok" | "missing" | "denied"> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return "missing";
    await access(path);
    return "ok";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return "missing";
    return "denied";
  }
}

async function truncatedCopyReason(
  opts: InspectionRunnerOptions,
  path: string,
  sizeBytes: number,
  probe: Record<string, unknown>,
): Promise<string | null> {
  if (!shouldConfirmMediaEnd(probe, sizeBytes)) return null;
  const playableSec = opts.probeEnd
    ? await opts.probeEnd(path)
    : await defaultPlayableEnd(opts.ffprobe, path);
  if (playableSec == null) return null;
  return truncatedSourceReason(referenceDurationSec(probe), playableSec);
}

async function defaultPlayableEnd(ffprobe: string, path: string): Promise<number | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(ffprobe, [
      "-v", "error",
      "-read_intervals", "999999%+#1",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time",
      "-of", "csv=p=0",
      path,
    ], { timeout: 20_000, maxBuffer: 64 * 1024, env: toolLocaleEnv() });
    const line = String(stdout).trim().split("\n").filter(Boolean).at(-1) ?? "";
    const pts = Number(line.split(",")[0]);
    return Number.isFinite(pts) && pts > 0 ? pts : null;
  } catch {
    // A seek that times out is not proof the file is whole. The encode still refuses a short source.
    return null;
  }
}

async function defaultProbe(ffprobe: string, path: string): Promise<Record<string, unknown>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run(ffprobe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path], {
    maxBuffer: 1024 * 512,
    env: toolLocaleEnv(),
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function defaultIsoListing(ffmpeg: string, path: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  let usable = "";
  for (const input of isoInputAttempts(path)) {
    const args = ["-hide_banner", "-threads", "1", "-analyzeduration", "20M", "-probesize", "20M", ...input];
    try {
      const { stdout, stderr } = await run(ffmpeg, args, { timeout: 12_000, maxBuffer: 1024 * 512, env: toolLocaleEnv() });
      const text = `${stderr}\n${stdout}`;
      if (isoListingLooksUsable(text)) {
        usable = text;
        break;
      }
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      const text = `${err.stderr ?? ""}\n${err.stdout ?? ""}`;
      if (isoListingLooksUsable(text)) {
        usable = text;
        break;
      }
    }
  }
  if (usable) return usable;
  throw new Error("ffmpeg could not list streams on this disc image.");
}
