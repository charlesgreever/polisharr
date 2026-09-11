# PRD: Polisharr Rewrite

Canonical v1 product spec. This document replaces GitHub issue #20. v2 is [v2 prd.md](v2%20prd.md) (issue #26).

## Problem Statement

I run a Plex and Jellyfin library with Radarr, Sonarr, and a large NAS. A lot of the media is wasteful or awkward to play: huge files, H.264 that could be HEVC, dozens of subtitle and audio tracks that are not in my language, and surround or Atmos tracks that TVs cannot play without a sound system.

I can fix individual files with ffmpeg and MKVtoolnix, and I already have one-off NVENC scripts, but that does not scale. I want a companion Arr app, Polisharr, that sees the same library Radarr and Sonarr already know, tells me what is worth fixing, and does the work in a queue I can trust.

The first implementation proved the product is right and the execution is not. Sync blocked the UI while thousands of files were probed. Keep froze Review while a multi-gigabyte replace ran. A 4K movie was scored against the 1080p cap because the probe read cover art. Suggestion cards said "remux" without saying why. Force claimed success when nothing changed. Sixteen unread files showed up as a failed count with no path and no reason. Storage-aware NAS copies (SSH, clonefile, same-volume detection) added complexity without earning a v1 keep. I am starting the codebase over. The product stays. The old TypeScript does not.

## Solution

Polisharr is a portable companion container that syncs one or more Radarr and Sonarr libraries over their APIs, using the same network paths those apps report. It inspects each file in the background, compares it to tunable size-per-hour caps (movie vs TV, 1080p vs 4K, HDR vs SDR), and suggests work: transcode to HEVC (AV1 when hardware allows), strip non-preferred and untagged tracks, and add an AAC stereo track when the file is not already stereo. A movie or a series can pick HEVC or AV1 independently of the house Encode Target. A series can Prefer stereo on surround episodes, including 5.1, or Keep surround.

I land on a Home dashboard that shows files optimized, space saved, and what still needs attention. I browse Movies and Series as sortable tables with posters. Each row shows the plan for that title. I can act on that row: queue work, add stereo, or mark a sticky size-cap exemption so an archival copy keeps the large video and still gets language cleanup and stereo. Suggestions remains the filtered work list of everything that still needs work. Errors lists every file that could not be read, with the path and the reason.

Work is asynchronous. Enqueue, Cancel, Keep, and navigation return at once. ffmpeg handles probes, hardware video encoding, and AAC stereo creation. MKVtoolnix (`mkvmerge`) muxes tracks, subtitles, and stereo streams. An optional suggestion default remuxes MP4 files to MKV before hardware encoding and can create remux-only work. Output lands as a sidecar on a separate NAS review path. I Keep or Discard each result. Keep replaces the original, asks Radarr or Sonarr to refresh, and notifies Plex and Jellyfin. Hardware encode failures fail the job and tell me. Polisharr has no software fallback, auto-Keep, multi-segment encode, or storage-aware NAS copy layer. An optional setting may queue a sidecar for a new or upgraded Arr file after inspect. Keep of that sidecar does not queue the promoted file again; a later Arr upgrade still can.

The UI follows Arr information architecture with a Vision UI-inspired dark glass look, readable iconography, global header search, and on-page help that explains the buttons and the workflow. Preferred language is a setting, confirmed once before the first optimize run.

## User Stories

