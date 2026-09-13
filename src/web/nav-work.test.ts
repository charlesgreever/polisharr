import { describe, expect, it } from "vitest";
import { emptyWorkSnapshot, headerWorkLine, navBadgeCount, navCount, nodeActivityLine } from "./nav-work.ts";

describe("sidebar work counts", () => {
  it("hides a zero badge and names a running job in the header", () => {
    expect(navCount(0)).toBeNull();
    expect(navCount(3)).toBe(3);
    expect(headerWorkLine(true, 4, "Film")).toBe("Inspecting · 4 left");
    expect(headerWorkLine(false, 0, "Film")).toBe("Working · Film");
    expect(headerWorkLine(false, 0, null)).toBe("● Ready");
    expect(headerWorkLine(false, 0, "Film", [
      { name: "5090", running: 3 },
      { name: "MacBook Pro", running: 2 },
    ])).toBe("Working · 3 on 5090, 2 on MacBook Pro");
  });

  it("badges Suggestions, Movies, Series, and Errors with remaining work and hides zeros", () => {
    const work = {
      ...emptyWorkSnapshot(),
      suggestions: 5,
      movieSuggestions: 2,
      seriesSuggestions: 3,
      queueActive: 4,
      review: 1,
      errors: 7,
    };
    expect(navBadgeCount("/suggestions", work)).toBe(5);
    expect(navBadgeCount("/movies", work)).toBe(2);
    expect(navBadgeCount("/series", work)).toBe(3);
    expect(navBadgeCount("/queue", work)).toBe(4);
    expect(navBadgeCount("/review", work)).toBe(1);
    expect(navBadgeCount("/errors", work)).toBe(7);
    expect(navBadgeCount("/movies", emptyWorkSnapshot())).toBeNull();
    expect(navBadgeCount("/suggestions", emptyWorkSnapshot())).toBeNull();
    expect(navBadgeCount("/errors", emptyWorkSnapshot())).toBeNull();
    expect(navBadgeCount("/", work)).toBeNull();
    expect((work.movieSuggestions ?? 0) + (work.seriesSuggestions ?? 0)).toBe(work.suggestions);
  });

  it("names idle, busy, drained, and offline encode nodes", () => {
    expect(nodeActivityLine({ online: false, enabled: true, running: 0, concurrency: 2, waiting: 1, jobs: [] })).toBe("Offline");
    expect(nodeActivityLine({ online: true, enabled: false, running: 0, concurrency: 2, waiting: 0, jobs: [] })).toBe("Drained");
    expect(nodeActivityLine({ online: true, enabled: true, running: 0, concurrency: 2, waiting: 0, jobs: [] })).toBe("Idle");
    expect(nodeActivityLine({
      online: true, enabled: true, running: 2, concurrency: 2, waiting: 3, jobs: [{ title: "Film" }],
    })).toBe("2 of 2 · next job waiting");
    expect(nodeActivityLine({
      online: true, enabled: true, running: 1, concurrency: 4, waiting: 0, jobs: [{ title: "Film" }],
    })).toBe("1 of 4 · Film");
  });
});
