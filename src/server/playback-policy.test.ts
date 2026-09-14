import { describe, expect, it } from "vitest";
import type { PlaybackConnectionSettings } from "./types.ts";
import {
  PLAYBACK_ALLOWED,
  PLAYBACK_WAIT_FINISH,
  PLAYBACK_WAIT_STATUS,
  admitNodeWork,
  createPlaybackPolicy,
  playbackHoldDetail,
  playbackHoldSentence,
  playbackMonitoringEnabled,
  sessionBlocksFile,
  sessionBlocksNode,
  type PlaybackFileTarget,
  type PlaybackPolicyObservation,
  type PlaybackPolicySession,
} from "./playback-policy.ts";

function settings(over: Partial<PlaybackConnectionSettings> & { connectionId: string }): PlaybackConnectionSettings {
  return {
    observePlayback: false,
    retainHistory: true,
    protectNodes: false,
    protectedNodeIds: [],
    protectReplacement: false,
    coveredArrInstanceIds: [],
    ...over,
  };
}

function video(over: Partial<PlaybackPolicySession> = {}): PlaybackPolicySession {
  return {
    nowPlaying: { itemId: "item-1", mediaType: "Video", type: "Movie", path: "/mnt/nas/movies/film.mkv" },
    isPaused: false,
    match: {
      outcome: "matched",
      libraryItemIds: ["film-1"],
      path: "/mnt/nas/movies/film.mkv",
      instanceIds: ["radarr"],
    },
    ...over,
  };
}

function observation(
  connectionId: string,
  fetchedAt: number,
  sessions: PlaybackPolicySession[],
  over: Partial<PlaybackPolicyObservation> = {},
): PlaybackPolicyObservation {
  return { connectionId, fetchedAt, complete: true, error: null, sessions, ...over };
}

const file: PlaybackFileTarget = {
  itemId: "film-1",
  path: "/mnt/nas/movies/film.mkv",
  instanceId: "radarr",
};

describe("playback session classification", () => {
  it("blocks mapped nodes for Direct Play and other unpaused video, including missing pause state", () => {
    expect(sessionBlocksNode(video({ isPaused: false }))).toBe(true);
    expect(sessionBlocksNode(video({
      nowPlaying: { itemId: "item-1", mediaType: "Video", type: "Movie", path: "/film.mkv" },
      isPaused: false,
      match: null,
    }))).toBe(true);
    expect(sessionBlocksNode(video({ isPaused: null }))).toBe(true);
    expect(sessionBlocksNode(video({ isPaused: true }))).toBe(false);
  });

  it("does not treat audio-only or empty sessions as video protection, and treats missing media type as video", () => {
    expect(sessionBlocksNode({
      nowPlaying: { itemId: "song", mediaType: "Audio", type: "Audio", path: "/music.flac" },
      isPaused: false,
      match: null,
    })).toBe(false);
    expect(sessionBlocksNode({ nowPlaying: null, isPaused: false, match: null })).toBe(false);
    expect(sessionBlocksNode(video({
      nowPlaying: { itemId: "item-1", mediaType: null, type: null, path: "/film.mkv" },
      isPaused: false,
      match: null,
    }))).toBe(true);
  });

  it("protects a matched file while paused, and holds covered libraries when the current video is unmatched", () => {
    const covered = new Set(["radarr"]);
    expect(sessionBlocksFile(video({ isPaused: true }), file, covered)).toBe(true);
    expect(sessionBlocksFile(video({
      isPaused: false,
      match: { outcome: "unmatched", libraryItemIds: [], path: null, instanceIds: [] },
    }), file, covered)).toBe(true);
    expect(sessionBlocksFile(video({
      match: { outcome: "unmatched", libraryItemIds: [], path: null, instanceIds: [] },
    }), { ...file, instanceId: "sonarr" }, covered)).toBe(false);
    expect(sessionBlocksFile(video({
      match: { outcome: "matched", libraryItemIds: ["ep-1", "ep-2"], path: "/show.mkv", instanceIds: ["sonarr"] },
    }), { itemId: "ep-2", path: "/show.mkv", instanceId: "sonarr" }, new Set(["sonarr"]))).toBe(true);
  });
});