1. As a library owner, I want a companion Arr container I can install next to Radarr and Sonarr, so that optimization lives with the rest of my media stack.
2. As a library owner, I want to run Polisharr on ubuntuserver first, so that it can see my real `/mnt/nas` library and NVIDIA GPU.
3. As an operator installing the container anywhere, I want hardware encode to follow the device I pass in (CUDA, VAAPI, or VideoToolbox on a native Mac process), so that the same app works on NVIDIA, Intel or AMD boxes, and M-series Macs.
4. As a first-time installer, I want a first-run flow that creates the admin account and collects Radarr/Sonarr instances, player apps, review path, and preferred language, so that I cannot start an optimize run half-configured.
5. As a first-time installer, I want to confirm my preferred language once before the first optimize run, so that tracks are not stripped in the wrong language by accident.
6. As a user who might share this app, I want preferred language to be a setting, so that English is not hard-coded for everyone.
7. As an operator, I want Arr-style local login with a modern password hash and sessions, so that the UI is not left open on the LAN.
8. As an operator, I want an optional local-address auth bypass, so that I can match how I already run Radarr and Sonarr on my home network.
9. As an operator, I want to change my username and password, so that I can rotate credentials.
10. As an operator, I want failed logins to be rejected without leaking whether the username exists, so that the login is not easy to enumerate.
11. As an operator, I want config and queue state on a persistent volume, so that I can recreate the container without losing settings.
12. As an operator, I want PUID, PGID, and timezone environment, so that files written to the NAS have the same ownership as the Arrs.
13. As an operator, I want HTTPS and API-key handling that never echoes secrets back in the UI after save, so that a screenshot of settings is safer.
14. As an operator, I want a test-connection action for each Arr and each player, so that I find a bad token before the first Keep.
15. As a library owner, I want Polisharr to sync movies from every configured Radarr over the API, so that I do not maintain a second library index by hand.
16. As a library owner, I want Polisharr to sync series and episodes from every configured Sonarr over the API, so that TV is covered the same way as movies.
17. As a library owner, I want multiple Radarr and Sonarr instances (for example 1080p and 4K), so that a split Arr setup still appears as one optimization library.
18. As a library owner, I want each instance to have its own URL, API key, and enabled flag, so that I can add, pause, or remove an Arr without editing others.
19. As a library owner, I want Polisharr to use the same network paths Radarr and Sonarr report, so that a file the Arrs know is the file Polisharr opens.
20. As a library owner, I want a sync that updates when I open the app and on a background interval, so that new imports and upgrades show up without a manual refresh.
21. As a library owner, I want Arr sync to finish and show titles before ffprobe has walked the library, so that I am not staring at an empty Movies page during first import.
22. As a library owner, I want new Radarr and Sonarr imports to be inspected automatically, so that I do not have to remember to scan each download.
22b. As a library owner, I want an optional setting that queues a sidecar for a new or upgraded Arr file when inspect produces a suggestion, so that I only Keep or Discard.
23. As a library owner, I want each inspection to become suggestions I can approve, so that nothing destructive happens until I say so.
24. As a library owner, I want later Arr upgrades to be re-inspected, so that a new remux gets suggestions again.
25. As a library owner, I want to browse movies in an Arr-like library view, so that the app feels familiar.
25a. As a library owner, I want the Movies page to show how many titles there are, how many are healthy, and how many still have suggestions, so that I can scan the Radarr library the same way I scan a series header.
26. As a library owner, I want to browse series and episodes in an Arr-like view, so that TV is not a second-class list of files.
26b. As a library owner, I want the episode (and movie) pages I already loaded to stay after I queue or otherwise act on a row, so that Load more is not undone by a single Queue click.
27. As a library owner, I want library pages to be a sortable column-and-row table with the poster on the row, so that I can scan and sort a large library faster than with cards.
28. As a library owner, I want each row to show current codec, bit depth, resolution, HDR type, quality, size, size-per-hour, audio, and subtitles, so that I can see why it was flagged.
29. As a library owner, I want each row to show the optimization plan for that title in plain language, so that I do not have to open Suggestions to learn what Polisharr would do.
30. As a library owner, I want to queue work, add stereo, force a suggestion, or set a size-cap exemption from the movie or episode row, so that I can act where I already am.
30a. As a library owner, I want an Encode target dropdown on each movie row and movie title page (house default, HEVC, or AV1), so that one film can use AV1 while Settings still suggest HEVC.
31. As a library owner, I want episode rows to offer the same actions as movie rows, so that Series is not a read-only tree.
31b. As a library owner, I want two Sonarr episodes that share one file to produce one optimize job and one Review sidecar, and I want both episode rows to say they share that file, so that I do not encode or Keep the same MKV twice.
32. As a library owner, I want an Optimize all episodes control on the series header, so that I can queue every episode of that show that already has open work.
33. As a library owner, I want Optimize all episodes to skip healthy, unread, dismissed, and pending-review episodes, and to tell me how many were queued and how many were skipped, so that I do not invent work or stack jobs.
33a. As a library owner, I want each series header to show how many episodes are healthy and how many still have suggestions, so that I can scan a show without expanding it.
33b. As a library owner, I want an Encode target dropdown on each series header that applies to every episode, including later imports, so that a show can use a different codec than Settings.
33c. As a library owner, I want a Preferred audio dropdown on each series header (house default, prefer stereo, or keep surround), so that a kids show with 5.1 becomes stereo-only without changing the house Atmos-add rule.
33d. As a library owner, I want the series header healthy and suggestion counts to update when I change Encode target or Preferred audio, so that I can see the new work without expanding the show or refreshing the library.
34. As a library owner, I want posters synced from the Arr APIs and served through Polisharr, so that the browser never needs an Arr API key.
35. As a library owner, I want a missing poster to be a neutral placeholder, so that a broken image does not break the table.
36. As a library owner, I want each title to show which Arr instance it came from, so that a 4K copy and a 1080p copy are not mixed up.
37. As a library owner, I want episode vs movie rules applied from the Arr type (Sonarr vs Radarr), so that a 40-minute file is not scored as a movie.
38. As a library owner, I want a suggestions page that lists only items with recommended work, so that I am not wading through files that are already fine.
38a. As a library owner, I want a suggestion title to open that title’s detail page, so that I can edit a custom plan from the work list the same way I do from Movies and Series.
39. As a library owner, I want to approve one suggestion or a whole plan onto the queue from Suggestions, so that I still have one place to work the backlog.
40. As a library owner, I want to reject or dismiss a suggestion, so that Polisharr stops nagging me about a file I want to leave alone.
41. As a library owner, I want bulk-approve for a movie, a series, or a filtered list, so that I can work a season or a 4K pile at once.
42. As a library owner, I want filters for movie vs TV, resolution, HDR, codec, over-cap, extra tracks, exemptions, and hardware warnings, so that I can work one problem type at a time.
43. As a library owner, I want search by title and show name, so that I can find one film or every Ted Lasso row without scrolling the whole library.
44. As a library owner, I want suggestion search to debounce, match all tokens, understand `S01E01` / `1x01`, and keep `?q=` in the URL, so that typing stays cheap and a refresh keeps the query.
45. As a library owner, I want a global search field at the top of every page, so that I can jump to a movie or episode from anywhere.
46. As a library owner, I want global search to open the matching title in Movies or Series, so that I land on the row I can act on.
47. As a library owner, I want empty states when the library has not synced, when there are no suggestions, when the queue is idle, when Review is empty, and when Errors is empty, so that I know what to do next.
48. As a library owner, I want a clear error when an Arr API key or URL is wrong, so that I can fix sync instead of staring at an empty library.
49. As a library owner, I want a clear error when the network path from an Arr is not readable inside the container, so that I know it is a volume or mount problem.
49a. As a library owner, I want a Radarr or Sonarr title that has no media file yet (a future release, or a download that has not finished) to stay off Errors, so that “not downloaded yet” is not mixed with a broken mount.
49b. As a library owner, I want Polisharr to list a title only after the Arr reports a real media file, so that a movie folder with no file does not appear on Movies as unreadable.
50. As a library owner, I want unread or unreadable rows to show the path error and disable optimize actions, so that a click does not claim success.
51. As a library owner, I want an Errors section that lists every file that could not be loaded or probed, so that "16 files could not be loaded" is something I can act on.
51a. As a library owner, I want Errors help to say that still-downloading titles are not listed there, so that I do not hunt a mount problem for a missing file.
52. As a library owner, I want each Errors row to show the file name, full path, Arr title when known, and the reason it failed, and I want that title to open the same media page as Movies and Series when the library item is known, so that I can fix permissions, mounts, or a corrupt file without searching for the title.
53. As a library owner, I want the failed count to be distinct files, not retry attempts, so that the number never exceeds the library.
54. As a library owner, I want a file that fails ffprobe to be tried a bounded number of times and then marked failed, so that the inspector does not retry it forever.
55. As a library owner, I want the inspect banner to say that Arr lists are ready and that N files are still being probed, with N left, so that I can tell sync from inspect.
56. As a library owner, I want the inspect banner to go away (or become a dismissible "N files could not be probed" that links to Errors) when the walk ends, so that I am not stuck under a permanent amber bar.
57. As a library owner, I want already-inspected files skipped when path and size are unchanged, so that a later refresh does not re-probe the whole NAS.
58. As a library owner, I want first-load cards to use Arr media info (codec, resolution, size, HDR) until ffprobe finishes, so that the table is useful before every file is probed.
59. As a library owner, I want suggestions and optimize to wait for a real inspection, so that a plan is not invented from Arr metadata alone.
60. As a library owner, I want Force suggestion and Add stereo to report success only when Suggestions will actually list the title, so that the app does not invent success.
61. As a library owner, I want Add stereo on a file that already has stereo to say that nothing changed, so that I am not told a track was added when it was not.
62. As a library owner, I want a suggestion card and a library row to explain why work exists in everyday words (too large, extra languages, no stereo for the TV), so that I do not have to know the word remux.
63. As a library owner, I want each suggestion to show Now (codec, quality, size, GB/hour, tracks) and After (target codec, target size or GB/hour when a real estimate exists, tracks that stay), so that I can compare the plan.
64. As a library owner, I want a tracks-only plan to leave After size and GB/hour blank rather than repeat Now as a fake target, so that I do not think the video will shrink.
65. As a library owner, I want a forced tracks-only job that has no extra languages to avoid claiming tracks will be dropped, so that the reason matches the plan.
66. As a library owner, I want estimated space savings on size-related suggestions, so that I can prioritize the biggest wins.
67. As a library owner, I want already-good files (under cap or exempt, preferred-language tracks only, stereo already present or not required) to show as healthy, so that I know Polisharr looked and said no work.
68. As a library owner, I want size caps expressed as GB (or MB) per hour, so that a 45-minute episode and a 3-hour film are judged fairly.
69. As a library owner, I want separate tunable caps for Movie 1080p, Movie 4K SDR, Movie 4K HDR, TV 1080p, and TV 4K, so that TV and movies are not forced into one budget.
70. As a library owner, I want shipped defaults of 2.5 / 6 / 8 / 1.0 / 4.0 GB per hour for those categories, so that I have a sensible starting point.
71. As a library owner, I want to change those caps in settings, so that I can be more archival or more aggressive later.
72. As a library owner, I want a file over its cap to get a size-reduction suggestion, so that I know which titles are worth encoding.
72a. As a library owner, I want that size check to use the file after planned audio and subtitle removal, so that extra languages are not treated as a reason to re-encode.
73. As a library owner, I want that suggestion to aim the encode at the category GB/hour target, so that the output is trying to land under the cap, not just "smaller."
73a. As a library owner, I want the encoder bitrate to reserve space for the audio and subtitles that will be copied (not the tracks being dropped), plus a little slack, so that a TrueHD or Atmos title does not miss the cap by the size of those kept tracks.
73b. As a library owner, I want a file within 5% of its GB/hour cap to count as meeting the cap, so that I am not asked to re-encode a title that landed a little over.
73c. As a library owner, I want no size transcode when dropping extra languages already brings the file under the cap, so that I am not asked to re-encode a title that only looked large because of tracks I do not keep.
73d. As a library owner, I want no size transcode when the soundtrack I keep already fills the cap, so that a TrueHD title does not fail the job. If Transcode video below HEVC or Force still requires an encode, aim the video at the category cap and copy that soundtrack on top; Review flags that the sidecar missed the GB/hour cap.
74. As a library owner, I want H.264 (and other less efficient video) to be suggested for HEVC when it would help, so that I stop storing oversized AVC files.
75. As a library owner, I want HEVC to be the default target codec, so that playback stays widely compatible.
76. As an early adopter, I want AV1 as an optional target when the hardware can encode it, so that I can chase smaller files on capable GPUs.
77. As a library owner, I want AV1 hidden or disabled when hardware cannot encode it, so that I do not queue jobs that cannot run.
78. As a library owner, I want the current bit depth preserved, so that a 10-bit file does not come back as 8-bit.
79. As a library owner, I want Dolby Vision and HDR10+ files to still get a transcode suggestion, so that huge HDR titles are not skipped.
80. As a library owner, I want a warning that DV/HDR10+ metadata may be lost, so that I can decide with my eyes open.
81. As a library owner, I want 4K vs 1080p taken from the Arr quality label and the real playable video stream, so that a 2160p movie is not scored against the 1080p cap.
82. As a library owner, I want cover-art streams and missing display size to be ignored when choosing the size category, so that a poster or coded-size-only probe cannot hide a 4K film.
83. As a library owner, I want a file or Arr that says 2160p / 4K / UHD to use the 4K bucket, and Dolby Vision / HDR to use the HDR cap, so that Avatar Aang WEBDL-2160p DV uses 8.00 GB/hr, not 2.50.
84. As a library owner, I want existing suggestion rows to recompute the cap on refresh and at enqueue, so that a wrong 2.50 card does not stay wrong and does not encode at 1080p bitrate.
85. As a library owner, I want extra audio and subtitle tracks that are not my preferred language suggested for removal, so that files are not full of languages I never use.
86. As a library owner, I want every preferred-language audio and subtitle track kept (including SDH, forced, and commentary), so that I do not lose useful English (or other preferred) tracks.
87. As a library owner, I want untagged (`und` / unknown) audio and subtitle tracks suggested for drop, so that mystery tracks do not linger.
87b. As a library owner, I want Identify language on an untagged PGS subtitle to OCR a short sample when `PGS_OCR` is installed, so that I can tag bitmap subs the same way I tag text subs. Saving still does not rewrite the library file until Keep.
88. As a library owner, I want a lone untagged dialogue track kept, so that track cleanup cannot silence the file.
89. As a library owner, I want a tracks-only plan when the video is already fine but tracks are messy, so that I am not forced to re-encode for language cleanup.
90. As a library owner, I want already-HEVC (or AV1) under-cap files with messy tracks to get tracks-only work, not a re-encode.
91. As a library owner, I want originals that are already AV1 to not be suggested back to HEVC, so that early-adopter files are not downgraded.
92. As a library owner, I want to force a transcode on a file that is under the cap, so that I can still convert a specific H.264 title.
93. As a library owner, I want to mark one movie or one episode as exempt from the size cap, so that a high-quality keeper is not nagged to shrink.
94. As a library owner, I want an exempt title to still be offered language cleanup and stereo add, so that archival video can still be easier to play.
95. As a library owner, I want that exemption to persist until I clear it, so that a later sync does not put the title back on the size list.
96. As a library owner, I want exemption to apply only to that movie or that episode, so that marking one Ted Lasso episode archival does not exempt the whole show.
97. As a library owner, I want to clear an exemption from the same row, so that I can later decide the file should meet the cap after all.
98. As a TV watcher, I want a stereo AAC track suggested when the file has Atmos or more than 5.1, so that a TV without surround can play dialogue.
98a. As a TV watcher, I want Prefer stereo on a series to replace surround with AAC stereo and drop the original mix whenever the episode is surround (more than 2 channels), so that 5.1 kids shows become stereo-only.
98b. As a TV watcher, I want Keep surround on a series to skip automatic stereo for that show, so that a surround-first title is not nagged.
99. As a TV watcher, I want adding AAC stereo available on any file that is not already stereo, so that I can add it even when Polisharr did not auto-suggest it.
100. As a TV watcher, I want house default and Keep surround to leave the original surround or Atmos track in the file, so that the living-room AVR still gets the fancy mix.
101. As a library owner, I want chapters and attachments copied when we mux or transcode, so that extras and fonts do not disappear.
102. As a library owner, I want track cleanup and stereo mux to use MKVtoolnix (`mkvmerge`), so that those jobs finish faster than an ffmpeg remux.
103. As a library owner, I want the AAC stereo stream itself created with ffmpeg and then merged with `mkvmerge`, so that mux stays fast and the TV still gets stereo.
104. As a library owner, I want hardware video encode to stay on ffmpeg (CUDA, VAAPI, or VideoToolbox), so that HEVC and AV1 still use the GPU or Mac media engine I passed in.
105. As a library owner, I want a job that needs extra-track cleanup and a codec or size encode to mux first, then transcode that working file, in one job, so that the library file stays untouched until Keep.
105a. As a library owner, I want that job to re-check size on the muxed file: skip a size-only encode when the remaining file meets the cap or kept audio fills it, and still encode when the codec or Force requires it.
106. As a library owner, I want an off-by-default suggestion setting that converts MP4 files to Matroska before a hardware encode or as remux-only work, so that NVENC reads an MKV when I opt in. Keep may change the extension; the Arr refresh updates the path.
107. As a library owner, I want a queue of approved work, so that I can see what will run, what is running, and what finished.
107a. As a library owner, I want a Queue title to open that title’s detail page, so that I can inspect the file and plan from the same media page as Movies, Series, Suggestions, and Errors.
107b. As a library owner, I want running Queue jobs in a Working now block that is not pushed down by finished rows, so that I can watch the current encode after other jobs have completed.
107c. As a library owner, I want waiting jobs listed before finished jobs, so that a large finished pile does not hide what will run next.
108. As a library owner, I want to reorder, pause, or remove queued items, so that tonight’s movie is not stuck behind a 4K encode.
109. As a library owner, I want the default concurrency to be one job, so that the GPU and NAS are not slammed out of the box.
110. As a library owner, I want a toggle to allow more than one transcode at a time, so that I can use more of the GPU when I choose.
111. As a library owner, I want the Encode section to give concurrency and scheduling changes an explicit Save action and honor whatever concurrency I save, so that the setting is not stranded in the browser or silently second-guessed.
112. As a library owner, I want an off-peak schedule, so that heavy encodes run at night instead of during movies.
113. As a library owner, I want jobs that miss the window to wait until the next off-peak period, so that a late queue does not start at dinner.
114. As a library owner, I want a way to run a job immediately even if we are outside the window, so that I can override the schedule.
115. As a library owner, I want work to read the Arr path and write the sidecar on the review path with ordinary copy and rename, so that v1 does not include NAS-native, SSH, clonefile, or local-scratch modes.
116. As a library owner, I want finished output to land in a separate NAS review path, so that Radarr, Sonarr, Plex, and Jellyfin do not see two files in the movie folder.
117. As a library owner, I want that review path to be configurable, so that I can put it on the NAS share I choose.
118. As a library owner, I want the review path rejected when it sits inside an Arr library root, so that sidecars cannot confuse the Arrs.
119. As a library owner, I want the original library file left untouched until I Keep, so that playback keeps working during review.
120. As a library owner, I want adding an item to the queue to return control to the UI immediately, so that enqueue never waits for copy, mux, or encode.
121. As a library owner, I want Queue, Review, Settings, Home, and Cancel to stay usable while a job runs, so that ffmpeg or `mkvmerge` cannot freeze the browser tab or the rest of the desktop.
122. As an operator, I want authenticated status endpoints to stay responsive while a job runs (p95 under 500 ms on the test host), so that polling does not feel like a hang.
123. As a library owner, I want the browser to avoid overlapping polls for the same endpoint, so that a slow inspect or queue request does not pile up.
124. As an operator, I want per-job logs to stay bounded, so that ffmpeg and `mkvmerge` output cannot grow without limit in memory.
125. As an operator, I want a conservative performance mode in Settings if one resource policy cannot suit both a shared desktop GPU and a dedicated server, so that I can protect the host without changing concurrency in secret.
126. As a library owner, I want a running job to show the current phase in plain language (waiting, muxing tracks, creating stereo, transcoding to HEVC, finishing) and real progress, so that a long job does not look stalled.
127. As a library owner, I want copy or move progress to come from bytes transferred, and encode progress from ffmpeg time against duration, so that the bar is not a fake animation.
128. As a library owner, I want queued and held jobs to say they are waiting, so that they do not show a fake encode bar.
129. As a library owner, I want phase and progress to survive a refresh, so that another tab sees the same numbers.
130. As a library owner, I want a Cancel button on each queued, held, or running job, so that I can stop a stalled encode without SSH.
131. As a library owner, I want to cancel a job that has not started yet, so that it never runs.
132. As a library owner, I want to cancel a job that is running or appears stalled, so that it stops occupying the queue.
133. As a library owner, I want a cancelled job to leave the original library file untouched, so that cancel is never a replace.
134. As a library owner, I want a cancelled job to discard any partial sidecar or temp file and not appear in Review as a success, so that I do not Keep a half-written copy.
135. As a library owner, I want finished or already-cancelled jobs to refuse Cancel, so that I cannot rewind a completed Keep or hide a finished result.
136. As a library owner, I want a cancelled title to be queueable again, so that I can retry after fixing hardware or settings.
137. As a library owner, I want container restart to resume or re-queue unfinished encodes and interrupted Keep cards without half-writing a library file, so that a reboot is safe.
138. As a library owner, I want disk-space checks on the review path before a job starts, so that a full NAS does not kill an encode halfway.
139. As an operator, I want cleanup of temp files after success or failure, so that review does not fill with leftovers.
140. As an operator, I want a hardware encode failure to fail the job and tell me what failed, so that I can fix the device or driver.
141. As an operator, I want no automatic software-encode fallback, so that a GPU problem does not silently turn into a multi-day CPU job.
142. As an operator, I want the UI to show which encode backends were detected (CUDA, VAAPI, VideoToolbox, AV1), so that I know the process actually sees the GPU or Mac media engine.
143. As an operator, I want logs per job (probe, plan, ffmpeg, `mkvmerge`, promote), so that I can debug a single title.
144. As a library owner, I want failed jobs to keep the original file, so that a crash never deletes the only copy.
145. As a library owner, I want to prevent a second job on a title that already has a pending sidecar, so that I do not stack competing outputs.
146. As a library owner, I want a review UI that compares source vs sidecar metadata (size, codec, duration, tracks, size/hour), so that I can decide Keep or Discard.
147. As a library owner, I want Keep to replace the original in the library path and delete the old file, so that I do not keep doubles.
147a. As a library owner, I want Keep to copy the sidecar onto the library path without creating a `.opt-new` sibling in the show folder, so that a Sonarr rescan cannot steal the staging file and fail Keep with a missing-file error.
148. As a library owner, I want Keep to ask Radarr or Sonarr to refresh the file and then run its renamer, so that codec tokens in the filename (`H264`, `EAC3 5.1`) match the new video and audio, including an extension change to `.mkv`.
149. As a library owner, I want Keep to notify every configured Plex and Jellyfin that the item changed, so that I do not have to empty trash or analyze by hand.
150. As a library owner, I want a failed notify after a successful Keep to report the notify failure without rolling back the file replace, so that I do not undo a good promote because Plex was down.
151. As an operator, I want a failed Arr rename after Keep to keep the new file in place and surface the Arr error, so that I can trigger a manual refresh.
152. As a library owner, I want Discard to delete the sidecar and leave the original, so that a bad encode is easy to throw away.
153. As a library owner, I want Keep and Discard to mark that row busy at once and return the HTTP request before a large replace finishes, so that Review does not freeze.
154. As a library owner, I want a second Keep on a row that is already keeping to be rejected, so that I cannot start two replaces.
154a. As a library owner, I want an interrupted Keep after a crash to come back as a pending card I can Keep or Discard, so that "Keeping…" is never a dead state.
154b. As a library owner, I want a Keep that already replaced the library file before the crash to count as kept and leave Review, so that I do not copy it again.
154c. As a library owner, I want Keep selected to copy at most as many files at once as my job concurrency, so that a batch Keep cannot knock the app over.
155. As a library owner, I want a failed Keep move to leave both files and show the error on the card, so that I do not lose the new encode.
156. As a library owner, I want permissions errors on Keep to fail visibly and leave both files, so that a read-only library path is not a silent loss.
157. As a library owner, I want checkboxes on completed Review cards and a Keep selected control, so that a whole show does not require one click per sidecar.
158. As a library owner, I want Keep selected to start every selected pending sidecar and tell me how many were accepted and how many were skipped, so that already-keeping cards are not started again.
158a. As a library owner, I want a Keep all control next to Keep selected, so that I can promote every waiting sidecar without ticking boxes.
158b. As a library owner, I want Keep all to confirm that it will replace each library file with its new copy, so that a misclick does not rewrite the library.
158c. As a library owner, I want Keep all to accept every pending card, skip cards already keeping, and copy at job concurrency, so that it matches Keep selected.
159. As a library owner, I want a Keep failure on one title to leave other successful Keeps in place, so that a batch is not all-or-nothing.
160. As a library owner, I want a result that is still over the cap, or larger than the original, to be kept and flagged for review, so that I decide whether to run again more aggressively.
161. As a library owner, I want to re-queue a flagged result with a more aggressive target, so that I can take another pass without starting from scratch in the UI.
162. As a library owner, I want duration and basic integrity checks before a sidecar is offered for review, so that a truncated encode is not presented as success.
163. As a library owner, I want tracks-only and stereo-only jobs to use the same sidecar and Keep path, so that review is one workflow.
164. As a library owner, I want a series suggestion, queue row, review card, history row, and error row to show show title, then season, then episode title, so that I can tell Ted Lasso S03E02 from another episode also named Chelsea.
165. As a library owner, I want a Home dashboard after login that shows files optimized, space saved, a one-line Status (the running title, how many jobs are waiting, or Idle), open suggestions, queued jobs, pending review, and error count, so that I can see whether the app is earning its keep.
165b. As a library owner, I want Queue and Review in the sidebar to show counts when jobs are running or waiting and when sidecars are in Review, so that I can see processing and Keep work from any page.
166. As a library owner, I want Home to show recent kept, flagged, failed, and discarded work, so that I do not have to open History for a glance.
167. As a library owner, I want space saved to be the sum of (original size minus new size) for successful Keeps and successful direct writes, so that the tally is a real number I can trust.
168. As a library owner, I want files optimized to count successful Keeps and successful direct writes, so that skipping Review does not hide savings.
169. As a library owner, I want Home empty-state copy that tells me to connect an Arr and wait for inspect when nothing has been kept yet, so that a new install is not a blank dashboard.
170. As a library owner, I want activity history (finished, flagged, discarded, kept, failed, cancelled), so that I can see what Polisharr already did.
171. As a library owner, I want to exclude a path, quality profile, tag, or individual title from suggestions, so that a reference archive or kids profile is left alone.
172. As an operator, I want to connect Plex and Jellyfin with their own URLs and tokens, so that notify is explicit and testable.
173. As a Plex user in the living room, I want optimized files to direct-play more often on a TV without surround, so that I am not waiting on a live transcode.
174. As a Plex user, I want smaller HEVC files, so that the NAS lasts longer and remote streams are less painful.
175. As a library owner, I want the shell to follow Arr information architecture (Home, Movies, Series, Suggestions, Queue, Review, Errors, History, Settings) with a Vision UI-inspired dark glass look, so that I can find things in a modern Arr companion.
176. As a library owner, I want iconography that matches the action: distinct sidebar icons, distinct row actions (queue, stereo, exempt, Keep, Discard, help), and distinct queue phases, so that I can scan the UI without reading every label.
177. As a library owner, I want a favicon and mobile header mark that read as Polisharr, so that the tab and the phone menu match the app.
178. As a mobile user on the LAN, I want the UI to work on a phone browser, so that I can Keep or Discard from the couch.
179. As a first-time user, I want on-page help on every primary view that explains what the buttons do and how the workflow runs (inspect, suggest, queue, review, Keep), so that I do not need a separate wiki.
180. As a first-time user, I want help copy to define sidecar, Keep, size cap, exemption, and tracks-only in everyday words, so that a junior operator is not expected to know Arr jargon.
181. As a first-time user, I want help to sit next to the control it explains and not block the action, so that I can learn without a modal gauntlet.
182. As an operator, I want a Homepage-friendly stats widget (`GET /api/widget`) that Homepage can poll with a widget key, so that the Arr Stack tile can show running title, queued, review, suggestions, and errors.
183. As an operator, I want that widget payload to stay stats-only (no Arr keys, tokens, passwords, or file paths), so that a dashboard leak is not a secret leak.
184. As an operator, I want example Homepage YAML in the docs, so that I can add the tile myself. Wiring the household Homepage `services.yaml` is outside this repo.
185. As a developer, I want every module testable from its public behavior, so that we can change ffmpeg flags or `mkvmerge` arguments later without rewriting the product tests.
186. As a developer, I want the suggestion engine to be testable with fixture inspection reports, so that language, size, and exemption rules do not need real MKV files.
187. As a developer, I want the inspector testable against recorded probe documents and small fixtures, so that codec, bit depth, language, layout, and cover-art-first 4K stay honest.
188. As a developer, I want the queue and scheduler testable with a fake clock and a long-running fake runner, so that off-peak, concurrency, cancel, restart, and UI-facing responsiveness do not need a real GPU.
189. As a developer, I want Keep, Discard, and notifiers testable against fake Arr and player APIs and a fake slow move, so that promote does not require a live Plex or NAS.
190. As a developer, I want mux and stereo jobs testable with fake `mkvmerge` and fake ffmpeg, so that track plans do not require MKVtoolnix on the developer laptop.
191. As a developer, I want auth tested for login, logout, bad password, session expiry, and local bypass on or off, so that the secure Arr login claim is real.
192. As an operator, I want a Report control that stays on screen on every signed-in page, so that I can file a bug or change request from the view I am looking at.
193. As an operator, I want Bug and Change request to open a GitHub issue with the current route, inspect leftovers, and a running job, so that I do not retype what the UI already shows.
194. As an operator, I want to attach a screenshot myself on GitHub when I need one, so that Report does not download a file or store a GitHub token.
195. As an operator, I want the report text to omit paths, API keys, tokens, and passwords, so that a public GitHub issue is not a secret leak.
199. As a library owner, I want Cancel all to stop every queued, held, paused, and running job as one operation, so that I can stop a batch without cancelling each row.
200. As a library owner, I want Cancel all to report one visible failure instead of leaving an unexplained partial result, so that I know whether the batch stopped.
201. As a library owner, I want to remove one finished Queue row or clear all finished rows, so that completed, failed, and cancelled work does not fill the operational queue forever.
202. As a library owner, I want removing Queue rows to preserve History, Review sidecars, and library files, so that clearing the operational list does not erase outcomes or media.
203. As a library owner, I want active jobs to require Cancel before Remove, so that removing a row cannot hide work that is still running.
204. As a library owner, I want Movies and Series to return a bounded first page, so that a large library becomes usable before every title has crossed the network and rendered.
205. As a library owner, I want Series to load episode details when I expand a show, so that collapsed shows do not transfer or render rows I have not asked to inspect.
206. As an operator, I want a webhook URL that Radarr and Sonarr can call when they import, upgrade, or rename a file, so that Polisharr sees new media without waiting for the 15-minute sync.
207. As an operator, I want that webhook to inspect the new or changed file and not enqueue from the HTTP handler, so that Connect Test stays harmless. When Queue new Arr imports is on, inspect of a new or upgraded Arr file may queue a sidecar. Keep still replaces the library file and does not queue that promoted file again.
208. As an operator, I want the webhook to use a generated token that is hashed at rest and never echoed after I copy it, so that Connect does not need my Polisharr password (ENG-06).

