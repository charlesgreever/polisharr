# Plan: Open this title in Radarr, Sonarr, Plex, and Jellyfin

Polisharr already stores the Arr movie id, series id, and episode file id, plus each instance URL. Title pages do not link out. Radarr and Sonarr UI routes use TMDB / TVDB slugs, not those internal ids. Plex and Jellyfin item ids are not stored at all.

## What exists today

- `LibraryItem`: `instanceId`, `arrId` (Radarr movie id or Sonarr episode id), `arrSeriesId`, `arrEpisodeFileId`, `path`.
- Instance URL and token live on Settings → Connections (Radarr, Sonarr, Plex, Jellyfin).
- Title page (`TitleFacts`) shows instance name, file name, and path. No outbound links.
- Series header shows instance name only.
- Library sync already downloads Radarr movie JSON and Sonarr series JSON; it currently keeps title, path, size, poster — not `tmdbId`, `tvdbId`, or `titleSlug`.
- Internal `href` already goes to `/movies/:id` or `/series/episodes/:id`. This plan adds **external** links only.

## Product locks

- Copy says **Open in Radarr**, **Open in Sonarr**, **Open in Plex**, **Open in Jellyfin**. Not “Arr”, not “player”.
- Links open in a new tab (`target="_blank"` `rel="noreferrer"`).
- Never put API keys or Plex tokens in the URL.
- Hide a link when it cannot be built. Do not show a 404 button.
- List pages (Movies table, Suggestions) stay quiet. Links live on the **title page** and the **series header**.
- Do not block the title page if Radarr or Plex is slow. Links are best-effort; omit on timeout or 401.
- Pinned Polisharr paths stay `/movies/:id`. External links are extra.

## Deep-link facts

**Radarr (v3+):** movie page is `/movie/{tmdbId}` or `/movie/{titleSlug}` (slug looks like `dune-part-two-693134`). Internal `arrId` in that path 404s.

**Sonarr (v3+):** series page is `/series/{tvdbId}` or `/series/{titleSlug}`. There is **no stable episode page**. Episode links go to the series (and optionally a season fragment if we confirm one).

**Plex web:** `{url}/web/index.html#!/server/{machineIdentifier}/details?key=/library/metadata/{ratingKey}`. Needs `machineIdentifier` from `GET /identity` and `ratingKey` from a library lookup. Path lookup works when Plex sees the same file path Polisharr stored (`/mnt/nas/...` on this household).

**Jellyfin web:** `{url}/web/#/details?id={itemId}` (10.x and still accepted). 12’s React UI also understands `/web/#/item?id={itemId}`. Lookup: `GET /Items?recursive=true&filters=IsNotFolder` with `Path` or a search on the file name. Same path-match caveat as Plex.

Plex/Jellyfin ids are **not** worth storing in SQLite (they change on library rebuild). Look them up when the title page loads.

## Phase 1: Open in Radarr / Sonarr

**Stories:** 173 (title), 173b (series header).

### What to build

- Parse `tmdbId`, `tvdbId`, `titleSlug` from the Arr payloads we already fetch (`parseRadarrMovies`, `parseSonarrSeries`).
- Store them on `library_items` as nullable columns. Backfill on the next library refresh. Until then, the title endpoint may `GET /api/v3/movie/{arrId}` or `/api/v3/series/{arrSeriesId}` once and build the link without waiting for a full sync.
- Pure builders in a small `external-links.ts`:
  - movie → `{trimUrl(radarrUrl)}/movie/{tmdbId}` (fallback `titleSlug`)
  - series / episode → `{trimUrl(sonarrUrl)}/series/{tvdbId}` (fallback `titleSlug`)
- `GET /api/library/items/:id` includes `links: Array<{ label: string; href: string }>`.
- Series summary payload includes the Sonarr series link when known.
- Title page: a row of text links under the facts. Series header: **Open in Sonarr** next to the instance name.

### Acceptance criteria

- [ ] A movie title page has **Open in Radarr** pointing at `/movie/{tmdbId}` on that instance’s URL
- [ ] An episode title page and the series header have **Open in Sonarr** pointing at `/series/{tvdbId}`
- [ ] No API key appears in the href
- [ ] Missing slug/ids omit the link instead of inventing `/movie/{arrId}`
- [ ] Builder tests cover Radarr movie, Sonarr series, trailing slash on instance URL, and “no id → no link”

## Phase 2: Open in Plex / Jellyfin

**Stories:** 174.

### What to build

- On title GET only (not Movies list), if a Plex or Jellyfin instance is enabled:
  - Plex: `GET /identity` for `machineIdentifier`; find the item by file path (or file name fallback); build the web details URL.
  - Jellyfin: find the item by `Path` (or Name + ProductionYear fallback); build `/web/#/details?id={id}` (works on 10 and 12).
- Append **Open in Plex** / **Open in Jellyfin** to the same `links` array.
- Cap lookup time (few seconds). Failure → omit that link.
- Path mismatch (container vs host) is expected in some installs: hide the player link rather than guess.

### Acceptance criteria

- [ ] When the Plex test double returns a matching `ratingKey`, the title payload includes Open in Plex with that metadata key
- [ ] When Jellyfin returns an item id for the path, the title payload includes Open in Jellyfin
- [ ] A 401 or timeout from Plex/Jellyfin leaves Arr links in place and omits the player link
- [ ] Movies list and Suggestions do not call Plex/Jellyfin

## Out of scope

- Deep links on every table row
- Infuse / Android `plex://` app URLs
- Storing Plex rating keys
- Changing Keep notify
- Linking to TMDB/IMDb themselves

## Notes

- Language: “Open in Radarr”, never “Open in the Arr”.
- After approval: `plans/external-media-links.md` and PRD 173 / 173b / 174.
- Phase 1 is useful alone. Phase 2 is the uncertain part; ship Arr first so the household can click TNG in Sonarr tonight.
