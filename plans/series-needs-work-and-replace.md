# Plan: Surface titles that need work, sort Suggestions by space saved, and replace a file through the Arr

> Spec: new stories under `docs/prd.md` (library browse 25–32, Suggestions 44, search-preferred confirm already on the title page). Related: [series-keep-loaded-episodes.md](series-keep-loaded-episodes.md), [movies-health-strip.md](movies-health-strip.md), [multi-episode-files.md](multi-episode-files.md).

## Outcome

I expand SpongeBob SquarePants (628 healthy, 4 suggestions). I click **4 suggestions** and see those four episodes on the first page, still in season/episode order.

On Movies I click **N suggestions** and the table is only movies that still need work. Title/size/quality sort still applies to that filtered list.

On Suggestions I sort by **Largest savings**. The first page is the encodes that would free the most disk. Tracks-only rows with no size estimate sit at the end.

On a title with the wrong language or resolution I confirm **Ask Sonarr to remove this file and search again**. Sonarr deletes the episode file and starts EpisodeSearch. Polisharr drops the library row until the next import. The same action exists on a movie through Radarr.

If the movie or show is not worth encoding, I confirm **Stop tracking in Radarr/Sonarr**. That Arr deletes the files, removes the movie or series from its library, and Polisharr drops every matching row. Lists will not re-add it (import exclusion).

## Today

- Series headers and the Movies health strip already show `healthyCount` and `suggestionCount` from SQL. Healthy means: inspected, no open suggestion, no file error.
- Expanded episodes come from `GET /api/library/series/:instanceId/:seriesId/episodes` in **season, episode** order, 50 at a time. There is no filter.
- Movies can sort by title, size, or quality. There is no needs-work filter. Size sort is **current file size**, not estimated savings.
- Suggestions is already the global work list. It filters by type, resolution, HDR, codec, and chips. It always orders by show/title. `estimatedSavingsBytes` is on the suggestion payload and shown on the After cell; it is not a sort key. `?q=` stays in the URL; sort does not.
- Title pages already call `POST /api/library/items/:id/search-preferred` with `{ confirm: true }`. That path **only** runs when the only soundtrack is the wrong language, or the file is Dolby Vision Profile 5. It already deletes through the Arr (`moviefile` / `episodefile`) and posts `MoviesSearch` / `EpisodeSearch`.

## Architectural decisions

- **Filter on Movies and Series, sort on Suggestions.** Library tables hide healthy rows so a handful of suggestions are not buried. Suggestions is already non-healthy; there the need is order (biggest savings first).
- **Needs work** uses the existing healthy definition: open suggestion, unreadable path, or not inspected yet.
- **Click the suggestions pill** to turn the filter on; click again (or **All**) to turn it off. Same control language on Movies and on an expanded series.
- **Routes:**
  - `GET /api/library/series/:instanceId/:seriesId/episodes?work=1`
  - `GET /api/library/movies?work=1&sort=title|size|quality`
  - `GET /api/suggestions?sort=title|savings` (plus existing `q` and filters)
- Offset/limit stay as they are (cap 100). Filtered `total` is the matching count so Load more is honest.
- **Savings sort** uses stored `estimatedSavingsBytes` (JSON on the suggestion row). `NULL` and `0` (tracks-only, After size blank) sort last. Default remains title/show order. Keep `?sort=` in the URL next to `?q=`. Queue filtered still queues the current filter set; it does not change because of sort.
- **Replace search is opt-in confirm, any title.** Widen search-preferred (or a sibling `POST /api/library/items/:id/replace-search`) so a confirmed request is not limited to language-only or Profile 5. Reuse the Arr delete-then-command helper. Copy names Radarr or Sonarr.
- **Polisharr never deletes the library file itself.** After a successful search command, drop the Polisharr row and write History `searched`.
- **Jobs and Review still block.** Finish or cancel first (409).
- **Shared-file episodes:** confirm names siblings; one Arr delete; drop every Polisharr row with that path on that instance.
- **Quality profile is the Arr’s.** Help text says to change the profile first if the next grab would be the same size or language.
- **Stop tracking is a second, stronger confirm.** It is not replace-and-search. Radarr `DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion=true`. Sonarr `DELETE /api/v3/series/{id}?deleteFiles=true&addImportListExclusion=true`. Polisharr never unlinks the NAS path itself.
- **Series untrack is the whole show.** An episode page or series header removes the Sonarr series, every episode file, and every Polisharr episode row for that instance. There is no “unmonitor this one episode” in this plan.
- **Stop-tracking History** uses a new outcome `removed` (not Review `discarded`, not `searched`).
- **Any open job or Review on that movie, or on any episode of that show, is 409.** No Arr DELETE.

---

## Phase 1: Needs work on Series and Movies

**User stories:** As a library owner, I want to list only the episodes of one show — or only the movies — that are not healthy, so that a few suggestions are not buried under hundreds of healthy rows.

### What to build

Episode and movie list queries accept `work=1`. SQL keeps the current order (season/episode for TV; the chosen title/size/quality sort for movies) and counts only matching rows. Defaults stay **All**. Clicking **N suggestions** reloads page 0 with `work=1`. Load more continues that filter. Help on both pages says the pill limits the list. Optimize all episodes still queues the whole show. After a row action, refresh keeps the filter and the loaded window.

### Acceptance criteria

- [ ] With 628 healthy and 4 suggestion episodes, `work=1` returns those 4 as `total: 4` on the first page, season order.
- [ ] Default series expand (no `work`) still includes healthy rows.
- [ ] Movies `work=1` returns only non-healthy movies; `sort=size` still orders that subset by current file size.
- [ ] Unreadable and not-yet-inspected titles appear in Needs work.
- [ ] Load more uses the filtered total.
- [ ] Refresh and row `onDone` do not reset the filter to All.
- [ ] HTTP tests seed a show and a movie list; UI tests click the suggestions pill and assert `work=1`.

