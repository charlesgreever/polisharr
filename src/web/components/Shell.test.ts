import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Shell } from "./Shell";

vi.mock("../api", () => ({
  api: {
    search: async () => ({ items: [] }),
    refresh: async () => undefined,
    inspect: async () => ({ walking: false, pending: 0, inspected: 0, failed: 0 }),
    work: async () => ({
      queueActive: 0,
      review: 0,
      suggestions: 0,
      movieSuggestions: 0,
      seriesSuggestions: 0,
      errors: 0,
      runningTitle: null,
      nodes: [],
    }),
    jobs: async () => ({ items: [] }),
  },
}));

describe("app shell", () => {
  it("hides the menu button on large screens and labels search", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(Shell, { version: "0.2.1", children: "body" })),
    );
    expect(html).toContain("Open menu");
    expect(html).toContain("lg:hidden");
    expect(html).toContain("aria-label=\"Search movies and episodes\"");
    expect(html).toContain("Polisharr");
    expect(html).toContain("0.2.1");
    expect(html).toContain("Switch to dark mode");
  });
});