## Implementation Decisions

- This is a greenfield companion app. Do not copy, move, or wrap the previous Polisharr TypeScript, tests, Docker image, or plan file. Keep `ENGINEERING_STANDARDS.md` (ENG-01 through ENG-14) and `CODING_STANDARDS.md` as the code and prose standards. Cite those ids in review.
- New portable companion container, not a plugin inside Radarr or Sonarr. First test deploy is ubuntuserver on the same Docker network and NAS mount the Arrs already use (`/mnt/nas`, network `arr_net`).
- Library of record stays in Radarr and Sonarr. Polisharr syncs via their APIs and treats reported file paths as authoritative. No path-translation layer in v1.
- Multiple Arr instances are first-class: each has URL, API key, and enable flag. Movies come from Radarr instances, episodes from Sonarr instances.
- Arr sync and inspect are separate jobs. Persist library rows (and artwork URLs) as soon as the Arr APIs return. Return refresh as soon as lists are stored. Probe in the background with a small concurrency cap. Never re-probe when path and size match. Bound retries, then record a distinct Error. Do not increment a forever-growing failed counter.
- New imports are inspected automatically. An optional setting (`queueNewImports`, default off) may enqueue a **sidecar** after inspect of a file whose Arr-reported size changed after the setting was turned on. Keep still replaces the library file and records that size so inspect of the promoted file does not enqueue again. A later Arr upgrade with a different size may enqueue. Direct write is not used for these jobs. Turning the setting on does not queue the existing library. Radarr and Sonarr Connect may POST `/api/hooks/arr` on import, upgrade, or rename so sync does not wait for the 15-minute timer. The hook is token-authenticated (not the login cookie). A Connect Test returns 200. The hook handler itself does not enqueue. Keep asks the Arr to refresh only after Polisharr has stored the new path and kept size.
- Webhook token: generated in Settings, SHA-256 at rest, shown once. Accept `X-Api-Key`, `Authorization: Bearer`, HTTP Basic password, or query `apikey`. Missing or wrong token is 401 with one generic error. Overlapping hooks join the in-flight library sync. Prefer a targeted movie or series refresh when the payload has an Arr id; otherwise refresh the enabled Arrs.
- Preferred language is a user setting, confirmed once before the first optimize run. Optimize, queue, and Keep stay gated until first-run is complete (ENG-07).
- Size policy is GB per hour, tunable per category. Shipped defaults: Movie 1080p 2.5, Movie 4K SDR 6, Movie 4K HDR 8, TV 1080p 1.0, TV 4K 4.0. Size scoring uses the file after planned track removal. Encodes aim at the category target. When kept audio already fills that target, bulk does not size-encode; a required codec or Force encode treats the cap as the video budget and copies remaining audio on top. A codec encode of a small file (kids TV already under the cap) uses the minimum hardware bitrate instead of failing because encoder slack and mux padding ate the leftover. The cap is the encode aim, not a silent discard rule. Custom size targets that kept audio cannot fit still fail closed.
- Size category uses Arr type (movie vs TV), Arr quality or resolution when it says 2160p / 4K / UHD, and the largest playable video stream (not cover art; coded size when display size is missing). Dolby Vision or HDR selects the HDR cap. Recompute the cap when listing suggestions and when enqueueing.
- Default video target is HEVC. AV1 is opt-in and only offered when hardware encode for AV1 is present. Bit depth of the source is preserved. HDR10 is kept when the encoder can. Dolby Vision / HDR10+ transcodes are still suggested, with an explicit warning that that metadata may be lost.
- Sticky per-title size exemption: one movie or one episode. Exempt titles do not get a size or transcode suggestion. They still get language cleanup and stereo when those apply. Clearable from the same row. Not series-wide or season-wide.
- Separate exclusions (path, quality profile, tag, title) still hide a title from suggestions entirely.
- Track policy: keep all audio and subtitles tagged in the preferred language; suggest stripping other languages; drop untagged tracks except a lone untagged dialogue track. Original surround stays when stereo is added. Added stereo is AAC 2.0 tagged with the source track language (not `und`). Stereo is auto-suggested for Atmos or layouts above 5.1, and is always offered as a manual action when the file is not already stereo.
- Tool split: ffmpeg (and ffprobe) for inspect, hardware video encode, and creating the AAC stereo stream. MKVtoolnix `mkvmerge` for muxing: convert opted-in MP4 inputs to MKV, drop non-preferred tracks, attach the stereo stream, and copy chapters and attachments. Timed-text subtitles (`mov_text` and similar) are converted to SubRip so they survive remux and HEVC encode; bitmap subtitles stay copied. Let `mkvmerge` preserve all source tracks when the plan removes none. When tracks are filtered, identify the input with `mkvmerge` and translate the planned audio and subtitle selections to its track IDs; ffprobe stream indexes are not always MKVToolNix track IDs. Track-only and remux-only jobs do not video-encode. When a job needs an MP4 conversion or track cleanup and a video encode, `mkvmerge` runs first; ffmpeg reads that MKV. After mux, skip a size-only encode when the working file meets the cap or kept audio fills it. The conversion setting is off by default. Keep may change `.mp4` to `.mkv`. The container image includes ffmpeg and MKVtoolnix. Invoke both with argument arrays (`execFile`), never a shell (ENG-08).
- Default execution: one job at a time, work on the mounted Arr paths, write sidecars on the review path with ordinary copy and rename. Honor user concurrency. Optional off-peak window; a job can run now. No multi-segment encode. No local-copy-before-encode. No storage-aware layer (no SSH-to-NAS, clonefile, same-volume detection, or path maps).
- Hardware encode only (CUDA or VAAPI from devices passed into the container, or VideoToolbox when the process is running on macOS). ffmpeg listing encoders is not enough: the job uses NVENC only when an NVIDIA device is visible, otherwise VAAPI when `/dev/dri` is visible, otherwise VideoToolbox when `process.platform` is `darwin` and ffmpeg lists `hevc_videotoolbox`. A Linux container on a Mac is not darwin, so it cannot use the Apple media engine. VideoToolbox encode passes `-allow_sw 0` so ffmpeg cannot fall back to a CPU encoder. VAAPI encode uploads frames to the render node instead of calling `hevc_nvenc`. Hardware failure fails the job and is shown. No automatic software fallback (ENG-05).
- Output is side-by-side: write a sidecar to a configurable NAS review path that is not an Arr library root. Original stays until Keep or Discard (ENG-09). A pending sidecar locks a second job on that title.
- Write mode: sidecar + Review is the default. Settings Direct write applies to bulk jobs when they start, including jobs already waiting in Queue. A title-page override and Queue new Arr imports lock sidecar or direct write for that job. Direct write still encodes to the review folder, integrity-checks, then replaces the library file and deletes the review copy.
- Keep: accept immediately, replace in the background, delete original after the library path holds the new file, request Radarr/Sonarr to refresh (so MediaInfo matches the new file) and then rename using the Arr naming format, notify all configured players (Plex and Jellyfin in v1). Notify or rename failures are reported and do not roll back a successful file replace. Polisharr stores the path Arr reports after a successful rename. Keep selected accepts every selected pending card at once, then copies at most as many files at once as the job concurrency setting. Keep all does the same for every pending card after an on-page confirm. After a crash, a Keep that did not finish returns to pending with a visible error; a Keep that already replaced the library file counts as kept and leaves Review; a missing sidecar is not treated as success. Discard deletes the sidecar only.
- Missed target or larger-than-source: keep sidecar, flag for review, let the user re-run more aggressively. A sidecar within 5% of the cap is not a miss. Size-mode encodes subtract kept-audio size and encoder slack from the video bitrate so lossless tracks that stay in the file do not blow the cap. Integrity and duration checks still apply. Do not copy a source duration onto an encode result.
- Auth is Arr-style local login with a modern password hash and sessions; optional local-address bypass. Secrets are hashed or encrypted at rest and never echoed after save (ENG-06).
- Responsiveness is a product requirement. Enqueue, Cancel, Keep, Discard, and page loads must not wait on mux, encode, or a cross-device replace. ffmpeg and `mkvmerge` run as child processes; drain their output without unbounded buffers. Status reads stay fast while a job runs. The UI does not overlap polls for the same endpoint. Queue and Review refresh the first page without discarding pages the operator already loaded. A conservative performance mode may exist; it must not silently change configured concurrency.
- List reads use batched public read models instead of loading related state once per row. Movies, Suggestions, Queue, Review, Errors, and History return bounded pages with continuation metadata. Series returns show summaries first (episode total, healthy count, suggestion count) and fetches one show’s episodes when the operator expands it. Suggestion rows and error rows include an `href` to the title page when the library item is known. Home and the Homepage widget use aggregate counts plus a bounded recent-activity query. The browser may retain pages and expanded-show results until Refresh invalidates them.
- Home dashboard is the post-login landing page. Files optimized equals successful Keeps and successful direct writes. Space saved equals the sum of original size minus new size for those outcomes. Status is a full-width line (running title, waiting count, or Idle). Files optimized and space saved are the large tiles. Suggestions, Queue, Review, and Errors are linked work tiles. Recent activity lists kept, flagged, failed, and discarded work.
- UI follows Arr information architecture with a Vision UI-inspired presentation (dark glass, neon accents) as visual inspiration, not Creative Tim template code. Library pages are sortable tables with posters on the row, not card grids as the default. Iconography is required and must be distinct per nav item and action. Small-viewport layout is required. Contextual help lives on each primary page next to the controls it explains.
- Homepage widget: `GET /api/widget` (alias `/api/homepage`), widget key or local-address bypass, stats only. Example YAML in docs. Installing the tile on the household Homepage host is out of this repo.
- Report a bug: a fixed on-screen control on signed-in pages. Bug and Change request open GitHub’s new-issue form with route, inspect leftovers, and running job. The operator attaches a screenshot on GitHub when one would help. No GitHub token, no auto capture, no download. Prefill never includes paths or secrets (ENG-06). Login and first-run have no Report control.
- Modules (each with a small interface other code depends on):
  - Auth
  - Settings and first-run
  - Library sync
  - Media inspector
  - Suggestion engine
  - Job queue and scheduler
  - Optimize runner
  - Review and promote
  - Player notifier
  - Activity and savings
  - Web UI (including widget API, global search, Errors, Home, and help)
