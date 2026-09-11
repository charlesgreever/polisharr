# PRD: Polisharr v2

Canonical v2 product spec. This document matches GitHub issue #26. v1 remains [prd.md](prd.md) (issue #20). This document wins where the two conflict.

## Problem Statement

v1 of Polisharr inspects a Radarr and Sonarr library, suggests smaller HEVC files and cleaner tracks, and writes a sidecar I Keep or Discard. That bulk path is right for titles I do not want to babysit. It is the wrong tool for a title I want to curate.

On Movies and Series I cannot open one movie or episode and choose the plan. Track cleanup always follows preferred language. Stereo is only an extra AAC 2.0 mix. I cannot replace TrueHD with AAC, pick a 5.1 downmix, or tick which subtitles leave. I cannot set a target file size or encoder quality on that title, or downscale 4K to 1080p. ISO disc images fail ffprobe, land on Errors, and never get a suggestion, even though ffmpeg can read many of them.

The library tables are sparse: quality, size, and the first plan sentence. Series headers always show every episode. After I Keep a smaller encode, Radarr or Sonarr often still holds the old quality profile and downloads a bigger file again.

I want v2 to keep the bulk Suggestions path, add a real title page for custom work, handle ISO in inspect and encode without ffprobe, densify the library tables, let me collapse series headers, and assign a GB/hr-matched Arr profile after a transcode so the Arr does not undo the job.

## Solution

v2 is an incremental layer on the rewrite. v1 behavior stays unless a story below replaces it. GitHub issues #22–#25 fold into this document.

I still use **Suggestions** for automatic plans (GB/hr caps, preferred-language tracks, stereo for Atmos). Movies and Series become denser scan tables. Clicking a row opens a **title page** with its own URL. That page starts at **do nothing**: I build a custom plan (remove audio, replace a soundtrack with same-layout AAC, add or replace an AAC downmix, remove chosen subtitles, remux ISO to MKV, transcode with a target **file size** or **encoder quality** but not both, optionally 4K→1080p). Bit depth stays with the source. The page shows a quick output-size estimate. Queueing that plan **negates** the automatic suggestion for that title. Row Queue, Force, Stereo, and Exempt stay on the table for this iteration.

Inspect does **not** run ffprobe on `.iso`. It lists ISO streams with ffmpeg. If that list exists, bulk Suggestions and the title page both use it. If I remux an ISO to MKV and set no size and no quality, video quality does not change; the output is Matroska.

Output is still a **sidecar** on the review path by default. Settings has a global **direct write** switch. The title page can override that default for one job. Direct write runs an integrity check, then replaces the library file and skips Review. When profile auto-assign is enabled, Keep (or direct write) of a transcode assigns a suggested Arr quality profile derived from the GB/hr caps so Radarr or Sonarr does not grab a larger file again.

## User Stories

### Library tables and series headers

1. As a library owner, I want Movies rows to show quality, codec, size, audio tracks, subtitle tracks, and every plan change, so that I can scan a title without opening Suggestions.
2. As a library owner, I want Series episode rows to show the same columns (episode identity in place of movie title), so that TV is not a poorer table than Movies.
3. As a library owner, I want Plan to list each suggested change on its own line, so that a title that needs a transcode and track cleanup does not look like a single-reason job.
4. As a library owner, I want a probed healthy file to show its codec and tracks with Plan “Healthy”, so that I can tell inspect ran.
5. As a library owner, I want an uninspected row to keep quality and size, show em dashes for codec, audio, and subtitles, and say it is waiting for inspect, so that the table does not invent streams.
6. As a library owner, I want an unreadable row to show the path error and not invent codec or tracks, so that I fix the mount instead of queueing a lie.
7. As a library owner, I want no-subtitles to read “None”, so that an empty cell is not confused with “not inspected.”
8. As a library owner, I want tighter row padding and a smaller poster, so that more titles fit on a desktop width without hiding Plan or Actions.
9. As a library owner, I want the Arr instance still visible (its own column or under the title), so that a 4K copy and a 1080p copy stay distinct.
10. As a library owner, I want library list payloads to expose codec, audio summary, subtitle summary, and the full reason list, so that the UI does not scrape private inspect fields.
11. As a library owner, I want each series header to collapse and expand its episode table, so that a large library is scannable.
12. As a library owner, I want a collapsed header to keep show title, instance, episode count, and Optimize all episodes, so that I can still queue a show without opening it.
13. As a library owner, I want Optimize all episodes not to toggle collapse, so that a queue click does not hide the episodes.
14. As a library owner, I want Series to show collapsed headers first and load an episode table when I expand a show, so that a large library becomes usable without transferring and rendering every episode.
15. As a library owner, I want collapse state to survive an in-page refresh on Series, so that Reload does not explode every show again.
16. As a library owner, I want Queue, Force, Stereo, and Exempt to stay on the table row in this iteration, so that bulk actions do not move to the title page yet.
16a. As a library owner, I want the title page to queue the automatic suggestion as well as a custom plan, so that I can approve the bulk plan without returning to the table.

