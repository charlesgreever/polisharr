import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EncodeTargetSelect } from "./EncodeTargetSelect";

describe("encode target select", () => {
  it("names the house default after the current Settings target", () => {
    const html = renderToStaticMarkup(createElement(EncodeTargetSelect, {
      value: null,
      houseTarget: "hevc",
      av1Available: true,
      onChange: () => undefined,
    }));
    expect(html).toContain("Encode target");
    expect(html).toContain("House default (HEVC)");
    expect(html).toContain("AV1");
  });

  it("keeps a saved AV1 choice visible when the GPU no longer lists AV1", () => {
    const html = renderToStaticMarkup(createElement(EncodeTargetSelect, {
      value: "av1",
      houseTarget: "hevc",
      av1Available: false,
      onChange: () => undefined,
    }));
    expect(html).toContain("AV1");
    expect(html).toContain("value=\"av1\"");
  });

  it("keeps the accessible name when the visible label is hidden", () => {
    const html = renderToStaticMarkup(createElement(EncodeTargetSelect, {
      value: null,
      houseTarget: "hevc",
      av1Available: false,
      showLabel: false,
      onChange: () => undefined,
    }));
    expect(html).toContain("aria-label=\"Encode target\"");
    expect(html).not.toContain(">Encode target<");
    expect(html).toContain("House default (HEVC)");
  });
});