- The inspector and suggestion engine do not mux or encode. The runner does not decide policy. The promoter does not encode. The notifiers do not touch disk. Library sync does not wait on inspect.
- Queue Cancel is first-class: queued, held, and running jobs can be cancelled. Cancel marks the job cancelled immediately, aborts the in-flight optimizer when possible, deletes that job’s temp or sidecar output, never touches the library original, and never writes a Review item. A job that finishes after cancel stays cancelled. Succeeded, failed, and already-cancelled jobs return a conflict.
- Queue bulk operations belong to the job queue module. Cancel all commits the visible status change for every active job before signalling running child processes. Remove and Clear finished hide only terminal rows from Queue. They retain job data needed by Review and preserve History, sidecars, suggestions, and library files. Active rows return a conflict until Cancel finishes.
- Types describe domain values (ENG-02). Arr JSON, ffprobe output, and `mkvmerge` identification enter as `unknown` and are parsed once (ENG-03). No `any`. Names match the domain (ENG-11). One module, one reason to change (ENG-10). Config stays twelve-factor (ENG-12).
- Suggestion and help copy uses everyday words (CODING_STANDARDS RULE-01, RULE-03). Do not require the reader to know remux, sidecar, or Arr jargon without a definition. Fail closed: do not return 200 when Force, stereo, Keep, or inspect did not do the work (ENG-05).

