import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  KEEP_COPY_NOTE,
  KEEP_RENAME_NOTE,
  describePlacement,
  placeFile,
  placeMethodSentence,
  sameVolume,
} from "./fs-copy.ts";

describe("volume probe", () => {
  it("treats two folders in the same temp tree as one volume", async () => {
    const root = mkdtempSync(join(tmpdir(), "opt-vol-"));
    const review = join(root, "review");
    const movies = join(root, "Movies");
    mkdirSync(review);
    mkdirSync(movies);
    expect(await sameVolume(review, movies)).toBe(true);
    expect(await describePlacement(review, [movies])).toEqual({ sameVolume: true, note: KEEP_RENAME_NOTE });
  });

  it("does not claim rename when a library root is on another device", async () => {
    const ids = new Map<string, number>([
      ["/mnt/nas/review-path", 10],
      ["/mnt/nas/Movies", 10],
      ["/mnt/usb", 99],
    ]);
    const id = async (path: string) => ids.get(path) ?? null;
    expect(await describePlacement("/mnt/nas/review-path", ["/mnt/nas/Movies"], id)).toEqual({
      sameVolume: true,
      note: KEEP_RENAME_NOTE,
    });
    expect(await describePlacement("/mnt/nas/review-path", ["/mnt/nas/Movies", "/mnt/usb"], id)).toEqual({
      sameVolume: false,
      note: KEEP_COPY_NOTE,
    });
    expect(await describePlacement("/mnt/nas/review-path", [], id)).toEqual({
      sameVolume: false,
      note: KEEP_COPY_NOTE,
    });
  });
});

describe("placeFile ladder", () => {
  it("renames on the same volume instead of copying bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "opt-place-"));
    const review = join(root, "review");
    const library = join(root, "Movies");
    mkdirSync(review);
    mkdirSync(library);
    const sidecar = join(review, "title.mkv");
    const dest = join(library, "title.mkv");
    writeFileSync(sidecar, "SIDECAR");
    writeFileSync(dest, "ORIGINAL");
    const copy = vi.fn(async () => {
      throw new Error("copy should not run on the same volume");
    });
    const result = await placeFile(sidecar, dest, { copy, clone: copy });
    expect(result.method).toBe("rename");
    expect(readFileSync(dest, "utf8")).toBe("SIDECAR");
    expect(copy).not.toHaveBeenCalled();
  });

  it("falls back to copy when rename is a cross-device move", async () => {
    const root = mkdtempSync(join(tmpdir(), "opt-exdev-"));
    const sidecar = join(root, "sidecar.mkv");
    const dest = join(root, "dest.mkv");
    writeFileSync(sidecar, "SIDECAR");
    const clone = vi.fn(async () => {
      const error = new Error("no clone") as NodeJS.ErrnoException;
      error.code = "ENOTSUP";
      throw error;
    });
    const copy = vi.fn(async (source: string, target: string) => {
      writeFileSync(target, readFileSync(source));
    });
    const result = await placeFile(sidecar, dest, {
      volumeId: async (path) => (path.includes("sidecar") ? 1 : 2),
      rename: async () => {
        const error = new Error("cross device") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      },
      clone,
      copy,
    });
    expect(result.method).toBe("copy");
    expect(copy).toHaveBeenCalledOnce();
    expect(placeMethodSentence("copy")).toBe("Copied.");
    expect(placeMethodSentence("rename")).toBe("Renamed on the same volume.");
    expect(placeMethodSentence("clone")).toBe("Cloned on the volume.");
  });

  it("records clone when the forced reflink succeeds", async () => {
    const clone = vi.fn(async () => undefined);
    const copy = vi.fn(async () => {
      throw new Error("copy should not run after clone");
    });
    const result = await placeFile("/review/a.mkv", "/lib/a.mkv", {
      volumeId: async () => 1,
      rename: async () => {
        const error = new Error("cross device") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      },
      clone,
      copy,
    });
    expect(result.method).toBe("clone");
    expect(clone).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
  });
});
