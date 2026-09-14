import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LibraryRow } from "../api";
import { LibraryMediaCells, LibraryMediaHeaders } from "./LibraryMediaCells";

function row(patch: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id: "movie-1",
    instanceId: "radarr",
    displayTitle: "Film",
    instanceName: "Radarr",
    type: "movie",
    showTitle: null,
    quality: "Bluray-1080p",
    path: "/movies/film.mkv",
    sizeBytes: 1_000,
    sizeExempt: false,
    inspected: true,
    mediaState: "inspected",
    hasPoster: false,
    error: null,
    reasons: [],
    suggestion: { id: "sug-1", actions: ["transcode"], reasons: [] },
    videoLabel: "hevc · 1920x1080",
    audioLabels: ["eng truehd 7.1", "eng aac 2.0"],
    subtitleLabels: [],
    ...patch,
  };
}

function renderCells(item: LibraryRow) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(
      "table",
      null,
      createElement("tbody", null, createElement("tr", null, createElement(LibraryMediaCells, { item, onDone: () => {} }))),
    ),
  ));
}

describe("library media headers", () => {
  it("renders sortable columns as keyboard-accessible buttons", () => {
    const html = renderToStaticMarkup(createElement(
      "table",
      null,
      createElement("thead", null, createElement(
        "tr",
        null,
        createElement(LibraryMediaHeaders, { onQuality: vi.fn(), onSize: vi.fn() }),
      )),
    ));

    expect(html).toContain("<button type=\"button\">Quality</button>");
    expect(html).toContain("<button type=\"button\">Size</button>");
  });
});

describe("library media cells", () => {
  it("shows Healthy as a distinct status and splits audio into separate labels", () => {
    const html = renderCells(row());
    expect(html).toContain("Healthy");
    expect(html).toContain("eng truehd 7.1");
    expect(html).toContain("eng aac 2.0");
    expect(html).not.toContain("eng truehd 7.1, eng aac 2.0");
    expect(html).toContain("None");
  });

  it("keeps queue, force, stereo, and exemption actions available from the row", () => {
    const html = renderCells(row());
    expect(html).toContain("aria-label=\"Queue\"");
    expect(html).toContain("aria-label=\"Force suggestion\"");
    expect(html).toContain("aria-label=\"Add stereo\"");
    expect(html).toContain("aria-label=\"Exempt\"");
    expect(html).toContain("Replace this file in Radarr");
    expect(html).toContain("Remove this movie from Radarr");
    expect(html).toContain("Exempt");
    expect(html).toContain("aria-label=\"Open\"");
    expect(html).toContain("aria-label=\"Encode target\"");
  });

  it("does not put an encode target control on episode rows", () => {
    const html = renderCells(row({ type: "episode", id: "ep-1" }));
    expect(html).not.toContain("aria-label=\"Encode target\"");
  });
});
