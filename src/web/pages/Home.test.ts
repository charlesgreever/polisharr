import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activityOutcomeLabel, activityWindowIsEmpty, HomeDashboard } from "./Home";
import type { HomePayload } from "../api";

const week = 7 * 24 * 60 * 60 * 1000;
const weekStart = Date.UTC(2026, 9, 5);

const data: HomePayload = {
  filesOptimized: 4,
  spaceSavedBytes: 6 * 1024 ** 3,
  suggestions: 2,
  queued: 1,
  queueActive: 5,
  review: 3,
  errors: 0,
  status: "Working · Film",
  savingsByWeek: Array.from({ length: 12 }, (_, index) => ({
    weekStart: weekStart + index * week,
    bytesSaved: index === 11 ? 2 * 1024 ** 3 : 0,
    files: index === 11 ? 1 : 0,
  })),
  outcomes: { kept: 1, discarded: 0, flagged: 0, failed: 0, cancelled: 0, searched: 0, removed: 0 },
  recent: [
    { id: "h1", displayTitle: "Film", outcome: "kept", bytesSaved: 2 * 1024 ** 3, createdAt: 1, href: "/movies/film" },
    { id: "h2", displayTitle: "Gone", outcome: "failed", bytesSaved: 0, createdAt: 2 },
  ],
};

describe("Home dashboard", () => {
  it("puts Status in a full-width strip and links work counts", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HomeDashboard, { data })));
    expect(html).toContain("Working · Film");
    expect(html).toContain("href=\"/suggestions\"");
    expect(html).toContain("href=\"/queue\"");
    expect(html).toContain(">5</div>");
    expect(html).toContain("href=\"/review\"");
    expect(html).toContain("href=\"/errors\"");
    expect(html).toContain("Kept");
    expect(html).toContain("Space saved, last 12 weeks");
    expect(html).toContain("href=\"/movies/film\"");
    expect(html).toContain("Gone");
    expect(html).not.toContain("href=\"/movies/gone\"");
    expect(html).not.toContain("Home is the landing page");
    expect(html).not.toContain("metrics");
  });

  it("says when the last 12 weeks have no kept files and no other outcomes", () => {
    const quiet: HomePayload = {
      ...data,
      savingsByWeek: data.savingsByWeek.map((row) => ({ ...row, bytesSaved: 0, files: 0 })),
      outcomes: { kept: 0, discarded: 0, flagged: 0, failed: 0, cancelled: 0, searched: 0, removed: 0 },
    };
    expect(activityWindowIsEmpty(quiet)).toBe(true);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HomeDashboard, { data: quiet })));
    expect(html).toContain("Nothing kept in the last 12 weeks.");
    expect(html).not.toContain("Space saved, last 12 weeks");
  });

  it("lists each encode node when more than one is registered", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HomeDashboard, {
      data: {
        ...data,
        nodes: [
          { id: "a", name: "5090", online: true, enabled: true, running: 2, concurrency: 2, waiting: 1, jobs: [{ id: "1", title: "Film", phase: "transcoding", progress: 0.4 }] },
          { id: "b", name: "MacBook Pro", online: true, enabled: true, running: 0, concurrency: 4, waiting: 0, jobs: [] },
        ],
      },
    })));
    expect(html).toContain("5090");
    expect(html).toContain("2 of 2 · next job waiting");
    expect(html).toContain("MacBook Pro");
    expect(html).toContain("Idle");
  });

  it("names activity outcomes in everyday words", () => {
    expect(activityOutcomeLabel("kept")).toBe("Kept");
    expect(activityOutcomeLabel("flagged")).toBe("Flagged");
    expect(activityOutcomeLabel("searched")).toBe("Asked to search");
  });
});
