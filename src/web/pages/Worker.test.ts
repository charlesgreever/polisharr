import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { safeHttpUrl, WorkerPage } from "./Worker";

describe("worker stub page", () => {
  it("names the master and hardware without a library nav", () => {
    const html = renderToStaticMarkup(createElement(WorkerPage));
    expect(html).toContain("WORKER");
    expect(html).toContain("This Polisharr only runs encodes");
    expect(html).not.toContain("href=\"/queue\"");
    expect(html).not.toContain("href=\"/settings\"");
  });

  it("only links http master URLs", () => {
    expect(safeHttpUrl("http://192.168.1.10:7373")).toBe("http://192.168.1.10:7373/");
    expect(safeHttpUrl("https://polisharr.example")).toBe("https://polisharr.example/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });
});
