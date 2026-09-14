// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ReviewRow } from "../api";
import { ReviewPage } from "./Review.tsx";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function reviewRow(partial: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: "rev-1",
    displayTitle: "Film",
    status: "pending",
    flagged: false,
    flagReason: null,
    source: { codec: "h264", sizeBytes: 10, sizePerHourGb: 1, durationSec: 120, tracks: "1 audio / 0 subtitles" },
    sidecar: { codec: "hevc", sizeBytes: 5, sizePerHourGb: 0.5, durationSec: 120, tracks: "1 audio / 0 subtitles" },
    error: null,
    ...partial,
  };
}

const requestReviewPreview = vi.fn(async () => ({
  id: "prv-1",
  reviewId: "rev-1",
  status: "queued" as const,
  waitReason: null,
  nodeId: null,
  nodeName: null,
  error: null,
  interval: { startMs: 12_000, durationMs: 15_000 },
  tracks: { originalAudioIndex: null, sidecarAudioIndex: null },
  clips: null,
  transform: null,
}));
const reviewPreviewStatus = vi.fn(async () => ({
  id: "prv-1",
  reviewId: "rev-1",
  status: "queued" as const,
  waitReason: null,
  nodeId: null,
  nodeName: null,
  error: null,
  interval: { startMs: 12_000, durationMs: 15_000 },
  tracks: { originalAudioIndex: null, sidecarAudioIndex: null },
  clips: null,
  transform: null,
}));

afterEach(() => {
  document.body.replaceChildren();
  requestReviewPreview.mockClear();
  reviewPreviewStatus.mockClear();
});

describe("Review page compare entry", () => {
  it("does not request a preview when Review or Compare clips opens", async () => {
    api.review = async () => ({ items: [reviewRow(), reviewRow({ id: "rev-2", status: "waiting" })], nextOffset: null, total: 2, pendingCount: 1 });
    api.requestReviewPreview = requestReviewPreview;
    api.reviewPreviewStatus = reviewPreviewStatus;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(ReviewPage));
    });
    expect(host.textContent).toContain("Compare clips");
    expect(host.textContent).toContain("Film");
    expect(requestReviewPreview).not.toHaveBeenCalled();
    expect(reviewPreviewStatus).not.toHaveBeenCalled();

    const compareButtons = [...host.querySelectorAll("button")].filter((button) => button.textContent === "Compare clips");
    expect(compareButtons).toHaveLength(2);
    await act(async () => {
      compareButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("Pick a sample to generate matching clips");
    expect(host.textContent).toContain("10%");
    expect(requestReviewPreview).not.toHaveBeenCalled();
    expect(reviewPreviewStatus).not.toHaveBeenCalled();

    const tenPercent = [...host.querySelectorAll("button")].find((button) => button.textContent === "10%");
    await act(async () => {
      tenPercent?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(requestReviewPreview).toHaveBeenCalledTimes(1);
    expect(requestReviewPreview).toHaveBeenCalledWith("rev-1", expect.objectContaining({
      startMs: 12_000,
      durationMs: 15_000,
      preset: "custom",
    }));
    await act(async () => {
      root.unmount();
    });
  });
});
