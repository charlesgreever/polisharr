import { copyFile, rename, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

export type PlaceMethod = "rename" | "clone" | "copy";

export type PlaceResult = {
  method: PlaceMethod;
};

export type PlaceDeps = {
  volumeId?: (path: string) => Promise<number | null>;
  rename?: (source: string, dest: string) => Promise<void>;
  clone?: (source: string, dest: string) => Promise<void>;
  copy?: (source: string, dest: string) => Promise<void>;
};

export const KEEP_RENAME_NOTE = "Keep can rename on this volume.";
export const KEEP_COPY_NOTE = "Keep will copy. Put the review folder on the same share as the library.";

export function placeMethodSentence(method: PlaceMethod): string {
  if (method === "rename") return "Renamed on the same volume.";
  if (method === "clone") return "Cloned on the volume.";
  return "Copied.";
}

export async function volumeId(path: string): Promise<number | null> {
  try {
    return (await stat(path)).dev;
  } catch {
    try {
      return (await stat(dirname(path))).dev;
    } catch {
      return null;
    }
  }
}

export async function sameVolume(left: string, right: string, id: (path: string) => Promise<number | null> = volumeId): Promise<boolean> {
  const a = await id(left);
  const b = await id(right);
  return a != null && b != null && a === b;
}

export async function describePlacement(
  reviewPath: string,
  libraryRoots: string[],
  id: (path: string) => Promise<number | null> = volumeId,
): Promise<{ sameVolume: boolean; note: string }> {
  if (!reviewPath.trim() || libraryRoots.length === 0) {
    return { sameVolume: false, note: KEEP_COPY_NOTE };
  }
  const review = await id(reviewPath);
  if (review == null) return { sameVolume: false, note: KEEP_COPY_NOTE };
  for (const root of libraryRoots) {
    const device = await id(root);
    if (device == null || device !== review) return { sameVolume: false, note: KEEP_COPY_NOTE };
  }
  return { sameVolume: true, note: KEEP_RENAME_NOTE };
}

export async function placeFile(source: string, dest: string, deps: PlaceDeps = {}): Promise<PlaceResult> {
  if (source === dest) return { method: "rename" };
  const id = deps.volumeId ?? volumeId;
  const move = deps.rename ?? rename;
  const clone = deps.clone ?? cloneFile;
  const copy = deps.copy ?? copyBytes;
  if (await sameVolume(source, dest, id)) {
    try {
      await move(source, dest);
      return { method: "rename" };
    } catch (error) {
      if (!isExdev(error)) throw error;
    }
  }
  try {
    await clone(source, dest);
    return { method: "clone" };
  } catch (error) {
    await unlink(dest).catch(() => undefined);
    if (isNoSpace(error)) throw error;
  }
  await copy(source, dest);
  return { method: "copy" };
}

async function cloneFile(source: string, dest: string): Promise<void> {
  await copyFile(source, dest, constants.COPYFILE_FICLONE_FORCE);
}

async function copyBytes(source: string, dest: string): Promise<void> {
  await copyFile(source, dest);
}

function isExdev(error: unknown): boolean {
  return errorCode(error) === "EXDEV";
}

function isNoSpace(error: unknown): boolean {
  return errorCode(error) === "ENOSPC";
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
