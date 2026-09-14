import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JobService } from "./jobs.ts";
import { stagedBackupPath, stagedNewPath } from "./promote.ts";
import { KEEP_INTERRUPTED, SIDECAR_GONE } from "./review-recovery.ts";
import { Store } from "./store.ts";
import type { InspectionReport, ReviewItem } from "./types.ts";

function compare(sourceBytes: number, sidecarBytes: number): Pick<ReviewItem, "source" | "sidecar"> {
  return {
    source: { codec: "hevc", quality: "HD", sizeBytes: sourceBytes, sizePerHourGb: 1, durationSec: 60, tracks: "1 audio / 0 subtitles" },
    sidecar: { codec: "hevc", quality: "HD", sizeBytes: sidecarBytes, sizePerHourGb: 0.5, durationSec: 60, tracks: "1 audio / 0 subtitles" },
  };
}

describe("interrupted Keep recovery", () => {
  it("returns an interrupted Keep to pending when the sidecar and original are both still there", async () => {
    const ctx = setup();
    writeFileSync(ctx.sourcePath, "ORIGINAL!");
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    writeFileSync(stagedNewPath(ctx.sourcePath), "partial");
    ctx.store.insertReview({
      id: "rev-1",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "keeping",
      flagged: false,
      flagReason: null,
      sourcePath: ctx.sourcePath,
      sidecarPath: ctx.sidecarPath,
      ...compare(9, 10),
      error: null,
    });

    await ctx.jobs.recoverInterruptedKeeps();
    const review = ctx.store.getReview("rev-1");
    expect(review).toMatchObject({ status: "pending", error: KEEP_INTERRUPTED });
    expect(existsSync(stagedNewPath(ctx.sourcePath))).toBe(false);

    const keep = await ctx.jobs.keep("rev-1");
    expect(keep).toMatchObject({ accepted: true, disposition: "started" });
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")).toBeUndefined());
    ctx.close();
  });

  it("finishes a Keep that already replaced the library file", async () => {
    const ctx = setup();
    writeFileSync(ctx.sourcePath, "SIDECAR!!!");
    ctx.store.insertReview({
      id: "rev-1",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "keeping",
      flagged: false,
      flagReason: null,
      sourcePath: ctx.sourcePath,
      sidecarPath: ctx.sidecarPath,
      ...compare(20, 10),
      error: null,
    });

    await ctx.jobs.recoverInterruptedKeeps();
    expect(ctx.store.getReview("rev-1")).toBeUndefined();
    expect(ctx.store.historyPage(0, 10).items).toEqual([
      expect.objectContaining({ itemId: ctx.itemId, outcome: "kept", bytesSaved: 10 }),
    ]);
    expect(ctx.store.getItem(ctx.itemId)?.sizeBytes).toBe(10);
    expect(ctx.store.getItem(ctx.itemId)?.keptSizeBytes).toBe(10);
    ctx.close();
  });

  it("does not claim Keep succeeded when the sidecar is gone and the original is untouched", async () => {
    const ctx = setup();
    writeFileSync(ctx.sourcePath, "ORIGINAL!");
    ctx.store.insertReview({
      id: "rev-1",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "keeping",
      flagged: false,
      flagReason: null,
      sourcePath: ctx.sourcePath,
      sidecarPath: ctx.sidecarPath,
      ...compare(9, 10),
      error: null,
    });

    await ctx.jobs.recoverInterruptedKeeps();
    expect(ctx.store.getReview("rev-1")).toMatchObject({ status: "pending", error: SIDECAR_GONE });
    const keep = await ctx.jobs.keep("rev-1");
    expect(keep).toMatchObject({ error: SIDECAR_GONE, status: 409 });
    expect(ctx.store.getReview("rev-1")?.status).toBe("pending");
    ctx.close();
  });

  it("restores the original from .opt-old when Keep crashed mid-replace", async () => {
    const ctx = setup();
    const neighbor = join(ctx.dir, "other.mkv.opt-old");
    writeFileSync(neighbor, "NEIGHBOR-ORIGINAL");
    writeFileSync(stagedBackupPath(ctx.sourcePath), "ORIGINAL!");
    writeFileSync(stagedNewPath(ctx.sourcePath), "SIDECAR!!!");
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    ctx.store.insertReview({
      id: "rev-1",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "keeping",
      flagged: false,
      flagReason: null,
      sourcePath: ctx.sourcePath,
      sidecarPath: ctx.sidecarPath,
      ...compare(9, 10),
      error: null,
    });

    await ctx.jobs.recoverInterruptedKeeps();
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    expect(existsSync(stagedBackupPath(ctx.sourcePath))).toBe(false);
    expect(existsSync(stagedNewPath(ctx.sourcePath))).toBe(false);
    expect(readFileSync(neighbor, "utf8")).toBe("NEIGHBOR-ORIGINAL");
    expect(ctx.store.getReview("rev-1")).toMatchObject({ status: "pending", error: KEEP_INTERRUPTED });

    const discarded = await ctx.jobs.discard("rev-1");
    expect(discarded).toMatchObject({ accepted: true });
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("ORIGINAL!");
    ctx.close();
  });

  it("keepPending starts every pending card and leaves keeping cards alone", async () => {
    const ctx = setup();
    writeFileSync(ctx.sourcePath, "ORIGINAL!");
    const pendingIds = ["rev-a", "rev-b"];
    for (const [index, id] of pendingIds.entries()) {
      const sidecar = join(ctx.dir, `sidecar-${index}.mkv`);
      writeFileSync(sidecar, `SIDE${index}`);
      ctx.store.insertReview({
        id,
        jobId: "job-1",
        itemId: ctx.itemId,
        displayTitle: "Film",
        status: "pending",
        flagged: false,
        flagReason: null,
        sourcePath: ctx.sourcePath,
        sidecarPath: sidecar,
        ...compare(9, 6),
        error: null,
      });
    }
    ctx.store.insertReview({
      id: "rev-keeping",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "keeping",
      flagged: false,
      flagReason: null,
      sourcePath: ctx.sourcePath,
      sidecarPath: join(ctx.dir, "missing.mkv"),
      ...compare(9, 6),
      error: null,
    });
    expect(ctx.store.reviewPage(0, 50).pendingCount).toBe(2);
    const result = await ctx.jobs.keepPending();
    expect(result).toEqual({ accepted: 2, skipped: 0, started: 2, waiting: 0 });
    await vi.waitFor(() => expect(pendingIds.every((id) => ctx.store.getReview(id) === undefined)).toBe(true));
    expect(ctx.store.getReview("rev-keeping")?.status).toBe("keeping");
    ctx.close();
  });

  it("runs Keep selected copies one at a time when concurrency is 1", async () => {
    const ctx = setup({ concurrency: 1 });
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const jobs = new JobService({
      ...ctx.base,
      promote: async (input) => {
        started.push(input.outputPath);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return { replaced: true, destPath: input.item.path, savedBytes: 1, warning: null, error: null };
      },
    });
    const ids = ["rev-a", "rev-b", "rev-c"];
    for (const [index, id] of ids.entries()) {
      const sidecar = join(ctx.dir, `sidecar-${index}.mkv`);
      writeFileSync(sidecar, `SIDE${index}`);
      ctx.store.insertReview({
        id,
        jobId: "job-1",
        itemId: ctx.itemId,
        displayTitle: "Film",
        status: "pending",
        flagged: false,
        flagReason: null,
        sourcePath: ctx.sourcePath,
        sidecarPath: sidecar,
        ...compare(9, 6),
        error: null,
      });
    }
    writeFileSync(ctx.sourcePath, "ORIGINAL!");
    const results = await Promise.all(ids.map((id) => jobs.keep(id)));
    expect(results.every((result) => "accepted" in result)).toBe(true);
    await vi.waitFor(() => expect(ids.every((id) => ctx.store.getReview(id) === undefined)).toBe(true));
    expect(maxActive).toBe(1);
    expect(started).toHaveLength(3);
    jobs.stop();
    ctx.close();
  });

  it("replaces the library file when Arr refresh fails after Keep", async () => {
    const ctx = setup();
    ctx.store.upsertInstance({
      id: ctx.store.listInstances()[0]?.id,
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "enc",
      enabled: true,
    });
    writeFileSync(ctx.sourcePath, "ORIGINAL!");
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    ctx.store.insertReview({
      id: "rev-1",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "pending",
      flagged: false,
      flagReason: null,
      sourcePath: ctx.sourcePath,
      sidecarPath: ctx.sidecarPath,
      ...compare(9, 6),
      error: null,
    });
    const jobs = new JobService({
      ...ctx.base,
      fetch: (async (url) => String(url).includes("/command")
        ? new Response("nope", { status: 500 })
        : new Response("{}", { status: 201 })) as typeof fetch,
    });
    const keep = await jobs.keep("rev-1");
    expect(keep).toMatchObject({ accepted: true, disposition: "started" });
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")).toBeUndefined());
    expect(readFileSync(ctx.sourcePath, "utf8")).toBe("SIDECAR!!!");
    expect(ctx.store.getJob("job-1")?.promoteError).toMatch(/HTTP 500/);
    jobs.stop();
    ctx.close();
  });

  it("asks Radarr to rename after Keep and stores the new library path", async () => {
    const ctx = setup();
    const oldPath = join(ctx.dir, "Film [WEBRip-1080p EAC3 5.1].mkv");
    const newPath = join(ctx.dir, "Film [WEBRip-1080p AAC 2.0].mkv");
    writeFileSync(oldPath, "ORIGINAL!");
    ctx.store.updateItemFile(ctx.itemId, oldPath, 9);
    ctx.store.upsertInstance({
      id: ctx.store.listInstances()[0]?.id,
      kind: "radarr",
      name: "Radarr",
      url: "http://radarr",
      secret: "enc",
      enabled: true,
    });
    writeFileSync(ctx.sidecarPath, "SIDECAR!!!");
    ctx.store.insertReview({
      id: "rev-1",
      jobId: "job-1",
      itemId: ctx.itemId,
      displayTitle: "Film",
      status: "pending",
      flagged: false,
      flagReason: null,
      sourcePath: oldPath,
      sidecarPath: ctx.sidecarPath,
      ...compare(9, 6),
      error: null,
    });
    const jobs = new JobService({
      ...ctx.base,
      decrypt: () => "k",
      sleep: async () => undefined,
      fetch: (async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) as { name?: string } : {};
        if (method === "POST" && body.name === "RefreshMovie") {
          return new Response(JSON.stringify({ id: 1, status: "completed" }), { status: 201 });
        }
        if (url.includes("/api/v3/rename?")) {
          return new Response(JSON.stringify([
            { movieId: 10, movieFileId: 55, existingPath: oldPath, newPath },
          ]));
        }
        if (method === "POST" && body.name === "RenameFiles") {
          renameSync(oldPath, newPath);
          return new Response(JSON.stringify({ id: 2, status: "completed" }), { status: 201 });
        }
        if (url.endsWith("/api/v3/movie/10")) {
          return new Response(JSON.stringify({ movieFile: { id: 55, path: newPath } }));
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const keep = await jobs.keep("rev-1");
    expect(keep).toMatchObject({ accepted: true, disposition: "started" });
    await vi.waitFor(() => expect(ctx.store.getReview("rev-1")).toBeUndefined());
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
    expect(ctx.store.getItem(ctx.itemId)?.path).toBe(newPath);
    jobs.stop();
    ctx.close();
  });
});

function setup(settings: { concurrency?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opt-keep-"));
  const store = new Store(join(dir, "polisharr.db"));
  const instanceId = store.upsertInstance({
    kind: "radarr",
    name: "Radarr",
    url: "http://radarr",
    secret: null,
    enabled: true,
  });
  const itemId = `${instanceId}:movie:10`;
  const sourcePath = join(dir, "movie.mkv");
  const sidecarPath = join(dir, "sidecar.mkv");
  store.saveSettings({ ...store.getSettings(), reviewPath: dir, concurrency: settings.concurrency ?? 1 });
  store.upsertItem({
    id: itemId,
    instanceId,
    arrId: 10,
    arrSeriesId: null,
    arrEpisodeFileId: null,
    type: "movie",
    title: "Film",
    showTitle: null,
    season: null,
    episode: null,
    episodeTitle: null,
    path: sourcePath,
    sizeBytes: 9,
    quality: "HD",
    resolution: "1080",
    profile: "HD",
    tags: [],
    posterRemoteUrl: null,
    sizeExempt: false,
  });
  const report: InspectionReport = {
    sourceSig: `${sourcePath}|9`,
    sourceMethod: "ffprobe",
    listingState: "complete",
    durationSec: 60,
    sizeBytes: 9,
    sizePerHourGb: 1,
    videoCodec: "hevc",
    width: 1920,
    height: 1080,
    bitDepth: 8,
    hdr: "none",
    audio: [],
    subtitles: [],
    hasChapters: false,
    hasAttachments: false,
  };
  store.saveInspection(itemId, report);
  store.insertJob({
    id: "job-1",
    itemId,
    suggestionId: null,
    status: "succeeded",
    phase: "idle",
    progress: 1,
    error: null,
    warning: null,
    runNow: false,
    createdAt: 1,
    plan: {
      origin: "bulk",
      video: { kind: "copy" },
      audio: [],
      subtitles: [],
      container: "mkv",
      writeMode: "sidecar",
      warning: null,
      reasons: [],
      estimatedOutputBytes: 10,
      category: "movie1080p",
    },
  });
  const base = {
    store,
    optimizer: async () => {
      throw new Error("optimizer should not run");
    },
    hardware: async () => ({ backend: "none" as const, cuda: false, vaapi: false, av1: false, reason: null }),
    tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", mkvmerge: "mkvmerge" },
    decrypt: () => "",
    fetch: (async () => new Response("{}")) as typeof fetch,
    reinspectChangedItem: async () => ({ ok: true as const }),
  };
  const jobs = new JobService(base);
  return {
    dir,
    store,
    itemId,
    sourcePath,
    sidecarPath,
    jobs,
    base,
    close: () => {
      jobs.stop();
      store.close();
    },
  };
}
