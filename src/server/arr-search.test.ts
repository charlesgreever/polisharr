import { describe, expect, it } from "vitest";
import { deleteArrFileAndSearch, isArrSearchOnly, soleNonPreferredAudio } from "./arr-search.ts";

describe("preferred-language Arr search", () => {
  it("detects a single non-preferred soundtrack and ignores und and mixed files", () => {
    expect(soleNonPreferredAudio([
      { index: 1, language: "deu", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
    ], "eng")).toBe(true);
    expect(soleNonPreferredAudio([
      { index: 1, language: "und", channels: 6, codec: "ac3", title: "", untagged: true, commentary: false },
    ], "eng")).toBe(false);
    expect(soleNonPreferredAudio([
      { index: 1, language: "eng", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
    ], "eng")).toBe(false);
    expect(soleNonPreferredAudio([
      { index: 1, language: "deu", channels: 6, codec: "ac3", title: "", untagged: false, commentary: false },
      { index: 2, language: "eng", channels: 2, codec: "aac", title: "", untagged: false, commentary: false },
    ], "eng")).toBe(false);
    expect(isArrSearchOnly(["search_release"])).toBe(true);
    expect(isArrSearchOnly(["search_language"])).toBe(true);
    expect(isArrSearchOnly(["search_release", "add_stereo"])).toBe(false);
  });

  it("deletes the Radarr file then starts a search", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const result = await deleteArrFileAndSearch({
      kind: "radarr",
      url: "http://radarr",
      apiKey: "k",
      arrId: 10,
      episodeFileId: null,
    }, (async (url, init) => {
      calls.push({ method: String(init?.method ?? "GET"), url: String(url) });
      if (String(url).endsWith("/movie/10")) {
        return new Response(JSON.stringify({ id: 10, movieFile: { id: 77, path: "/media/film.mkv" } }));
      }
      return new Response("{}", { status: 201 });
    }) as typeof fetch);
    expect(result).toEqual({ ok: true });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://radarr/api/v3/movie/10",
      "DELETE http://radarr/api/v3/moviefile/77",
      "POST http://radarr/api/v3/command",
    ]);
  });

  it("leaves the file in place when Radarr cannot delete it", async () => {
    const calls: string[] = [];
    const result = await deleteArrFileAndSearch({
      kind: "sonarr",
      url: "http://sonarr",
      apiKey: "k",
      arrId: 44,
      episodeFileId: 77,
    }, (async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(init?.method) === "DELETE") return new Response("nope", { status: 500 });
      return new Response("{}", { status: 201 });
    }) as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unchanged/i);
    expect(calls.some((call) => call.includes("/command"))).toBe(false);
  });
});