## Testing Decisions

- A good test asserts external behavior of a module through its public interface: inputs (inspection reports, settings snapshots, fake Arr/player HTTP, fixture media, recorded probe documents, fake clock, fake ffmpeg, fake `mkvmerge`) and outputs (suggestions, job state, sidecar result, Keep/Discard effects, dashboard tallies, error rows, user-visible sentences). Tests do not lock implementation details such as ffmpeg flag order, `mkvmerge` argument order, SQL tables, or React internals (ENG-04).
- Tests will be written for every module listed above, including the Web UI at the API and handler layer the UI uses. A full visual browser matrix is not required for v1. A long-running fake optimizer must prove enqueue, status reads, navigation-facing endpoints, and Cancel stay responsive.
- Library sync: given fake Radarr/Sonarr payloads from one or many instances, the normalized library, paths, instance provenance, and artwork URLs are correct; auth and connectivity failures surface as connection errors; refresh returns without waiting on probes.
- Media inspector: fixture or recorded probe documents cover codec, bit depth, HDR/DV, duration, size/hour, audio layout, preferred/other/untagged languages, cover-art-first 4K, coded size only, and a 2160p Arr label on a 1080p-looking probe. A probe that always throws on one path increments errors once, ends the walk, and appears on Errors with path and reason. Unchanged path+size is not probed again.
- Suggestion engine: table-driven cases for under/over cap, HEVC default, AV1 only when capability is on, tracks-only vs transcode, stereo suggest vs manual, DV warning, dismissals, movie vs TV category, 4K vs 1080p category, sticky exemption (no size suggestion, still tracks/stereo), opt-in MP4 remux-only work, and Now/After honesty.
- Settings and first-run: optimize is blocked until language is confirmed and required connections exist; caps persist; exemption persists; the off-by-default MP4 conversion setting persists; the Encode section exposes an explicit save action for concurrency and scheduling; review path inside a library root is rejected.
- Job queue and scheduler: default concurrency 1, user concurrency honored, off-peak hold vs run-now, no second job while a sidecar is pending, cancel queued/held/running, atomic Cancel all across mixed statuses, remove one terminal row, Clear finished without removing active rows or History, cancelled work does not become a review, restart-safe queue, enqueue returns while a fake runner is still going. Queue list order is running, then waiting, then finished; scheduler `listJobs` stays enqueue order. `GET /api/jobs` includes `finishedCount`. After 55 finished jobs plus 1 running and 1 queued, the first page starts with the running job, then the queued job.
- Optimize runner: review-path output (never library folder), `mkvmerge` used for track mux and opted-in MP4 conversion, ffmpeg used for hardware video and stereo AAC creation, MP4 remux before transcode, timed-text subtitles converted to SubRip before mux and HEVC encode, hardware failure becomes a failed job with a user-visible error, integrity/duration checks, temp cleanup, disk-space preflight, bounded logs, real phase and progress on the public job payload. Accept MKVToolNix exit code 1 as a completed mux with warnings, then probe the output. Reject an output that lost a planned audio or subtitle track. Treat exit code 2 as failure and preserve its stdout or stderr diagnostic. No live NAS or GPU.
- Review and promote: Keep returns while a fake slow move is still running; GET review shows in-progress; a second Keep is rejected; Keep replaces and deletes original and calls Arr rename/refresh; Keep selected accepts two pending and skips one already-keeping; Keep selected copies honor job concurrency; Keep all accepts every pending card after confirm and skips already-keeping; GET review includes pendingCount; Discard deletes sidecar only; flagged-over-cap stays; a custom size-mode job flags when output is larger than source or more than 5% over the typed target; Encode smaller discards the sidecar and enqueues a tighter size-mode job; Arr rename failure does not delete the new file; permission failures leave both files. Restart recovery: a `keeping` row whose sidecar and original remain becomes pending with an interrupted error; a `keeping` row whose library file already matches the sidecar size is recorded as kept and dropped; a `keeping` row whose sidecar is gone and whose original is untouched becomes pending with a sidecar-gone error and Keep is not 200.
- Player notifier: Plex and Jellyfin are called after Keep; a player outage is reported and does not undo Keep.
- Activity and savings: a Keep of a 10 GB source to a 4 GB sidecar increases files optimized by 1 and space saved by 6 GB; a successful direct write counts the same way; Discard does not; failed Keep does not.
- Auth: set password, login, bad password, logout, session expiry, optional local bypass on/off. No plaintext password at rest. Widget route: key works, missing key on a public IP is 401, payload has no secrets or paths. Arr webhook: header or Basic token starts sync; Test is 200; bad token is 401; GET settings has `hasWebhookToken` only; Download with a movie id upserts that title and does not enqueue a job unless Queue new Arr imports is on and inspect later produces a suggestion.
- Report: the GitHub URL encodes route and inspect leftovers; a sample path or secret is absent from the query.
- Web UI / HTTP: bounded Movies, Suggestions, Queue, Review, Errors, and History pages; Series summaries with healthy and suggestion counts and no path; suggestion rows, error rows, and job rows include `href` when the library item is known; episodes for one expanded show; search `q`; enqueue; Keep/Discard; Home payload includes Status; settings (credentials, Arr enabled, widget key mint). `GET`/`POST /api/integrations` require a session. Job pages expose write mode and size vs quality; `GET /api/jobs/:id/logs` is bounded. Queue Working now is not displaced by finished rows. Seeded list tests assert first-page cardinality and continuation metadata. Large-library tests assert a bounded first response and no episode payload before expansion. Polling cleanup when a request is still in flight. Force/stereo HTTP: unreadable is not 200; stereo no-op is not 200. Unauthenticated integrations writes are 401.
- Prior art: the previous Polisharr test suite is not to be reused. Tests are written next to the new modules, with fixtures, not the live NAS.