### Title page and custom plans

17. As a library owner, I want clicking a movie row to open a title page at a stable movie URL, so that I can bookmark and refresh that title.
18. As a library owner, I want clicking an episode row to open a title page at a stable episode URL, so that Ted Lasso S03E02 is not a search hash on the table.
19. As a library owner, I want global search to open that title page, so that I land on the editor, not a scrolled table.
20. As a first-time user, I want the title page to start as do nothing, so that every keep, drop, replace, downmix, remux, and transcode is a choice I made.
21. As a library owner, I want the title page to show poster, identity, Arr instance, path, quality, codec, size, duration, HDR, bit depth, audio tracks, and subtitle tracks, so that I can curate from facts, not from memory.
22. As a library owner, I want to remove individual audio tracks, so that I can drop a commentary or an extra language the bulk plan would not treat the way I want.
23. As a library owner, I want to remove individual subtitle tracks, so that I keep English SDH and drop the rest, or the reverse.
24. As a library owner, I want a codec change of an existing soundtrack to AAC at the same channel layout to replace that track, so that TrueHD becomes AAC without leaving two copies of the same mix.
25. As a library owner, I do not want a same-layout codec change as an extra track, so that the file does not carry TrueHD and a duplicate AAC 7.1.
26. As a library owner, I want a downmix to AAC in a smaller channel layout, down to stereo, so that 7.1 can become 5.1 or stereo, and 5.1 can become stereo.
27. As a library owner, I want a downmix to be either a replacement or an additional track, so that I can keep Atmos for the AVR and add stereo for the TV, or replace the bulky mix entirely.
28. As a library owner, I want generated audio to come only from a track already in the file, so that Polisharr never imports commentary files, uploads, or other titles.
29. As a library owner, I want an ISO that ffmpeg can list to offer the same audio and subtitle controls, so that a disc image is not a second-class title page.
30. As a library owner, I want an ISO that ffmpeg cannot list to hide track editing and still allow remux or encode, so that a bad disc image is not stuck on Errors with no escape.
31. As a library owner, I want an ISO with no size target and no encoder quality, when I ask for MKV, to remux into Matroska with no video quality change, so that the file plays as a normal container.
32. As a library owner, I want an already-MKV title with no track changes and no video changes to refuse Queue, so that do nothing cannot create an empty sidecar.
33. As a library owner, I want optional 4K→1080p on the title page, so that a living-room encode can be 1080p while the bulk cap stays 4K.
34. As a library owner, I want 4K→1080p to require a transcode (size or quality mode), so that a remux cannot pretend to downscale.
35. As a library owner, I want bit depth to stay with the source, so that a 10-bit HDR file does not come back 8-bit.
36. As a library owner, I want a transcode to pick either a target **file size** or an **encoder quality**, never both, so that the two knobs cannot fight.
37. As a library owner, I want changing size to turn quality off, and changing quality to turn size off, so that the card always has one encode aim.
38. As a library owner, I want the job details text to say which mode is on (target size vs encoder quality), so that Queue and Review do not look like a GB/hr bulk job.
39. As a library owner, I want a quick output-size estimate on the title page without a trial encode, so that I can judge the plan before I queue.
40. As a library owner, I want size mode to treat the target file size as that estimate, so that the number I typed is the number I see.
41. As a library owner, I want quality mode to update the estimate when I move encoder quality, duration, resolution, and downscale, so that the guess tracks the controls.
42. As a library owner, I want HEVC as the default custom transcode codec, and AV1 only when hardware encode for AV1 is present, so that the title page matches v1 hardware rules.
43. As a library owner, I want Dolby Vision / HDR10+ custom transcodes to keep the same metadata-loss warning as bulk, so that I decide with my eyes open.
44. As a library owner, I want Queue on the title page disabled until the plan differs from the source, so that a blank page cannot start a job.
45. As a library owner, I want queueing a custom plan to negate the automatic suggestion for that title, so that Suggestions and the dense Plan column show the custom work, not the bulk card.
46. As a library owner, I want a custom job to lock a second job on that title the same way a bulk sidecar does, so that I cannot stack competing outputs.
47. As a library owner, I want an unreadable or still-uninspected title page to disable optimize controls and show the reason, so that a click does not claim success.
48. As a library owner, I want size-exempt titles to still allow a custom transcode, so that exemption blocks bulk nagging, not intentional curation.
49. As a library owner, I want excluded titles (path, profile, tag, title) to stay off Suggestions but still open a title page I can curate, so that an archive can be touched on purpose.
50. As a library owner, I want help on the title page to define sidecar, direct write, codec replace, downmix, size mode, and quality mode, so that a junior operator can use the editor.
51. As a mobile user on the LAN, I want the title page to work on a phone browser, so that I can curate from the couch.
52. As a library owner, I want Back to return to Movies or Series, so that the title page is not a dead end.

