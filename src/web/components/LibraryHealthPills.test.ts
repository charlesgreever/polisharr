import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LibraryHealthPills } from "./LibraryHealthPills";

describe("library health pills", () => {
  it("makes the suggestions count a toggle for titles that need work", () => {
    const html = renderToStaticMarkup(createElement(LibraryHealthPills, {
      healthyCount: 628,
      suggestionCount: 4,
      work: true,
      onWorkChange: vi.fn(),
    }));
    expect(html).toContain("628 healthy");
    expect(html).toContain("4 suggestions");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("Show every title");
  });
});
