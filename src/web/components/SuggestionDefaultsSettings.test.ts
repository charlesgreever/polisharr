import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SuggestionDefaultsSettings } from "./SuggestionDefaultsSettings";

const defaults = {
  removeNonPreferredSubtitles: true,
  removeNonPreferredAudio: true,
  addStereo: true,
  transcodeToSizeCap: true,
  transcodeBelowHevc: false,
  convertMp4ToMkv: false,
  convertIsoToMkv: false,
  searchPreferredLanguage: false,
  queueNewImports: false,
};

function markup(queueNewImports: boolean, writeMode: "sidecar" | "follow" | "direct", videoTarget?: "hevc" | "av1"): string {
  return renderToStaticMarkup(createElement(SuggestionDefaultsSettings, {
    value: { ...defaults, queueNewImports },
    writeMode,
    videoTarget,
    onChange: () => undefined,
    onWriteModeChange: () => undefined,
    onSave: () => undefined,
  }));
}

function importSelect(html: string): string {
  return html.match(/<select[\s\S]*?<\/select>/)?.[0] ?? "";
}

describe("suggestion defaults settings", () => {
  it("shows the opt-in MP4 conversion beside the automatic operations", () => {
    const html = markup(false, "sidecar");

    expect(html).toContain("Default suggestion operations");
    expect(html).toContain("Transcode video below Target Encode (HEVC)");
    expect(html).toContain("Convert MP4 to MKV");
    expect(html).toContain("Convert ISO to MKV");
    expect(html).toContain("Queue new Arr imports automatically");
    expect(html).toContain("It does not queue that file again");
    expect(html).toContain("A later Arr upgrade can still queue that file");
    expect(html).toContain("Turning that on does not queue your existing library");
    expect(html).toContain("Save suggestion defaults");
  });

  it("keeps the saved import finish choice while automatic queue is off", () => {
    const select = importSelect(markup(false, "direct"));
    expect(select).toContain("disabled");
    expect(select.indexOf("Sidecar for Review")).toBeLessThan(select.indexOf("Use Write finished files"));
    expect(select.indexOf("Use Write finished files")).toBeLessThan(select.indexOf(">Direct write<"));
    expect(select).toContain('value="direct" selected=""');
    expect(markup(false, "direct")).toContain("Jobs already in Queue keep the choice they were queued with");
  });

  it("enables the import finish choice while Queue new Arr imports is on", () => {
    const html = markup(true, "follow");
    const select = importSelect(html);
    expect(select).not.toContain("disabled");
    expect(select).toContain('value="follow" selected=""');
    expect(html).toContain("Sidecar for Review waits in Review");
    expect(html).toContain("Use Write finished files follows the Write finished files setting");
    expect(html).toContain("Direct write replaces the library file after the integrity check");
  });

  it("names the below-target checkbox after Encode Target AV1", () => {
    const html = markup(false, "sidecar", "av1");

    expect(html).toContain("Transcode video below Target Encode (AV1)");
    expect(html).not.toContain("Transcode video below Target Encode (HEVC)");
  });
});