### Bulk Suggestions and ISO inspect

53. As a library owner, I want Suggestions to remain the automatic work list, so that I can still approve a pile of titles I do not care to curate.
54. As a library owner, I want Settings toggles for non-preferred subtitle cleanup, non-preferred audio cleanup, automatic stereo, and size-cap transcode, so that Suggestions only offer the automatic operations I want. These toggles do not remove Force, Add stereo, or custom title plans.
54a. As a library owner, I want an optional Settings toggle to convert ISO disc images to MKV in Suggestions, the same way MP4 conversion is optional, so that a disc image is work I can approve rather than an Errors row.
54b. As a library owner, I want ISO inspect and remux to keep the playlist language codes on audio and subtitle tracks, so that a disc listed as English does not become `und` in the Matroska file.
54c. As a library owner, I want a confirmed title-page action when a file’s only audio track is not my preferred language, so that Polisharr can ask Radarr or Sonarr to delete that file and search again.
54d. As a library owner, I want that Arr search to require a confirm that names the app and says the current file will be removed, so that a click cannot silently delete a library file.
54e. As a library owner, I want an optional Settings toggle so Suggestions can list those wrong-language-only titles, so that I can work a pile of them without opening each title page. The toggle does not run the search until I confirm.
54f. As a library owner, I want to ask the title page to identify an untagged audio track by listening to a short clip, so that I can tag `und` dialogue without transcribing the movie.
54g. As a library owner, I want a failed clip (no speech or low confidence) to stay `und` and offer another start time in the file, so that opening logos or silence do not become English.
54h. As a library owner, I want to confirm the detected language before Polisharr stores it on the inspection, so that a commentary track is not silently retagged.
54i. As a library owner, I want identify-language to leave the library file unchanged, so that only Keep (or a later remux sidecar) writes tags onto disk.
54j. As an operator, I want language identification to be optional at install (a `WHISPER_LID` command). If it is missing, the title page says so and does not pretend to listen.
54k. As a library owner, I want to ask the title page to identify an untagged text subtitle track by reading a short sample of its words, so that I can tag `und` subs without guessing.
54l. As a library owner, I want a sample with too little text or a weak guess to stay `und` and offer another start time, so that opening credits do not become English.
54m. As a library owner, I want Identify language on untagged PGS when `PGS_OCR` is installed, and a short explanation that PGS is images when it is not, so that I do not wait on a button that cannot run.
54n. As a library owner, I want subtitle identify-language to leave the library file unchanged until Keep, the same as audio identify-language.
55. As a library owner, I want inspect to never run ffprobe on a `.iso` path (any case), so that disc images do not fail or hang the walker.
56. As a library owner, I want inspect to list ISO streams with ffmpeg into the same inspection report shape as MKV, so that bulk and custom share one document.
57. As a library owner, I want a readable ISO that ffmpeg listed to get bulk suggestions (size, tracks, stereo) from that report, so that disc images are not skipped only because ffprobe failed.
58. As a library owner, I want a readable ISO that ffmpeg could not list to stay off Errors-as-ffprobe-failure and still be queueable as remux or encode from the title page, so that “could not list streams” is not “cannot process.”
59. As a library owner, I want ordinary `.mkv` and `.mp4` files to keep using ffprobe, so that ISO handling does not rewrite the rest of inspect.
60. As a library owner, I want the finished sidecar (always a normal video file) to be ffprobed for integrity, so that we still refuse a truncated encode.
61. As a library owner, I want a custom queue to remove that title from Suggestions immediately, so that I do not bulk-approve the old plan by accident.

