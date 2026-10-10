import { describe, expect, it } from "vitest";
import {
  arrLinkForLibraryItem,
  jellyfinDetailsHref,
  lookupJellyfinLink,
  lookupPlexLink,
  plexDetailsHref,
  radarrMovieHref,
  sonarrSeriesHref,
} from "./external-links.ts";

describe("Arr web links", () => {
  it("opens a Radarr movie by title slug and strips a trailing slash on the instance URL", () => {
    expect(radarrMovieHref("http://192.168.1.10:7878/", 438631, "dune-part-two-438631")).toBe(
      "http://192.168.1.10:7878/movie/dune-part-two-438631",
    );
    expect(radarrMovieHref("http://192.168.1.10:7878/", 13187, "13187")).toBe(
      "http://192.168.1.10:7878/movie/13187",
    );
  });

  it("falls back to the TMDB id and omits a link when Radarr sent no slug", () => {
    expect(radarrMovieHref("http://radarr:7878", 438631, "")).toBe("http://radarr:7878/movie/438631");
    expect(radarrMovieHref("http://radarr:7878", 0, "")).toBeNull();
  });

  it("opens a Sonarr series by name slug, not the TVDB id", () => {
    expect(sonarrSeriesHref("http://192.168.1.10:8989", 71470, "star-trek-the-next-generation")).toBe(
      "http://192.168.1.10:8989/series/star-trek-the-next-generation",
    );
    expect(sonarrSeriesHref("http://192.168.1.10:8989", 71470, null)).toBeNull();
  });

  it("labels movie links Radarr and episode links Sonarr, and never uses the internal Arr id", () => {
    expect(arrLinkForLibraryItem({
      type: "movie",
      instanceKind: "radarr",
      instanceUrl: "http://radarr:7878",
      tmdbId: 11,
    })).toEqual({ label: "Open in Radarr", href: "http://radarr:7878/movie/11" });
    expect(arrLinkForLibraryItem({
      type: "episode",
      instanceKind: "sonarr",
      instanceUrl: "http://sonarr:8989",
      tvdbId: 71470,
      titleSlug: "star-trek-the-next-generation",
    })).toEqual({ label: "Open in Sonarr", href: "http://sonarr:8989/series/star-trek-the-next-generation" });
    expect(arrLinkForLibraryItem({
      type: "movie",
      instanceKind: "radarr",
      instanceUrl: "http://radarr:7878",
    })).toBeNull();
  });
});

