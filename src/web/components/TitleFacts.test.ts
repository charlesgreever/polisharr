import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibraryRow } from "../api";
import { TitleFacts } from "./TitleFacts";

function item(patch: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id: "movie-1",
    instanceId: "radarr",
    displayTitle: "1917",
    instanceName: "greeverradarr",
    type: "movie",
    showTitle: null,
    quality: "Bluray-2160p",
    path: "/mnt/nas/movies/1917 (2019)/1917.2019.2160p.UHD.BluRay.mkv",
    sizeBytes: 21_640_000_000,
    sizeExempt: false,
    inspected: true,
    mediaState: "inspected",
    hasPoster: true,
    error: null,
    reasons: [],
    suggestion: null,
    videoLabel: "hevc · 3840x1606",
    audioLabels: [],
    subtitleLabels: [],
    report: {
      listingState: "complete",
      sourceMethod: "ffprobe",
      videoCodec: "hevc",
      width: 3840,
      height: 1606,
      bitDepth: 10,
      hdr: "hdr10",
      sizeBytes: 21_640_000_000,
      durationSec: 7140,
      sizePerHourGb: 10.91,
      audio: [],
      subtitles: [],
    },
    ...patch,
  };
}

describe("title facts", () => {
  it("shows the file name, full path, and inspect facts the table omitted", () => {
    const html = renderToStaticMarkup(createElement(TitleFacts, { item: item() }));
    expect(html).toContain("1917.2019.2160p.UHD.BluRay.mkv");
    expect(html).toContain("/mnt/nas/movies/1917 (2019)/1917.2019.2160p.UHD.BluRay.mkv");
    expect(html).toContain("greeverradarr");
    expect(html).toContain("Bluray-2160p");
    expect(html).toContain("HDR10");
    expect(html).toContain("10-bit");
    expect(html).toContain("1h 59m");
  });

  it("links out to Radarr in a new tab", () => {
    const html = renderToStaticMarkup(createElement(TitleFacts, {
      item: item({ links: [{ label: "Open in Radarr", href: "http://radarr:7878/movie/11" }] }),
    }));
    expect(html).toContain("Open in Radarr");
    expect(html).toContain("http://radarr:7878/movie/11");
    expect(html).toContain("target=\"_blank\"");
  });

  it("shows when another episode uses the same file", () => {
    const html = renderToStaticMarkup(createElement(TitleFacts, { item: item({ sharedFileLabel: "Same file as E36" }) }));
    expect(html).toContain("Same file as E36");
  });

  it("says when Radarr or Sonarr did not send a path", () => {
    const html = renderToStaticMarkup(createElement(TitleFacts, { item: item({ path: "" }) }));
    expect(html).toContain("No file path from Radarr or Sonarr yet.");
  });
});
