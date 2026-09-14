import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LibraryHealthPills } from "./LibraryHealthPills";

describe("library health pills", () => {
  it("keeps healthy and suggestion counts as counts and labels the list filter", () => {
    const html = renderToStaticMarkup(createElement(LibraryHealthPills, {
      healthyCount: 628,
      suggestionCount: 4,
      work: true,
      onWorkChange: vi.fn(),
      noun: "episodes",
    }));
    expect(html).toContain("628 healthy");
    expect(html).toContain("4 suggestions");
    expect(html).toContain("All episodes");
    expect(html).toContain("Needs work");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("Suggestions, unread files, and files Polisharr could not read.");
    expect(html).not.toContain("Show every title");
  });

  it("explains All as healthy files plus anything that still needs work", () => {
    const html = renderToStaticMarkup(createElement(LibraryHealthPills, {
      healthyCount: 628,
      suggestionCount: 4,
      work: false,
      onWorkChange: vi.fn(),
      noun: "movies",
    }));
    expect(html).toContain("All movies");
    expect(html).toContain("Healthy files plus anything that still needs work.");
  });
});
