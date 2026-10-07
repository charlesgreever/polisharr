// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { api, type AlertSettings, type SettingsPayload } from "../api";
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

const alerts: AlertSettings = {
  reviewReady: true,
  stillWaiting: true,
  jobFailed: true,
  directWrite: true,
  replaceWaiting: true,
  quietEnabled: false,
  quietStart: "23:00",
  quietEnd: "07:00",
  reminderTime: "08:00",
  reviewUrl: "",
  digestMinutes: 15,
  smtpHost: "",
  smtpPort: 587,
  smtpSecurity: "starttls",
  smtpUsername: "",
  smtpFrom: "",
  smtpTo: "",
  hasWebhookUrl: false,
  hasWebhookToken: false,
  hasSmtpPassword: false,
  hasDiscordWebhook: false,
  lastError: null,
};

function settings(name = "Greever Radarr"): SettingsPayload {
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
      queueNewImports: false,
    },
    videoTarget: "hevc",
    concurrency: 1,
    conservativeMode: false,
    offPeakEnabled: false,
    offPeakStart: "01:00",
    offPeakEnd: "08:00",
    localAuthBypass: true,
    writeMode: "sidecar",
    queueNewImportWriteMode: "sidecar",
    profileAutoAssign: false,
    instances: [{
      id: "radarr-1",
      kind: "radarr",
      name,
      url: "http://radarr.test",
      enabled: true,
      hasApiKey: true,
    }],
    firstRun,
    alerts,
  };
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function renderSettings() {
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
  return host;
}

function connectionRow(host: HTMLElement, name: string) {
  const row = [...host.querySelectorAll("li")].find((item) => item.textContent?.includes(name));
  if (!row) throw new Error(`Missing connection row for ${name}`);
  return row;
}

function textAfterAgent(host: HTMLElement) {
  const agent = host.querySelector("#agent");
  const parts: string[] = [];
  let sibling = agent?.nextElementSibling ?? null;
  while (sibling) {
    parts.push(sibling.textContent ?? "");
    sibling = sibling.nextElementSibling;
  }
  return parts.join("");
}

describe("settings action notes", () => {
  it("shows a successful connection test on that connection", async () => {
    api.settings = async () => settings();
    api.testInstance = async () => ({ ok: true });
    const host = await renderSettings();
    const row = connectionRow(host, "Greever Radarr");
    const test = [...row.querySelectorAll("button")].find((button) => button.textContent === "Test");
    if (!test) throw new Error("Missing Test button");
    await act(async () => {
      test.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(row.textContent).toContain("Greever Radarr is reachable.");
    expect(row.querySelector(".form-error")).toBeNull();
    expect(row.querySelector(".ok")?.textContent).toContain("Greever Radarr is reachable.");
    expect(textAfterAgent(host)).not.toContain("Greever Radarr is reachable.");
  });

  it("shows a failed connection test as an error on that connection", async () => {
    api.settings = async () => settings("Living Room Sonarr");
    api.testInstance = async () => ({ ok: false, message: "Sonarr refused the key." });
    const host = await renderSettings();
    const row = connectionRow(host, "Living Room Sonarr");
    const test = [...row.querySelectorAll("button")].find((button) => button.textContent === "Test");
    if (!test) throw new Error("Missing Test button");
    await act(async () => {
      test.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const error = row.querySelector(".form-error");
    expect(error?.textContent).toContain("Sonarr refused the key.");
    expect(error?.className).not.toContain("ok");
    expect(row.querySelector(".ok")).toBeNull();
    expect(textAfterAgent(host)).not.toContain("Sonarr refused the key.");
  });
});
