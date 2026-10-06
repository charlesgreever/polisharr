// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SettingsPayload } from "../api";
import { SettingsPage } from "./Settings";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const firstRun = {
  hasAdmin: true,
  languageConfirmed: true,
  hasReviewPath: true,
  hasArr: true,
  complete: true,
};

function settings(queueNewImports: boolean, queueNewImportWriteMode: SettingsPayload["queueNewImportWriteMode"]): SettingsPayload {
  return {
    preferredLanguage: "eng",
    languageConfirmed: true,
    reviewPath: "/mnt/nas/review-path",
    sizeCaps: {},
    suggestionDefaults: {
      removeNonPreferredSubtitles: true,
      removeNonPreferredAudio: true,
      addStereo: true,
      transcodeToSizeCap: true,
      transcodeBelowHevc: false,
      convertMp4ToMkv: false,
      convertIsoToMkv: false,
      searchPreferredLanguage: false,
      queueNewImports,
    },
    videoTarget: "hevc",
    concurrency: 1,
    conservativeMode: false,
    offPeakEnabled: false,
    offPeakStart: "01:00",
    offPeakEnd: "08:00",
    localAuthBypass: true,
    writeMode: "sidecar",
    queueNewImportWriteMode,
    profileAutoAssign: false,
    instances: [],
    firstRun,
  };
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function importSelect(host: HTMLElement): HTMLSelectElement {
  const match = [...host.querySelectorAll("select")].find((item) =>
    [...item.options].some((option) => option.text === "Use Write finished files"),
  );
  if (!match) throw new Error("Missing import finish select");
  return match;
}

function houseSelect(host: HTMLElement): HTMLSelectElement {
  const match = [...host.querySelectorAll("select")].find((item) =>
    [...item.options].some((option) => option.text === "Direct write after integrity check"),
  );
  if (!match) throw new Error("Missing Write finished files select");
  return match;
}

describe("automatic import finish choice", () => {
  it("saves Direct write for new imports while Write finished files stays sidecar", async () => {
    let payload = settings(false, "sidecar");
    const saved: Array<Record<string, unknown>> = [];
    api.settings = async () => payload;
    api.saveSettings = async (body) => {
      saved.push(body);
      payload = { ...payload, ...(body as Partial<SettingsPayload>) };
    };
    api.playbackSettings = async () => {
      throw new Error("playback unused");
    };
    api.hardware = async () => ({ backend: "none", cuda: false, vaapi: false, av1: false, reason: null });
    api.exclusions = async () => ({ exclusions: [] });
    api.nodes = async () => ({ nodes: [], defaultEncodeNodeId: "", thisNodeId: "local" });

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(SettingsPage, { firstRun, onChange: () => undefined }));
    });

    expect(importSelect(host).disabled).toBe(true);
    expect(importSelect(host).value).toBe("sidecar");
    expect(houseSelect(host).value).toBe("sidecar");
    expect(host.textContent).toContain("Queue new Arr imports uses the choice under that checkbox");

    const box = [...host.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("Queue new Arr imports automatically"),
    )?.querySelector("input");
    if (!box) throw new Error("Missing automatic import checkbox");
    await act(async () => {
      box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(importSelect(host).disabled).toBe(false);
    expect(importSelect(host).value).toBe("sidecar");

    const select = importSelect(host);
    await act(async () => {
      select.value = "direct";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(importSelect(host).value).toBe("direct");

    const save = [...host.querySelectorAll("button")].find((item) => item.textContent === "Save suggestion defaults");
    if (!save) throw new Error("Missing Save suggestion defaults");
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.writeMode).toBe("sidecar");
    expect(saved[0]?.queueNewImportWriteMode).toBe("direct");
    expect((saved[0]?.suggestionDefaults as { queueNewImports: boolean }).queueNewImports).toBe(true);
    expect(importSelect(host).value).toBe("direct");
    expect(importSelect(host).disabled).toBe(false);
    expect(houseSelect(host).value).toBe("sidecar");
  });
});
