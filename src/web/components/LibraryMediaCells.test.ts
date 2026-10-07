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
    expect(html).toContain("aria-label=\"Optimize\"");
    expect(html).toContain("aria-label=\"Library\"");
    expect(html).toContain("aria-label=\"Queue\"");
    expect(html).toContain("Force</button>");
    expect(html).toContain("aria-label=\"Force suggestion\"");
    expect(html).toContain("Stereo</button>");
    expect(html).toContain("aria-label=\"Add stereo\"");
    expect(html).toContain("aria-label=\"Exempt\"");
    expect(html).toContain("Exempt</button>");
    expect(html).toContain("Replace this file in Radarr");
    expect(html).toContain("Remove this movie from Radarr");
    expect(html).not.toContain("aria-label=\"Open\"");
    const remove = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0])
      .find((tag) => tag.includes("Remove this movie from Radarr"));
    expect(remove).toContain("bg-error-50");
    expect(remove).toContain("border-error-300");
  });

  it("puts encode target in its own column before the actions", () => {
    const html = renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(
        "table",
        null,
        createElement("thead", null, createElement(
          "tr",
          null,
          createElement(LibraryMediaHeaders, { encodeTarget: true, encodeTargetTip: "Chooses HEVC or AV1." }),
        )),
        createElement("tbody", null, createElement(
          "tr",
          null,
          createElement(LibraryMediaCells, { item: row(), onDone: () => {}, encodeTarget: true }),
        )),
      ),
    ));
    expect(html.indexOf("Encode target")).toBeGreaterThan(-1);
    expect(html.indexOf("Encode target")).toBeLessThan(html.indexOf(">Actions<"));
    expect(html.indexOf("House default (HEVC)")).toBeLessThan(html.indexOf("aria-label=\"Queue\""));
    expect(html).toContain("aria-label=\"Encode target\"");
    expect(html).toContain("Chooses HEVC or AV1.");
  });

  it("does not put an encode target control on episode rows", () => {
    const html = renderCells(row({ type: "episode", id: "ep-1" }));
    expect(html).not.toContain("aria-label=\"Encode target\"");
  });
});
