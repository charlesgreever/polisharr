import { describe, expect, it } from "vitest";
import { loadedSelection, queueAllConfirmCopy, queueBatchCopy, selectLoaded, suggestionViewIsFiltered, toggleRange } from "./suggestion-selection.ts";

describe("suggestion selection", () => {
  it("checks the inclusive shift range and leaves rows outside it", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const next = toggleRange(ids, { a: true }, "b", "f", true);
    expect(next).toEqual({ a: true, b: true, c: true, d: true, e: true, f: true });
    expect(toggleRange(ids, next, "b", "d", false)).toEqual({ a: true, e: true, f: true });
  });

  it("reports whether every loaded row is checked", () => {
    expect(loadedSelection(["a", "b"], {})).toBe("none");
    expect(loadedSelection(["a", "b"], { a: true })).toBe("some");
    expect(loadedSelection(["a", "b"], { a: true, b: true })).toBe("all");
    expect(selectLoaded(["a", "b"], { c: true }, true)).toEqual({ c: true, a: true, b: true });
    expect(selectLoaded(["a", "b"], { a: true, b: true, c: true }, false)).toEqual({ c: true });
  });

  it("names the queue-all confirm and the batch result", () => {
    expect(queueAllConfirmCopy(1, false)).toBe(
      "Queue all 1 suggestion? This adds them to the queue. Titles already queued or in Review are skipped. The library file stays until Keep.",
    );
    expect(queueAllConfirmCopy(12, true)).toBe(
      "Queue all 12 suggestions? This adds them to the queue. Titles already queued or in Review are skipped. The library file stays until Keep. Only suggestions that match the current search and filters are included.",
    );
    expect(queueBatchCopy(10, 0)).toBe("Queued 10.");
    expect(queueBatchCopy(10, 1)).toBe("Queued 10. Skipped 1.");
    expect(suggestionViewIsFiltered("", {})).toBe(false);
    expect(suggestionViewIsFiltered("film", {})).toBe(true);
    expect(suggestionViewIsFiltered("", { overCap: true })).toBe(true);
  });
});