### Sidecar, direct write, and promote

62. As a library owner, I want custom jobs to write a sidecar on the review path by default, so that I still Keep or Discard with a comparison.
63. As an operator, I want a Settings switch that makes **every** job direct-write the library file, so that a trusted box can skip Review.
64. As a library owner, I want the title page to override that global switch for one custom job, so that I can sidecar a careful title while the house default is direct write, or the reverse.
65. As a library owner, I want the override and the global default to be visible on the title page and in job details, so that I know whether Review will see this job.
66. As a library owner, I want direct write to integrity-check the output, then replace the library file, and not create a Review card, so that Review is not full of already-applied work.
67. As a library owner, I want a failed direct write to leave the original library file in place and delete partial output, so that a crash is not a silent replace.
68. As a library owner, I want Keep of a sidecar to replace the file, refresh the originating Arr and every configured player, and re-inspect the promoted path before Keep finishes, so that Polisharr does not show the new file as uninspected.
69. As a library owner, I want direct write, after a successful replace, to run the same Arr refresh, player notification, and targeted reinspection as Keep, so that every promote path finishes with current media details.
70. As a library owner, I want a failed Arr refresh, profile assign, player notification, or post-promote inspection not to roll back the new file, so that a follow-up outage does not undo a good encode and the failure remains visible.
71. As a library owner, I want Discard, Cancel, off-peak, concurrency, and run-now to apply to custom jobs the same as bulk jobs, so that the queue stays one queue.
72. As a library owner, I want space saved and files optimized to count successful Keep and successful direct write, so that skipping Review does not hide savings.
73. As a library owner, I want a flagged-over-target sidecar (larger than source, or far from the size target) to still be Keepable, so that I decide, including after a custom size-mode job.

### Arr quality profiles

