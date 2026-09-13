import { describe, expect, it } from "vitest";
import { jellyfinAuthHeaders, notifyPlayers, testJellyfin } from "./notify.ts";

describe("Jellyfin auth", () => {
  it("sends the Jellyfin 12 Authorization scheme and the older token header", () => {
    const headers = jellyfinAuthHeaders("secret-token");
    expect(headers["X-Emby-Token"]).toBe("secret-token");
    expect(headers.Authorization).toContain('Token="secret-token"');
    expect(headers.Authorization.startsWith("MediaBrowser ")).toBe(true);
  });

  it("uses that header when testing Jellyfin and when Keep asks it to refresh", async () => {
    const seen: Array<{ url: string; headers: HeadersInit | undefined; method?: string }> = [];
    const httpFetch = (async (url, init) => {
      seen.push({ url: String(url), headers: init?.headers, method: init?.method });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await testJellyfin("http://jellyfin:8096", "t1", httpFetch);
    await notifyPlayers([{ kind: "jellyfin", url: "http://jellyfin:8096", token: "t2" }], httpFetch);
    const testCall = seen.find((call) => call.url.endsWith("/System/Info"));
    const refresh = seen.find((call) => call.url.endsWith("/Library/Refresh"));
    const testHeaders = testCall?.headers as Record<string, string>;
    const refreshHeaders = refresh?.headers as Record<string, string>;
    expect(testHeaders["X-Emby-Token"]).toBe("t1");
    expect(testHeaders.Authorization).toContain('Token="t1"');
    expect(refresh?.method).toBe("POST");
    expect(refreshHeaders["X-Emby-Token"]).toBe("t2");
    expect(refreshHeaders.Authorization).toContain('Token="t2"');
  });
});
