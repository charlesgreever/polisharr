import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlaybackObservationList, PlaybackProblemCard, PlaybackProblemList, problemWindowLabel } from "./Playback";
import type { PlaybackDiagnostic, PlaybackObservation } from "../api";

function diagnostic(over: Partial<PlaybackDiagnostic> = {}): PlaybackDiagnostic {
  return {
    id: "diag-1",
    connectionId: "jf",
    connectionName: "Jellyfin",
    deviceId: "living-room",
    deviceLabel: "Living Room TV",
    itemName: "The Film",
    libraryItemIds: ["film-1080"],
    itemId: "film-1080",
    href: "/movies/film-1080",
    reasonFamily: "audio",
    summary: "Jellyfin converted the audio on Living Room TV.",
    rawReasons: ["AudioCodecNotSupported"],
    playMethod: "Transcode",
    match: "matched",
    occurrenceCount: 3,
    lastSeenAt: Date.UTC(2026, 8, 14),
    recommendation: {
      kind: "add_stereo",
      explanation: "This plan adds an AAC stereo track and keeps the original mix.",
      canRepair: true,
      openEditor: true,
      draft: { video: { mode: "copy" } },
      suggestionId: null,
    },
    afterKeep: { status: "not_yet_observed", sentence: "Not yet observed." },
    stale: false,
    ...over,
  };
}

describe("Playback page copy", () => {
  it("names the problem window beside the count", () => {
    expect(problemWindowLabel(1, 7)).toBe("1 problem in the last 7 days");
    expect(problemWindowLabel(12, 7)).toBe("12 problems in the last 7 days");
  });

  it("lets keyboard users open a diagnostic and review the repair draft before queueing", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(PlaybackProblemList, { items: [diagnostic()], onDismiss: () => undefined })),
    );
    expect(html).toContain("Jellyfin converted the audio on Living Room TV.");
    expect(html).toContain("Open repair plan");
    expect(html).toContain("href=\"/movies/film-1080?repair=diag-1\"");
    expect(html).toContain("Show details");
    expect(html).toContain("Dismiss");
    expect(html).toContain("3 viewings");
    expect(html).toContain("Not yet observed.");
    expect(html).not.toContain("Queue this plan");
  });

  it("keeps unmatched repair closed and names a later Direct Play after Keep", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlaybackProblemCard, {
      row: diagnostic({
        match: "unmatched",
        href: null,
        recommendation: {
          kind: "none",
          explanation: "This playback did not match a library file. Repair stays off until the path matches.",
          canRepair: false,
          openEditor: false,
          draft: null,
          suggestionId: null,
        },
        afterKeep: { status: "observed_direct", sentence: "Direct playback observed on this device after Keep." },
      }),
    })));
    expect(html).not.toContain("Open repair plan");
    expect(html).toContain("Direct playback observed on this device after Keep.");
  });

  it("lists observations separately from file-inspection errors", () => {
    const row: PlaybackObservation = {
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
      lastSeenAt: Date.UTC(2026, 8, 14),
      stale: false,
    };
    const html = renderToStaticMarkup(createElement(PlaybackObservationList, { items: [row] }));
    expect(html).toContain("Jellyfin played this file directly on Living Room TV.");
    expect(html).not.toContain("unreadable");
  });
});