74. As a library owner, I want Settings to show one suggested Arr quality profile per size category from the current GB/hr caps, including the equivalent MB/min, so that I can see what Polisharr would ask Radarr and Sonarr to use.
75. As an operator, I want an explicit Settings action to create those named profiles on each enabled Radarr and Sonarr without deleting my other profiles, so that TRaSH or Ultra-HD profiles stay.
76. As a library owner, I want Keep or direct write of a **transcode** to assign the Radarr movie to the matching suggested profile when profile auto-assign is enabled and not start a search, so that the Arr does not download a bigger file.
77. As a library owner, I want Keep or direct write of a transcoded episode to assign the Sonarr **series** to the matching TV profile, with copy that this applies to the whole show, so that I am not surprised when future episodes follow that profile.
78. As a library owner, I want tracks-only, stereo-only, audio-replace-only, and ISO-remux-only promotes not to change the quality profile, so that a language cleanup does not re-home a remux I still want upgraded later.
79. As a library owner, I want a size-exempt title not to get the smaller profile on promote, so that archival movies stay on the profile I chose.
80. As a library owner, I want a missing or rejected profile assign to leave the file replaced and show the Arr error, so that promote still succeeds.
81. As an operator, I want changing a GB/hr cap to update the suggested-profile preview, and I want Polisharr-named profiles on the Arr to update only when I sync them, so that a typo in Settings does not rewrite Radarr until I say so.

### Operator, empty states, and developers

82. As an operator, I want Settings to let me disable profile auto-assign without disabling profile preview or explicit sync, and to say that Arr size limits (MB/min) are global per quality name, so that Polisharr does not move titles between profiles unless I allow it.
83. As an operator, I want hardware video encode to remain CUDA, VAAPI, or VideoToolbox only, so that a custom quality slider cannot fall back to a multi-day CPU encode.
84. As an operator, I want AAC codec replace and downmix to run in ffmpeg even when no GPU is required for audio, so that a tracks-and-audio job is not blocked on NVENC.
85. As a library owner, I want an empty Movies or Series table to keep the v1 empty copy, so that first run still tells me to connect an Arr.
86. As a library owner, I want a title URL for a missing id to say the title is not in the library, so that a stale bookmark is not a blank glass panel.
87. As a developer, I want the custom plan module testable from a fixture inspection plus a draft of choices, so that XOR size/quality, do-nothing, ISO remux, and suggestion negation do not need a browser.
88. As a developer, I want ISO inspect tested with a recorded ffmpeg listing and with a listing failure, so that ffprobe is never invoked on `.iso` in those tests.
89. As a developer, I want the runner tested with fake ffmpeg and fake `mkvmerge` for codec replace, downmix add vs replace, ISO remux, size-mode encode, quality-mode encode, and 4K→1080p, so that those jobs do not need a GPU or a disc image.
90. As a developer, I want promote tested for sidecar Keep vs direct write, original preserved on direct-write failure, and profile assign skipped on tracks-only, so that ENG-09 is explicit about the setting.
91. As a developer, I want Arr profile create and assign tested against fake Radarr and Sonarr HTTP, so that no live Arr is required.
92. As a developer, I want library list tests to assert codec, track summaries, and multiple plan reasons, so that the dense table cannot regress to `reasons[0]`.

## Implementation Decisions

