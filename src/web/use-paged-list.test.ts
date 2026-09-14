// @vitest-environment happy-dom
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { usePagedList } from "./use-paged-list.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("usePagedList", () => {
  it("loads its first page after the Strict Mode effect replay", async () => {
    function List() {
      const list = usePagedList({
        loadPage: async () => ({ items: [{ id: "one" }], nextOffset: null, total: 1 }),
        keyOf: (row) => row.id,
      });
      return createElement("p", null, list.loading ? "Loading" : list.items.map((row) => row.id).join(","));
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(List)));
    });

    expect(container.textContent).toBe("one");
    act(() => root.unmount());
  });

  it("reloads already opened pages after a row action without dropping later pages", async () => {
    const pages: Record<number, Array<{ id: string }>> = {
      0: [{ id: "a" }, { id: "b" }],
      2: [{ id: "c" }],
    };
    let loaded = 0;
    function List() {
      const list = usePagedList({
        loadPage: async (offset, limit) => {
          loaded += 1;
          const items = pages[offset] ?? [];
          return { items, nextOffset: offset + limit < 3 ? offset + limit : null, total: 3 };
        },
        keyOf: (row) => row.id,
        pageSize: 2,
      });
      return createElement("div", null,
        createElement("p", null, list.items.map((row) => row.id).join(",")),
        createElement("button", { type: "button", onClick: () => void list.loadMore() }, "more"),
        createElement("button", { type: "button", onClick: () => void list.refresh() }, "refresh"),
      );
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(List)));
    });
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("p")?.textContent).toBe("a,b,c");
    pages[0] = [{ id: "b" }, { id: "d" }];
    pages[2] = [{ id: "c" }];
    const before = loaded;
    await act(async () => {
      container.querySelectorAll("button")[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(loaded).toBeGreaterThan(before);
    expect(container.querySelector("p")?.textContent).toBe("b,d,c");
    act(() => root.unmount());
  });
});