## Out of Scope

- Replacing Radarr, Sonarr, Plex, or Jellyfin, or becoming a download client, indexer, or subtitle downloader (Bazarr).
- Lidarr, Readarr, Whisparr, or other Arrs in v1.
- Automatic software (CPU) encode fallback.
- Auto-Keep of new imports, auto Direct write of new imports, and auto-queue of the existing library when Queue new Arr imports is first enabled.
- Multi-segment / split-file parallel encode.
- Storage-aware transfers: SSH to the NAS, clonefile, same-volume detection, CIFS/NFS path maps, and copy-to-local-disk before encode.
- Writing sidecars into movie or show library folders.
- Live or on-the-fly playback transcoding (that remains the player’s job).
- Path mapping between different mount layouts in v1 (Polisharr must see the same paths as the Arrs).
- Guaranteeing Dolby Vision or HDR10+ metadata survival through hardware encode.
- Migrating or wrapping the previous Polisharr codebase or the older Windows/WSL `ffmpeg-reencode` scripts.
- Multi-user accounts or SSO beyond a single Arr-style admin login.
- Changing library files in place before Keep.
- Series-wide or season-wide size exemptions.
- Discard selected and Discard all (Keep selected and Keep all are in scope).
- Using Creative Tim / Vision UI Dashboard source or license as the app; the demo is visual inspiration only.
- Installing or editing the household Homepage `services.yaml`. The widget API and example YAML are in scope.

