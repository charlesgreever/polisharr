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

function settings(): SettingsPayload {
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
    instances: [],
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

describe("notification settings", () => {
  it("saves a webhook address without showing it again", async () => {
    let payload = settings();
    const saved: Array<Record<string, unknown>> = [];
    api.settings = async () => payload;
    api.saveSettings = async (body) => {
      saved.push(body);
      const next = body.alerts as Partial<AlertSettings> | undefined;
      payload = {
        ...payload,
        alerts: {
          ...alerts,
          ...next,
          hasWebhookUrl: Boolean(next && "webhookUrl" in next && next.webhookUrl),
          hasWebhookToken: Boolean(next && "webhookToken" in next && next.webhookToken),
          lastError: null,
        },
      };
    };
    api.testAlert = async () => ({ ok: true });
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

    expect(host.textContent).toContain("A webhook is a web address that receives a message");
    const url = [...host.querySelectorAll("input")].find((input) => input.placeholder === "https://example.test/hook");
    const token = [...host.querySelectorAll("input")].find((input) => input.placeholder === "Optional");
    if (!url || !token) throw new Error("Missing webhook fields");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(url, "http://hooks.test/notify");
      url.dispatchEvent(new Event("input", { bubbles: true }));
      setValue?.call(token, "secret-token");
      token.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save notifications");
    if (!save) throw new Error("Missing save button");
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(saved[0]).toMatchObject({
      alerts: {
        webhookUrl: "http://hooks.test/notify",
        webhookToken: "secret-token",
        reviewReady: true,
      },
    });
    expect(host.textContent).toContain("Notifications saved.");
    expect(host.textContent).not.toContain("secret-token");
    expect(host.textContent).not.toContain("hooks.test");
  });
});