---

## Phase 2: Suggestions sort by space saved

**User stories:** As a library owner, I want to sort Suggestions so the largest estimated savings are first, so that I can queue the encodes that free the most disk.

### What to build

Suggestions grows a sort control (and a clickable After/savings header) with **Title** (default, current order) and **Largest savings**. `GET /api/suggestions?sort=savings` orders by `estimatedSavingsBytes` descending; missing estimates last. Filters and search still apply. `?sort=` survives refresh the same way `?q=` does. Queue filtered is unchanged.

### Acceptance criteria

- [ ] Default (no `sort` or `sort=title`) matches today’s show/title order.
- [ ] `sort=savings`: a 12 GB estimated save appears before a 2 GB save on page 1.
- [ ] A tracks-only suggestion with `estimatedSavingsBytes` null or 0 is after every positive save.
- [ ] Filters + savings sort compose: `type=movie&sort=savings` is movies only, largest save first.
- [ ] Invalid `sort` is 400 or ignored in favor of title (pick one in the slice and test it).
- [ ] UI stores `sort` in the URL; reload keeps Largest savings.

---

## Phase 3: Replace this file and search

**User stories:** As a library owner, I want to confirm that Radarr or Sonarr should remove this file and search again, so that I can replace a copy with the wrong language or resolution.

### What to build

A title-page control **Ask Radarr/Sonarr to remove this file and search again** on every movie and episode that has an Arr file id, not only language-only or Profile 5. Browser confirm, then `{ confirm: true }`. Server: same delete-then-search helper; refuse without confirm; 409 if a job or Review is open; History `searched`; remove the Polisharr item. Existing language and Profile 5 buttons keep their specific copy and still hit the same API. Help: the next grab uses that Arr’s quality profile.

### Acceptance criteria

- [ ] Confirm false still 400 with the existing confirm sentence.
- [ ] A healthy episode with an episode file id can replace-search.
- [ ] Fake Sonarr: DELETE `/api/v3/episodefile/:id`, then POST `EpisodeSearch`. Fake Radarr: DELETE moviefile, then `MoviesSearch`.
- [ ] If DELETE fails, the library file is unchanged and Polisharr keeps the row.
- [ ] If DELETE succeeds and search fails, the error says the file is gone and the search did not start.
- [ ] Active job or pending Review → 409, no Arr DELETE.
- [ ] After success the title 404s until the next library sync.

---

## Phase 4: Shared files and a library-row way in

**User stories:** Same replace-search, from Series and Movies rows, without silently deleting a sibling episode’s file.

### What to build

Replace-search from the series and movies row, behind the same confirm. If other episodes share the path, the confirm names them (`Same file as S08E36`) and success drops every sibling row. No extra Arr DELETE. Queue/Review lock is per path: if any sibling has a job or sidecar, 409. After success, a Needs work list refreshes and the header counts drop.

### Acceptance criteria

- [ ] Two library rows, one path: one confirm, one episodefile DELETE, both Polisharr rows gone.
- [ ] One sibling in Review → 409, file remains.
- [ ] Series and Movies rows show the action; Needs work counts update after success.

---

## Phase 5: Stop tracking the movie or series

**User stories:** As a library owner, I want to confirm that Radarr or Sonarr should delete this movie or series and stop tracking it, so that a title I will not encode leaves both libraries.

### What to build

A distinct control **Stop tracking in Radarr** / **Stop tracking in Sonarr**, on the movie title, the Movies row, the series header, and the episode title (episode still means the **show**). Confirm names the title and says files will be deleted and the Arr will not keep the movie or series. `{ confirm: true }` on `POST /api/library/items/:id/untrack` for a movie or episode, and `POST /api/library/series/:instanceId/:seriesId/untrack` for the header.

Server: Arr DELETE with `deleteFiles=true` and import-list exclusion; then drop the Polisharr movie row or every episode of that series on that instance, plus suggestions, errors, and series preferences. History `removed`. Copy never says “unmonitor.”

### Acceptance criteria

- [ ] Confirm false → 400. No Arr DELETE.
- [ ] Fake Radarr: `DELETE /api/v3/movie/{arrId}?deleteFiles=true&addImportExclusion=true`. Polisharr movie row is gone.
- [ ] Fake Sonarr from an episode or the series header: `DELETE /api/v3/series/{arrSeriesId}?deleteFiles=true&addImportListExclusion=true`. Every Polisharr episode of that show on that instance is gone.
- [ ] A second Sonarr instance’s copy of the same show is untouched.
- [ ] Job or Review on the movie, or on any episode of the show → 409, files remain, rows remain.
- [ ] Arr DELETE failure → 502, Polisharr rows remain, library files unchanged.
- [ ] Confirm copy includes the show or movie name and that files will be deleted.
- [ ] Needs work counts and Suggestions drop those rows without a full library refresh.

---

## Out of scope

- Changing Radarr/Sonarr quality profiles from Polisharr.
- Passing resolution or language into the Arr search command.
- Polisharr unlinking the NAS path if the Arr delete is skipped.
- Sorting series **headers** (shows) by suggestion count.
- Sorting Suggestions by current file size (use Largest savings; Movies size sort stays current file size).
- Reordering Queue filtered to match savings sort.
- Unmonitoring a single episode while keeping the rest of the show.
- Leaving files on disk while removing the Arr record (`deleteFiles=false`).
- Skipping import-list exclusion (this plan always excludes so lists do not re-add the title).
