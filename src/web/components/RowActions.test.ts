// @vitest-environment happy-dom
import { createElement, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type LibraryRow } from "../api";
import { RowActions } from "./RowActions";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function row(): LibraryRow {
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
    audioLabels: ["eng truehd 7.1"],
    subtitleLabels: [],
  };
}

function mount(ui: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MemoryRouter, null, ui));
  });
  return { host, root };
}

function buttonNamed(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!button) throw new Error(`Missing ${label}`);
  return button;
}

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("row action results", () => {
  it("shows a failed queue in the error style", async () => {
    let rejectQueue: (error: Error) => void = () => {};
    vi.spyOn(api, "queue").mockImplementation(() => new Promise((_resolve, reject) => {
      rejectQueue = reject;
    }));
    const { host, root } = mount(createElement(RowActions, { item: row(), onDone: () => {} }));
    roots.push(root);
    await act(async () => {
      buttonNamed(host, "Queue").click();
    });
    await act(async () => {
      rejectQueue(new Error("The queue rejected this title."));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector(".form-error")?.textContent).toBe("The queue rejected this title.");
    expect(host.querySelector(".ok")).toBeNull();
  });

  it("shows a queued title in the success style", async () => {
    let resolveQueue: (value: unknown) => void = () => {};
    vi.spyOn(api, "queue").mockImplementation(() => new Promise((resolve) => {
      resolveQueue = resolve;
    }));
    const { host, root } = mount(createElement(RowActions, { item: row(), onDone: () => {} }));
    roots.push(root);
    await act(async () => {
      buttonNamed(host, "Queue").click();
    });
    await act(async () => {
      resolveQueue({});
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector(".ok")?.textContent).toBe("Added to queue.");
    expect(host.querySelector(".form-error")).toBeNull();
  });
});
