import { describe, expect, it } from "vitest";
import { parseRadarrMovies, parseRootFolders, parseSonarrEpisodes, refreshAndRenameArr } from "./arr.ts";

describe("Arr identity", () => {
  it("keeps Sonarr series id and episode file id separate from the episode id", () => {
    const episodes = parseSonarrEpisodes(
      [
        {
          id: 44,
          seriesId: 9,
          seasonNumber: 3,
          episodeNumber: 2,
          title: "The One",
          hasFile: true,
          episodeFile: { id: 77, path: "/mnt/nas/tv/show.s03e02.mkv", size: 1_000_000_000, quality: { quality: { name: "Bluray-1080p" } } },
        },
      ],
      "Ted Lasso",
      null,
      "HD",
      [],
    );
    expect(episodes[0]?.id).toBe(44);
    expect(episodes[0]?.seriesId).toBe(9);
    expect(episodes[0]?.episodeFileId).toBe(77);
  });

  it("skips an episode that has a file flag but no path", () => {
    const episodes = parseSonarrEpisodes(
      [{ id: 44, seriesId: 9, seasonNumber: 3, episodeNumber: 2, title: "The One", hasFile: true }],
      "Ted Lasso",
      null,
      "HD",
      [],
    );
    expect(episodes).toEqual([]);
  });

  it("skips a Radarr movie that has no media file yet", () => {
    const movies = parseRadarrMovies([
      { id: 1, title: "Moana", path: "/mnt/nas/Kids Movies/Moana (2026)", hasFile: false },
      {
        id: 2,
        title: "Cars 3",
        movieFile: { path: "/mnt/nas/Kids Movies/Cars 3.mkv", size: 2, quality: { quality: { name: "Bluray-1080p" } } },
      },
    ]);
    expect(movies.map((row) => row.title)).toEqual(["Cars 3"]);
    expect(movies[0]?.path).toBe("/mnt/nas/Kids Movies/Cars 3.mkv");
    expect(parseRadarrMovies([{
      id: 2,
      title: "Cars 3",
      tmdbId: 260514,
      titleSlug: "cars-3-260514",
      movieFile: { path: "/mnt/nas/Kids Movies/Cars 3.mkv", size: 2, quality: { quality: { name: "Bluray-1080p" } } },
    }])[0]).toMatchObject({ tmdbId: 260514, titleSlug: "cars-3-260514" });
  });

  it("skips a Radarr movieFile path that is a folder instead of a media file", () => {
    const movies = parseRadarrMovies([
      {
        id: 241,
        title: "John Wick: Chapter 3 - Parabellum",
        hasFile: true,
        movieFile: { path: "/mnt/nas/Movies/John Wick Chapter 3 - Parabellum (2019)", size: 0 },
      },
    ]);
    expect(movies).toEqual([]);
  });

  it("prefers the Arr-hosted poster path over an external remote URL", () => {
    const movies = parseRadarrMovies([{
      id: 1,
      title: "Film",
      movieFile: { path: "/movies/film.mkv", size: 1 },
      images: [{ coverType: "poster", url: "/MediaCover/1/poster.jpg", remoteUrl: "https://cdn.example/poster.jpg" }],
    }]);

    expect(movies[0]?.posterUrl).toBe("/MediaCover/1/poster.jpg");
  });

  it("parses authoritative Arr library roots", () => {
    expect(parseRootFolders([{ id: 1, path: "/mnt/nas/movies" }, { id: 2, path: "/mnt/nas/uhd" }])).toEqual([
      "/mnt/nas/movies",
      "/mnt/nas/uhd",
    ]);
  });

  it("refreshes a Radarr movie then asks it to rename when the preview has a new path", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const oldPath = "/movies/Film [H264 EAC3 5.1].mkv";
    const newPath = "/movies/Film [HEVC AAC 2.0].mkv";
    const result = await refreshAndRenameArr({
      kind: "radarr",
      url: "http://radarr:7878",
      apiKey: "k",
      movieId: 10,
      currentPath: oldPath,
      fetch: (async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
        calls.push({ method, url, body });
        if (method === "POST" && url.endsWith("/api/v3/command")) {
          return new Response(JSON.stringify({ id: 1, status: "completed" }), { status: 201 });
        }
        if (url.includes("/api/v3/rename?")) {
          return new Response(JSON.stringify([
            { movieId: 10, movieFileId: 55, existingPath: oldPath, newPath },
          ]));
        }
        if (url.endsWith("/api/v3/movie/10")) {
          return new Response(JSON.stringify({ movieFile: { id: 55, path: newPath } }));
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.path).toBe(newPath);
    expect(result.warning).toBeNull();
    expect(calls[0]).toMatchObject({ method: "POST", body: { name: "RefreshMovie", movieIds: [10] } });
    expect(calls.some((call) => call.url.includes("/api/v3/rename?movieId=10"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && (call.body as { name?: string })?.name === "RenameFiles")).toBe(true);
  });

  it("refreshes a Sonarr series then renames the episode file", async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    const oldPath = "/tv/Paw Patrol - S01E05 [WEBRip-1080p EAC3 5.1 Sonarr].mkv";
    const newPath = "/tv/Paw Patrol - S01E05 [WEBRip-1080p AAC 2.0 Sonarr].mkv";
    const result = await refreshAndRenameArr({
      kind: "sonarr",
      url: "http://sonarr:8989",
      apiKey: "k",
      seriesId: 42,
      episodeFileId: 77,
      currentPath: oldPath,
      fetch: (async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
        calls.push({ method, body });
        if (method === "POST" && url.endsWith("/api/v3/command")) {
          return new Response(JSON.stringify({ id: 8, status: "completed" }), { status: 201 });
        }
        if (url.includes("/api/v3/rename?")) {
          return new Response(JSON.stringify([
            { seriesId: 42, episodeFileId: 77, existingPath: oldPath, newPath },
          ]));
        }
        if (url.endsWith("/api/v3/episodefile/77")) {
          return new Response(JSON.stringify({ id: 77, path: newPath }));
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.path).toBe(newPath);
    expect(calls[0]?.body).toEqual({ name: "RefreshSeries", seriesId: 42 });
    expect(calls.some((call) => call.method === "POST" && (call.body as { name?: string; files?: number[] })?.name === "RenameFiles"
      && (call.body as { files?: number[] }).files?.[0] === 77)).toBe(true);
  });

  it("skips rename when the Arr refresh already matches the filename", async () => {
    const names: string[] = [];
    const result = await refreshAndRenameArr({
      kind: "radarr",
      url: "http://radarr",
      apiKey: "k",
      movieId: 10,
      currentPath: "/movies/Film.mkv",
      fetch: (async (input, init) => {
        const url = String(input);
        if ((init?.method ?? "GET") === "POST") {
          names.push(JSON.parse(String(init?.body)).name as string);
          return new Response(JSON.stringify({ id: 1, status: "completed" }), { status: 201 });
        }
        if (url.includes("/rename")) return new Response("[]");
        return new Response("{}");
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.path).toBeNull();
    expect(result.warning).toBeNull();
    expect(names).toEqual(["RefreshMovie"]);
  });

  it("leaves the new file in place when Arr refresh fails", async () => {
    const result = await refreshAndRenameArr({
      kind: "sonarr",
      url: "http://sonarr",
      apiKey: "k",
      seriesId: 42,
      currentPath: "/tv/show.mkv",
      fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.path).toBeNull();
    expect(result.warning).toMatch(/HTTP 500/);
  });
});