## Further Notes

- This PRD supersedes GitHub issue #1 and the retired `plans/optimizarr.md`. Follow-up issues #2 through #19 are folded in as first-class v1 behavior, except household Homepage wiring (#14) and except storage-aware copy, multi-segment, and auto-Keep, which are dropped. GitHub issue #35 (Report a bug) is shipped behavior: a GitHub new-issue form with route and job context. The operator attaches a screenshot on GitHub when one would help. GitHub issue #41 (Arr webhooks) is shipped behavior: token-gated `POST /api/hooks/arr` starts library sync and inspect. The handler does not enqueue; optional Queue new Arr imports may enqueue a sidecar after inspect.
- The 2026-08-21 open-issue audit and fixed-issue evidence live in [open-issues.md](../plans/open-issues.md). Remaining implementation after the 2026-08-29 review lives in [review-follow-up.md](../plans/review-follow-up.md).
- First install target is ubuntuserver, which already runs Radarr, Sonarr, Plex, Jellyfin, and an NVIDIA stack. CUDA is the on-box encode path; VAAPI remains required for portable installs.
- Media lives on the Synology Plex share mounted at the same network path the Arrs use. The review path must also live on the NAS but outside those library roots.
- The operator already has working HEVC NVENC and English-only remux habits. Polisharr should feel like that workflow with a library, suggestions, review, and a running savings tally, not a blank ffmpeg form.
- After this PRD is accepted, the existing application tree is wiped. A later agent writes a new implementation plan from this document. That plan must not import the old code.