describe("Plex and Jellyfin web links", () => {
  it("builds a Plex details URL from the server id and rating key", () => {
    expect(plexDetailsHref("http://192.168.1.10:32400", "abc", "56")).toBe(
      "http://192.168.1.10:32400/web/index.html#!/server/abc/details?key=%2Flibrary%2Fmetadata%2F56",
    );
  });

  it("builds a Jellyfin details URL", () => {
    expect(jellyfinDetailsHref("http://192.168.100.11:8096/", "item-9")).toBe(
      "http://192.168.100.11:8096/web/#/details?id=item-9",
    );
  });

  it("looks up a Plex rating key by file path", async () => {
    const httpFetch = (async (url) => {
      const href = String(url);
      if (href.endsWith("/identity")) {
        return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: "machine-1" } }));
      }
      if (href.includes("/library/all")) {
        return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "99" }] } }));
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const link = await lookupPlexLink("http://plex:32400", "tok", "/mnt/nas/Movies/film.mkv", httpFetch);
    expect(link).toEqual({
      label: "Open in Plex",
      href: "http://plex:32400/web/index.html#!/server/machine-1/details?key=%2Flibrary%2Fmetadata%2F99",
    });
  });

  const filmPath = "/mnt/nas/Movies/1917 (2019)/1917 (2019) {imdb-tt8579674}[Bluray-2160p][HDR][10bit][x265][TrueHD Atmos 7.1].mkv";

  it("opens a Jellyfin movie when the item path is the library file", async () => {
    const seen: string[] = [];
    const httpFetch = (async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({
        Items: [{ Id: "jf-1917", Path: filmPath }],
        TotalRecordCount: 1,
      }));
    }) as typeof fetch;
    const link = await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "movie",
      title: "1917",
      path: filmPath,
    }, httpFetch);
    expect(link).toEqual({ label: "Open in Jellyfin", href: "http://jellyfin:8096/web/#/details?id=jf-1917" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("searchTerm=1917");
    expect(seen[0]).toContain("includeItemTypes=Movie");
    expect(seen[0]).not.toContain("Bluray-2160p");
    expect(seen[0]).not.toContain("tok");
  });

  it("omits Jellyfin when the path is a different file with the same name", async () => {
    const httpFetch = (async () => new Response(JSON.stringify({
      Items: [{ Id: "other", Path: `/mnt/other/${filmPath.split("/").pop()}` }],
      TotalRecordCount: 1,
    }))) as typeof fetch;
    expect(await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "movie",
      title: "1917",
      path: filmPath,
    }, httpFetch)).toBeNull();
  });

  it("opens a Jellyfin episode from the episode title", async () => {
    const seen: string[] = [];
    const path = "/mnt/nas/TV/Stick/Stick - S01E01 - Pilot.mkv";
    const httpFetch = (async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({
        Items: [{ Id: "ep-1", Path: path }],
        TotalRecordCount: 1,
      }));
    }) as typeof fetch;
    const link = await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "episode",
      title: "Stick",
      episodeTitle: "Pilot",
      path,
    }, httpFetch);
    expect(link).toEqual({ label: "Open in Jellyfin", href: "http://jellyfin:8096/web/#/details?id=ep-1" });
    expect(seen[0]).toContain("searchTerm=Pilot");
    expect(seen[0]).toContain("includeItemTypes=Episode");
    expect(seen[0]).not.toContain("searchTerm=Stick");
  });

  it("reads a second Jellyfin page when the file is not on the first", async () => {
    const seen: string[] = [];
    const path = "/mnt/nas/TV/Show/Show - S01E01 - Pilot.mkv";
    const httpFetch = (async (url) => {
      seen.push(String(url));
      const body = seen.length === 1
        ? { Items: [{ Id: "other", Path: "/mnt/nas/TV/Other/Other - S01E01 - Pilot.mkv" }], TotalRecordCount: 60 }
        : { Items: [{ Id: "ep-2", Path: path }], TotalRecordCount: 60 };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const link = await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "episode",
      title: "Show",
      episodeTitle: "Pilot",
      path,
    }, httpFetch);
    expect(link).toEqual({ label: "Open in Jellyfin", href: "http://jellyfin:8096/web/#/details?id=ep-2" });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("startIndex=50");
  });

  it("omits Jellyfin when the second page still misses the file and when Jellyfin returns 401", async () => {
    const missed = (async () => new Response(JSON.stringify({
      Items: [{ Id: "other", Path: "/mnt/nas/TV/Other/Pilot.mkv" }],
      TotalRecordCount: 60,
    }))) as typeof fetch;
    expect(await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "episode",
      title: "Show",
      episodeTitle: "Pilot",
      path: "/mnt/nas/TV/Show/Show - S01E01 - Pilot.mkv",
    }, missed)).toBeNull();
    const denied = (async () => new Response("no", { status: 401 })) as typeof fetch;
    expect(await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "movie",
      title: "1917",
      path: filmPath,
    }, denied)).toBeNull();
  });

  it("searches a Jellyfin episode by the show title when the episode title is blank", async () => {
    const seen: string[] = [];
    const path = "/mnt/nas/TV/Stick/Stick - S01E01.mkv";
    const httpFetch = (async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({
        Items: [{ Id: "ep-3", Path: path }],
        TotalRecordCount: 1,
      }));
    }) as typeof fetch;
    const link = await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "episode",
      title: "Stick",
      episodeTitle: " ",
      path,
    }, httpFetch);
    expect(link).toEqual({ label: "Open in Jellyfin", href: "http://jellyfin:8096/web/#/details?id=ep-3" });
    expect(seen[0]).toContain("searchTerm=Stick");
    expect(seen[0]).toContain("includeItemTypes=Episode");
  });

  it("omits Jellyfin when the movie title is blank", async () => {
    let called = false;
    const httpFetch = (async () => {
      called = true;
      return new Response("no", { status: 500 });
    }) as typeof fetch;
    expect(await lookupJellyfinLink("http://jellyfin:8096", "tok", {
      type: "movie",
      title: " ",
      path: filmPath,
    }, httpFetch)).toBeNull();
    expect(called).toBe(false);
  });
});