describe("playback node admission", () => {
  it("allows work when playback protection is off", () => {
    const policy = createPlaybackPolicy({ clock: () => 1_000 });
    const row = settings({ connectionId: "jf", protectNodes: false, protectedNodeIds: ["gpu"] });
    policy.observe(observation("jf", 1_000, [video()]));
    expect(policy.nodeAdmission("gpu", [row])).toEqual(expect.objectContaining({ allowed: true }));
    expect(playbackMonitoringEnabled(row)).toBe(false);
    expect(playbackMonitoringEnabled({ ...row, protectNodes: true })).toBe(true);
  });

  it("holds a mapped node as unknown until the first successful snapshot", () => {
    const policy = createPlaybackPolicy({ clock: () => 1_000, connectionName: () => "Living Room" });
    const row = settings({ connectionId: "jf", protectNodes: true, protectedNodeIds: ["gpu"] });
    const decision = policy.nodeAdmission("gpu", [row]);
    expect(decision).toMatchObject({ allowed: false, reason: "unknown", connectionIds: ["jf"], connectionNames: ["Living Room"] });
    expect(playbackHoldSentence(decision)).toBe(PLAYBACK_WAIT_STATUS);
    expect(playbackHoldDetail(decision)).toBe("Living Room");
    expect(policy.nodeAdmission("other", [row]).allowed).toBe(true);
  });

  it("blocks local and remote mapped nodes during unpaused video, including Direct Play", () => {
    let now = 5_000;
    const policy = createPlaybackPolicy({ clock: () => now, connectionName: () => "Living Room" });
    const row = settings({ connectionId: "jf", protectNodes: true, protectedNodeIds: ["local", "worker"] });
    policy.observe(observation("jf", 5_000, [video()]));
    const local = policy.nodeAdmission("local", [row]);
    const remote = policy.nodeAdmission("worker", [row]);
    expect(local).toMatchObject({ allowed: false, reason: "playing", observedAt: 5_000 });
    expect(remote.allowed).toBe(false);
    expect(playbackHoldSentence(local)).toBe(PLAYBACK_WAIT_FINISH);
    now = 20_000;
    expect(policy.nodeAdmission("local", [row]).reason).toBe("playing");
  });

  it("releases node protection after two idle observations and 30s, but keeps protecting the paused file", () => {
    let now = 0;
    const policy = createPlaybackPolicy({ clock: () => now });
    const row = settings({
      connectionId: "jf",
      protectNodes: true,
      protectedNodeIds: ["gpu"],
      protectReplacement: true,
      coveredArrInstanceIds: ["radarr"],
    });
    policy.observe(observation("jf", 0, [video()]));
    now = 10_000;
    policy.observe(observation("jf", 10_000, [video({ isPaused: true })]));
    now = 20_000;
    policy.observe(observation("jf", 20_000, [video({ isPaused: true })]));
    expect(policy.nodeAdmission("gpu", [row])).toMatchObject({ allowed: false, reason: "cooldown" });
    expect(policy.fileReplacement(file, [row]).allowed).toBe(false);
    now = 30_000;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(true);
    expect(policy.fileReplacement(file, [row]).allowed).toBe(false);
  });

  it("does not resume after two idle polls unless 30s have passed since the last block", () => {
    let now = 0;
    const policy = createPlaybackPolicy({ clock: () => now });
    const row = settings({ connectionId: "jf", protectNodes: true, protectedNodeIds: ["gpu"] });
    policy.observe(observation("jf", 0, [video()]));
    now = 10_000;
    policy.observe(observation("jf", 10_000, []));
    now = 20_000;
    policy.observe(observation("jf", 20_000, []));
    expect(policy.nodeAdmission("gpu", [row])).toMatchObject({ allowed: false, reason: "cooldown" });
    now = 29_999;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(false);
    now = 30_000;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(true);
  });

  it("starts the initial idle cooldown from the first successful idle observation after startup", () => {
    let now = 5_000;
    const policy = createPlaybackPolicy({ clock: () => now });
    const row = settings({ connectionId: "jf", protectNodes: true, protectedNodeIds: ["gpu"] });
    policy.observe(observation("jf", 5_000, []));
    now = 15_000;
    policy.observe(observation("jf", 15_000, []));
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(false);
    now = 34_999;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(false);
    now = 35_000;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(true);
  });

  it("resets eligibility on blocking or unknown observations", () => {
    let now = 0;
    const policy = createPlaybackPolicy({ clock: () => now });
    const row = settings({ connectionId: "jf", protectNodes: true, protectedNodeIds: ["gpu"] });
    policy.observe(observation("jf", 0, []));
    now = 10_000;
    policy.observe(observation("jf", 10_000, []));
    now = 40_000;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(true);
    policy.observe(observation("jf", 40_000, [], { complete: false, error: "Jellyfin timed out." }));
    expect(policy.nodeAdmission("gpu", [row])).toMatchObject({ allowed: false, reason: "unknown" });
    now = 50_000;
    policy.observe(observation("jf", 50_000, []));
    now = 60_000;
    policy.observe(observation("jf", 60_000, []));
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(false);
    now = 70_000;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(true);
  });

  it("cannot clear a previous block with an incomplete snapshot", () => {
    const policy = createPlaybackPolicy({ clock: () => 20_000 });
    const row = settings({ connectionId: "jf", protectNodes: true, protectedNodeIds: ["gpu"] });
    policy.observe(observation("jf", 0, [video()]));
    policy.observe(observation("jf", 10_000, [], { complete: false, error: "truncated" }));
    expect(policy.nodeAdmission("gpu", [row])).toMatchObject({ allowed: false, reason: "unknown" });
  });

  it("holds a node when one mapped connection is blocked even if another is idle", () => {
    let now = 40_000;
    const policy = createPlaybackPolicy({ clock: () => now, connectionName: (id) => id === "jf-a" ? "TV" : "Laptop" });
    const a = settings({ connectionId: "jf-a", protectNodes: true, protectedNodeIds: ["gpu"] });
    const b = settings({ connectionId: "jf-b", protectNodes: true, protectedNodeIds: ["gpu", "spare"] });
    policy.observe(observation("jf-b", 1_000, []));
    policy.observe(observation("jf-b", 11_000, []));
    now = 40_000;
    policy.observe(observation("jf-a", 40_000, [video()]));
    policy.observe(observation("jf-b", 40_000, []));
    const gpu = policy.nodeAdmission("gpu", [a, b]);
    expect(gpu).toMatchObject({ allowed: false, reason: "playing", connectionIds: ["jf-a"] });
    expect(playbackHoldDetail(gpu)).toBe("TV");
    expect(policy.nodeAdmission("spare", [a, b]).allowed).toBe(true);
  });

  it("holds configured nodes when the snapshot is stale and keeps the last success time", () => {
    let now = 1_000;
    const policy = createPlaybackPolicy({ clock: () => now });
    const row = settings({ connectionId: "jf", protectNodes: true, protectedNodeIds: ["gpu"] });
    policy.observe(observation("jf", 1_000, []));
    policy.observe(observation("jf", 11_000, []));
    now = 41_000;
    expect(policy.nodeAdmission("gpu", [row]).allowed).toBe(true);
    now = 41_001;
    const stale = policy.nodeAdmission("gpu", [row]);
    expect(stale).toMatchObject({ allowed: false, reason: "unknown", observedAt: 11_000 });
    expect(playbackHoldSentence(stale)).toBe(PLAYBACK_WAIT_STATUS);
  });
});

describe("shared node work admission", () => {
  it("uses one slot budget for optimize work and yields no slots while playback holds the node", () => {
    const blocked = {
      allowed: false,
      reason: "playing" as const,
      connectionIds: ["jf"],
      connectionNames: ["Living Room"],
      observedAt: 1,
    };
    expect(admitNodeWork({ decision: blocked, concurrency: 4, runningCount: 1 })).toEqual({
      allowed: false,
      freeSlots: 0,
      decision: blocked,
    });
    expect(admitNodeWork({ decision: PLAYBACK_ALLOWED, concurrency: 4, runningCount: 1 })).toEqual({
      allowed: true,
      freeSlots: 3,
      decision: PLAYBACK_ALLOWED,
    });
    expect(admitNodeWork({ decision: PLAYBACK_ALLOWED, concurrency: 2, runningCount: 2 }).allowed).toBe(false);
  });
});
