import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryTable } from "./History";

describe("History titles", () => {
  it("links a title that is still in the library", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryTable, {
      items: [
        { id: "1", displayTitle: "Film", outcome: "kept", bytesSaved: 10, createdAt: 1, href: "/movies/film" },
        { id: "2", displayTitle: "Gone", outcome: "failed", bytesSaved: 0, createdAt: 2 },
      ],
    })));
    expect(html).toContain("href=\"/movies/film\"");
    expect(html).toContain("Gone");
    expect(html).not.toContain("History is the log");
  });
});
