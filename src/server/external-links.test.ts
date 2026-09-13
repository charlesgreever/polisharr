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
  it("opens a Radarr movie by TMDB id and strips a trailing slash on the instance URL", () => {
    expect(radarrMovieHref("http://192.168.1.10:7878/", 438631, "dune-part-two-438631")).toBe(
      "http://192.168.1.10:7878/movie/438631",
    );
  });

  it("falls back to the title slug and omits a link when Radarr sent no ids", () => {
    expect(radarrMovieHref("http://radarr:7878", null, "dune-part-two-438631")).toBe(
      "http://radarr:7878/movie/dune-part-two-438631",
    );
    expect(radarrMovieHref("http://radarr:7878", 0, "")).toBeNull();
  });

  it("opens a Sonarr series by TVDB id", () => {
    expect(sonarrSeriesHref("http://192.168.1.10:8989", 71470, "star-trek-the-next-generation-71470")).toBe(
      "http://192.168.1.10:8989/series/71470",
    );
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
    })).toEqual({ label: "Open in Sonarr", href: "http://sonarr:8989/series/71470" });
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

  it("looks up a Jellyfin item by file name and omits the link on 401", async () => {
    const okFetch = (async () => new Response(JSON.stringify({
      Items: [{ Id: "jf-1", Path: "/mnt/nas/Movies/film.mkv" }],
    }))) as typeof fetch;
    const link = await lookupJellyfinLink("http://jellyfin:8096", "tok", "/mnt/nas/Movies/film.mkv", okFetch);
    expect(link).toEqual({ label: "Open in Jellyfin", href: "http://jellyfin:8096/web/#/details?id=jf-1" });
    const denied = (async () => new Response("no", { status: 401 })) as typeof fetch;
    expect(await lookupJellyfinLink("http://jellyfin:8096", "tok", "/mnt/nas/Movies/film.mkv", denied)).toBeNull();
  });
});
