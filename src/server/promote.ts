import { access, copyFile, rename, unlink } from "node:fs/promises";
import { extname } from "node:path";
import { notifyPlayers } from "./notify.ts";
import type { ArrKind, ExecutablePlan, LibraryItem, PlayerKind } from "./types.ts";

export type PromoteInput = {
  item: LibraryItem;
  outputPath: string;
  sourceSize: number;
  outputSize: number;
  plan?: ExecutablePlan;
  decrypt: (packed: string) => string;
  fetch: typeof fetch;
  instance?: { kind: ArrKind | PlayerKind | string; url: string; secret: string | null } | null;
  players: Array<{ kind: "plex" | "jellyfin"; url: string; token: string }>;
};

export type PromoteResult = {
  replaced: boolean;
  destPath: string;
  savedBytes: number;
  warning: string | null;
  error: string | null;
};

export function stagedNewPath(destPath: string): string {
  return `${destPath}.opt-new`;
}

export function stagedBackupPath(destPath: string): string {
  return `${destPath}.opt-old`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function recoverStagedReplace(destPath: string): Promise<void> {
  const backup = stagedBackupPath(destPath);
  const staged = stagedNewPath(destPath);
  const destOk = await pathExists(destPath);
  const backupOk = await pathExists(backup);
  if (backupOk) {
    if (destOk) await unlink(destPath).catch(() => undefined);
    await rename(backup, destPath);
  }
  await unlink(staged).catch(() => undefined);
}

export async function clearStagedBackup(destPath: string): Promise<void> {
  if (!(await pathExists(destPath))) return;
  await unlink(stagedBackupPath(destPath)).catch(() => undefined);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function replaceLibraryFile(outputPath: string, destPath: string, originalPath = destPath): Promise<void> {
  // Move the original aside, then copy the sidecar onto dest. Do not write dest.opt-new
  // in the Arr library folder: a series refresh can pick that sibling up and the rename fails with ENOENT.
  const backup = stagedBackupPath(destPath);
  if (await pathExists(backup)) {
    throw new Error("A previous Keep is still being recovered for this library file.");
  }
  let destMoved = false;
  try {
    await rename(destPath, backup);
    destMoved = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await copyFile(outputPath, destPath);
  } catch (error) {
    if (destMoved) {
      await rename(backup, destPath).catch(() => undefined);
    }
    throw error;
  }
  await unlink(backup).catch(() => undefined);
  await unlink(stagedNewPath(destPath)).catch(() => undefined);
  if (outputPath !== destPath) await unlink(outputPath).catch(() => undefined);
  if (originalPath !== destPath) await unlink(originalPath).catch(() => undefined);
}

export function promotedPath(sourcePath: string, plan?: ExecutablePlan): string {
  if (!plan || plan.container !== "mkv") return sourcePath;
  if (extname(sourcePath).toLowerCase() === ".mkv") return sourcePath;
  return sourcePath.replace(/\.[^.]+$/, ".mkv");
}

export async function promote(input: PromoteInput): Promise<PromoteResult> {
  const destPath = promotedPath(input.item.path, input.plan);
  try {
    await replaceLibraryFile(input.outputPath, destPath, input.item.path);
  } catch (error) {
    return {
      replaced: false,
      destPath,
      savedBytes: 0,
      warning: null,
      error: error instanceof Error ? error.message : "Keep could not replace the library file.",
    };
  }
  const playerErrors = await notifyPlayers(input.players, input.fetch);
  const warning = playerErrors.length ? playerErrors.join(" ") : null;
  return {
    replaced: true,
    destPath,
    savedBytes: Math.max(0, input.sourceSize - input.outputSize),
    warning,
    error: null,
  };
}