- v2 extends the current rewrite. It does not wipe the tree. v1 PRD (issue #20 / `docs/prd.md`) remains the base spec. This document wins where the two conflict.
- Issues #22 (ISO), #23 (collapsible series headers), #24 (dense rows), and #25 (Arr profiles after Keep) are specified here and should close when v2 ships, not as unrelated one-offs with different rules.
- Two optimize paths share inspect, queue, runner, and promote: **bulk suggestion** (automatic) and **custom plan** (title page, starts empty). Queueing a custom plan dismisses or otherwise negates the open automatic suggestion for that item. Plan text on the row and on Suggestions follows the custom plan.
- **Custom plan** is a deep module. Callers pass an inspection report, settings (including global write mode), and a draft of operator choices. It returns a plan or validation errors. It does not spawn ffmpeg. The runner does not invent track policy.
- Title pages are first-class routes for one movie and one episode. Search hits those routes. Table `?focus=` is not the v2 landing path.
- Table row actions (Queue bulk plan, Force, Stereo, Exempt, Optimize all episodes) stay in this iteration. The title page is the custom editor.
- Dense rows: after title, show quality, codec, size, audio, subtitles, then each plan line. Instance stays visible. Audio/subtitle cells are compact summaries from inspect (language and layout), not raw stream dumps. Do not invent streams before inspect.
- Series headers collapse per show+instance and default to collapsed. The first response contains show summaries; expanding a header fetches that show’s episodes and retains them during the visit. Optimize all episodes is not the toggle. Refresh invalidates retained episode rows.
- Inspect: ffprobe for non-ISO. For `.iso` (any case), never ffprobe. List streams with ffmpeg into the same inspection report. Bulk Suggestions consume that report. If listing fails, record a distinct reason, do not loop retries, and do not pretend ffprobe failed. The title page may still remux or encode.
- ISO remux: ffmpeg reads the ISO and writes Matroska. No video encode when size mode and quality mode are both off. Track edits on an ISO still write MKV. `mkvmerge` is not the ISO demuxer. After a working file is MKV, `mkvmerge` may mux tracks as in v1.
- Video transcode on a custom plan: hardware HEVC by default; AV1 only if capability is on. Size mode aims at a **total file size**. Quality mode aims at encoder quality. Setting one clears the other. Job details name the mode. Optional 4K→1080p is an encode-only flag. Bit depth of the source is preserved. Estimate is a heuristic, not a sample encode.
- Bulk Suggestions still use category GB/hr caps, preferred language, and Atmos stereo rules when their Settings toggles are enabled. The four toggles ship enabled to preserve existing installations. Custom size mode, Force, Add stereo, and custom track choices do not inherit these automatic-operation toggles.
- Audio generate: ffmpeg AAC only, from an existing audio stream. **Codec replace**: same channel layout, replaces the source track. **Downmix**: smaller layout down to stereo (offer each step the source can drop to, at least 5.1 and stereo when the source is wider); operator chooses replace or additional. No external files, no uploads.
- Subtitle custom work is remove-only. Adding subtitle files is out of scope.
- Write mode: default sidecar + Review + Keep (ENG-09). Settings global direct write applies to bulk and custom. Title page override applies to that custom job only and is stored on the plan. Direct write: encode to temp, integrity (duration present; do not copy source duration onto the result), then replace library file, no Review row. Failure deletes temp and leaves the original. Cancel of a direct-write job must not leave a half-written library file.
- Promote after transcode Keep or transcode direct write: assign a suggested Arr profile only when profile auto-assign is enabled; do not search. Sonarr assign is the series. Tracks-only, stereo-only, codec-replace/downmix-only, ISO remux-only, and size-exempt plans do not assign. Failed assign does not undo replace. After either promote path updates Polisharr's stored path and size, invalidate the old inspection and suggestion, inspect that promoted path, and recompute its suggestion before marking the background operation complete. A failed reinspection records an Errors row and a follow-up warning without restoring the old file.
- Suggested profiles: one per size category, stable Polisharr-prefixed names, create or update only on explicit Settings sync. Sync repairs drift in Polisharr-named allowed qualities, cutoff, and upgrade behavior. Do not overwrite unrelated profiles. Do not silently rewrite global Arr quality definitions (MB/min is help text and preview).
- Hardware video failure still fails the job. No software video fallback (ENG-05).
- ffmpeg, ffprobe, and `mkvmerge` still `execFile` argument arrays (ENG-08). ISO paths are file operands, not shell fragments.
- Modules: keep v1 modules. Add **Custom plan**. Extend Inspector (ISO listing and targeted post-promote reinspection), Suggestion engine (ISO reports and automatic-operation settings), Optimize runner (ISO remux, size XOR quality, codec replace, downmix add/replace, 4K→1080p), Promote (direct write, Arr profile assign), Settings (direct write, profile sync, suggestion defaults), Web UI (dense tables, collapsible series, title pages). Inspector and custom plan still do not encode. Promote still does not encode.
- Named ENG-09 break: direct write, when the operator enabled it globally or overrode it on the title page, replaces the library file without Keep. Sidecar remains the shipped default.

## Testing Decisions

- A good test asserts public behavior: inspection reports, custom-plan drafts, job payloads, sidecar vs library path, Arr HTTP, and user-visible sentences. Tests do not lock ffmpeg flag order, SQL tables, or React internals (ENG-04).
- Tests will be written for every v2 module in the sketch: Inspector (ISO and non-ISO), Suggestion engine, Custom plan, Optimize runner, Promote, Arr profiles, Settings write-mode, Web UI/HTTP for library rows and title pages. No live NAS, GPU, or Radarr.
- Prior art: existing inspect fixtures, `buildSuggestion` tables, fake optimizer in app/jobs tests, fake Arr HTTP, fake ffmpeg/`mkvmerge` in optimize tests. Extend those styles; do not import the retired Polisharr suite.
- Inspector: `.iso` path never calls ffprobe; ffmpeg listing fixture yields audio/subs; listing failure is a bounded error; `.mkv` still uses ffprobe; Keep and direct write target the promoted path and leave a visible error without rolling back when that probe fails.
- Suggestion defaults: legacy Settings load existing toggles enabled and new ISO/search toggles off; each toggle independently removes its automatic action and its reason; Force, Add stereo, custom plans, and the confirmed preferred-language search remain available; saving Settings recomputes Suggestions from stored inspections without probing unchanged files.
- Custom plan: empty draft cannot queue; size XOR quality; 4K→1080p rejected on remux-only; codec replace is replace-only; downmix add vs replace; ISO remux when no size/quality; queueing custom clears the automatic suggestion.
- Runner: ISO remux does not video-encode; size-mode and quality-mode encode are distinct; downscale requires encode; AAC replace vs extra downmix; hardware miss still fails video encode.
- Promote: sidecar Keep and direct write both refresh integrations and finish targeted reinspection; direct write skips Review and replaces; failed direct write leaves original; profile assign requires an enabled setting and a video transcode; ISO remux-only and size-exempt plans skip it; follow-up failures do not undo replace.
- Library HTTP: two reasons both appear; uninspected dashes; unreadable error; Series returns summaries before any episode rows and fetches one show’s episodes on expansion.
- Arr profiles: fake GET/POST/PUT qualityprofile and PUT movie/series; explicit sync repairs a drifted Polisharr profile; disabled auto-assign performs no title PUT; no search command.

## Out of Scope

- Redesigning bulk Suggestions, first-run, auth, Home, Queue, Review (except jobs that direct-wrote), History, Errors, Homepage widget, or the GB/hr cap model for bulk work.
- External or uploaded audio/subtitle files; copying tracks from another title.
- Same-layout AAC as an additional track (codec replace is replacement only).
- Software (CPU) video encode fallback.
- Auto-optimize of new imports.
- MakeMKV, mounting the ISO, or extracting `VIDEO_TS` / `BDMV` as a separate pipeline.
- Silently rewriting global Arr quality definitions.
- Unmonitoring titles, deleting operator quality profiles, or running Recyclarr/TRaSH.
- Per-episode Sonarr quality profiles (Sonarr cannot).
- Collapse-all / expand-all, persisting collapse across browser sessions, season-level collapse.
- Redesigning the Suggestions page layout (Why / Now / After stays).
- Moving Queue / Force / Stereo / Exempt off the table row (later iteration).
- Lidarr and other non-v1 Arrs.
- Guaranteeing Dolby Vision or HDR10+ survival.
- Multi-user SSO, path mapping, storage-aware NAS copy, multi-segment encode.

## Further Notes

- This PRD is the v2 spec. It does not replace issue #20. After accept, implementation should follow this document plus v1 where v2 is silent.
- Close #22, #23, #24, and #25 against the v2 work rather than re-specifying them in competing issues.
- Issue #38 supersedes the earlier expanded-by-default Series behavior. The 2026-08-21 open-issue audit lives in [open-issues.md](../plans/open-issues.md). Remaining implementation after the 2026-08-29 review lives in [review-follow-up.md](../plans/review-follow-up.md).
- First deploy remains ubuntuserver with the same NAS paths and NVIDIA GPU as v1.
- Direct write is a loaded gun: shipped off, labeled in Settings and on the title page, and tested for failure leaving the original file.
