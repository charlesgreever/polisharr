import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlaybackTitleSummary } from "./Title";
import type { PlaybackTitleSummary as Summary } from "../api";

describe("title playback summary", () => {
  it("names Direct Play after Keep and links to Playback", () => {
    const playback: Summary = {
      windowDays: 30,
      problemCount: 1,
      afterKeep: { status: "observed_direct", sentence: "Direct playback observed on this device after Keep." },
      observations: [{
        id: "obs-1",
        connectionId: "jf",
        deviceId: "living-room",
        deviceLabel: "Living Room TV",
        itemName: "The Film",
        libraryItemIds: ["film-1080"],
        summary: "Jellyfin played this file directly on Living Room TV.",
        playMethod: "DirectPlay",
        reasonFamily: null,
        rawReasons: [],
        match: "matched",
        lastSeenAt: 1,
        stale: false,
      }],
    };
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlaybackTitleSummary, { playback })));
    expect(html).toContain("Direct playback observed on this device after Keep.");
    expect(html).toContain("Living Room TV");
    expect(html).toContain("href=\"/playback\"");
  });

  it("says Not yet observed when Keep has no later play", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlaybackTitleSummary, {
      playback: {
        windowDays: 30,
        problemCount: 1,
        afterKeep: { status: "not_yet_observed", sentence: "Not yet observed." },
        observations: [],
      },
    })));
    expect(html).toContain("Not yet observed.");
  });
});
