// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SuggestionRow } from "../api";
import { SuggestionsPage } from "./Suggestions.tsx";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function suggestionRow(id: string, title: string): SuggestionRow {
  return {
    id,
    itemId: id,
    displayTitle: title,
    reasons: ["Over the size cap."],
    warning: null,
    estimatedSavingsBytes: 1_000,
    now: { codec: "h264", quality: "HD", sizeBytes: 1_000, sizePerHourGb: 2, tracks: [] },
    after: { codec: "hevc", quality: "HD", sizeBytes: 500, sizePerHourGb: 1, tracks: [] },
  };
}

const queueFiltered = vi.fn(async () => ({ queued: 10, skipped: 0 }));
const queueSelected = vi.fn(async () => ({ queued: 1, skipped: 0 }));

afterEach(() => {
  document.body.replaceChildren();
  queueFiltered.mockClear();
  queueSelected.mockClear();
});

async function renderPage(): Promise<HTMLElement> {
  api.nodes = async () => ({ nodes: [], defaultEncodeNodeId: "", thisNodeId: "local" });
  api.suggestions = async () => ({
    items: [suggestionRow("a", "Alpha"), suggestionRow("b", "Bravo"), suggestionRow("c", "Charlie")],
    nextOffset: null,
    total: 12,
  });
  api.queueFiltered = queueFiltered;
  api.queueSelected = queueSelected;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(SuggestionsPage)));
  });
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!match) throw new Error(`Missing button ${label}`);
  return match as HTMLButtonElement;
}

describe("Suggestions batch queue", () => {
  it("queues the next 10 in the current sort", async () => {
    const host = await renderPage();
    await act(async () => {
      button(host, "Queue next 10").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(queueFiltered).toHaveBeenCalledTimes(1);
    expect(queueFiltered).toHaveBeenCalledWith("", {}, undefined, { sort: "title", limit: 10 });
    expect(queueSelected).not.toHaveBeenCalled();
  });

  it("asks before queueing every suggestion in the current list", async () => {
    const host = await renderPage();
    await act(async () => {
      button(host, "Queue all (12)").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("Queue all 12 suggestions?");
    expect(queueFiltered).not.toHaveBeenCalled();
    await act(async () => {
      button(host, "Queue all").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(queueFiltered).toHaveBeenCalledTimes(1);
    expect(queueFiltered).toHaveBeenCalledWith("", {}, undefined, { sort: "title" });
  });

  it("shift-click checks a range and queues those rows in one request", async () => {
    const host = await renderPage();
    const boxes = [...host.querySelectorAll("tbody input[type=checkbox]")] as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    await act(async () => {
      boxes[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      boxes[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    await act(async () => {
      button(host, "Queue selected (3)").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(queueSelected).toHaveBeenCalledTimes(1);
    expect(queueSelected).toHaveBeenCalledWith(["a", "b", "c"], undefined);
    expect(queueFiltered).not.toHaveBeenCalled();
  });
});
