import { statSync } from "node:fs";
import type { PlaybackFileRevision } from "./types.ts";

export function canonicalFilePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const slashes = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return slashes || "/";
}

export function filePathsEqual(left: string, right: string): boolean {
  const a = canonicalFilePath(left);
  const b = canonicalFilePath(right);
  if (!a || !b) return false;
  if (process.platform === "win32" || process.platform === "darwin") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function readFileRevision(path: string): PlaybackFileRevision {
  const canonicalPath = canonicalFilePath(path);
  try {
    const info = statSync(path);
    return {
      canonicalPath,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      fileId: `${info.dev}:${info.ino}`,
    };
  } catch {
    return { canonicalPath, sizeBytes: null, mtimeMs: null, fileId: null };
  }
}

export function parseFileRevision(value: unknown): PlaybackFileRevision | null {
  if (value == null) return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const canonicalPath = typeof row.canonicalPath === "string" ? row.canonicalPath : "";
  if (!canonicalPath) return null;
  return {
    canonicalPath,
    sizeBytes: typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes) ? row.sizeBytes : null,
    mtimeMs: typeof row.mtimeMs === "number" && Number.isFinite(row.mtimeMs) ? row.mtimeMs : null,
    fileId: typeof row.fileId === "string" && row.fileId ? row.fileId : null,
  };
}

export function isTrustedRevision(revision: PlaybackFileRevision | null | undefined): revision is PlaybackFileRevision {
  return Boolean(revision?.canonicalPath) && revision?.sizeBytes != null && revision.mtimeMs != null;
}

export function revisionsMatch(
  left: PlaybackFileRevision | null | undefined,
  right: PlaybackFileRevision | null | undefined,
): boolean {
  if (!isTrustedRevision(left) || !isTrustedRevision(right) || !left || !right) return false;
  if (!filePathsEqual(left.canonicalPath, right.canonicalPath)) return false;
  if (left.sizeBytes !== right.sizeBytes) return false;
  if (left.mtimeMs !== right.mtimeMs) return false;
  if (left.fileId && right.fileId && left.fileId !== right.fileId) return false;
  return true;
}
