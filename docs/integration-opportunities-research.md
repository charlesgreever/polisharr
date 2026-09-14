# Polisharr Feature Opportunities

Research date: 2026-09-14. Audience: the project owner choosing the next features. These are proposals, not changes to the product contract. External documentation establishes the available integration points; the proposed workflows are design inferences.

## Existing Foundation

[README](../README.md) already describes multiple Radarr/Sonarr instances, import webhooks, optional automatic queueing, HEVC/AV1, custom track plans, language identification, ISO remux, direct write, distributed workers, player refreshes, and a Homepage widget. These should not count as new ideas. [Arr profile code](../src/server/arr-profiles.ts) already creates profiles and assigns profiles that prevent upgrades. [The existing follow-up plan](../plans/series-needs-work-and-replace.md) proposes savings sorting, broader replacement searches, and removing titles from Arr tracking.

## Recommended Opportunities

### 1. Fix the Files That Cause Jellyfin Playback Trouble

Show “This film required audio conversion on the living-room TV” or “These subtitles forced video conversion,” then offer the smallest relevant fix. Rank repeated playback problems above files that are merely large. Compare later playback with the original observation to show whether the change helped.

Jellyfin exposes authenticated `GET /Sessions`; its session and transcoding models include the current item, client, direct audio/video state, and conversion reasons. Polisharr would need to record observations because current sessions are not a historical analytics database. Match the actual file and edition, especially where multiple Arr instances contain the same title. [Session endpoint](https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/SessionController.cs), [session model](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Controller/Session/SessionInfo.cs), [transcoding model](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Model/Session/TranscodingInfo.cs).

Do not promise that HEVC or AV1 will play directly everywhere. Jellyfin documents client-specific support and subtitle burn-in; a codec recommendation should reflect the household's devices. [Jellyfin codec support](https://jellyfin.org/docs/general/clients/codec-support/).

### 2. Let Movie Night Take Priority over Background Encodes

Use Jellyfin sessions to stop starting new jobs on a GPU that is serving playback. Defer Keep/direct write for the file someone is watching. Resume waiting work after playback ends. Start with admission control; interrupting an active encode adds recovery complexity. Existing per-node job slots provide a natural place for this policy, but Polisharr must explicitly map each player server to the worker sharing its GPU. [Existing worker design](../plans/multi-node.md), [Jellyfin sessions](https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/SessionController.cs).

### 3. Ask Bazarr for Usable Subtitles

Offer “Find English text subtitles” when a title has no preferred subtitles or only image subtitles that cause playback conversion. Keep the original subtitles until the replacement has been checked. Preserve separate choices for forced translations and captions for deaf or hard-of-hearing viewers.

Bazarr's movie subtitle endpoint accepts a Radarr movie ID, language, forced flag, and hearing-impaired flag for downloads. This gives Polisharr a concrete handoff without building its own subtitle-provider integrations. Confirm episode endpoints and deployed-version behavior before implementing Sonarr support. A returned success must not become a claim that the subtitle matches the edition or timing. Coordinate any Arr rename before locating downloaded sidecars. [Bazarr endpoint source](https://raw.githubusercontent.com/morpheus65535/bazarr/master/bazarr/api/movies/movies_subtitles.py).

### 4. Diagnose Conflicting Arr Acquisition Rules

Extend the existing profile assignment into a preview: “Polisharr will reduce this movie, but your acquisition profile prefers a larger release.” Show profile, upgrade, and custom-format settings alongside the proposed result. Provide an explicit choice of which app controls those settings.

Recyclarr syncs quality profiles, custom-format scores, size definitions, and media naming into Radarr/Sonarr. A Polisharr report could reveal configuration conflicts before either app rewrites settings. Begin with reading and explaining existing settings; do not have two tools continually overwrite the same profile. This extends the existing prevention of upgrades rather than introducing it. [Recyclarr getting started](https://recyclarr.dev/guide/getting-started/), [existing profile implementation](../src/server/arr-profiles.ts).

### 5. Turn Seerr Requests and Playback Reports into Prioritized Work

Prioritize newly requested titles after the Arr import completes. Turn a Seerr issue about audio or subtitles into a Polisharr inspection with a link back to the report. Keep “requested,” “downloaded,” and “optimized” distinct so users do not receive an inaccurate ready-to-watch message.

Seerr can post custom JSON with authentication headers. Its variables include notification type, request and issue IDs, TMDB/TVDB IDs, Jellyfin media ID, and separate standard/4K availability. These support matching requests to library items; a request event alone does not prove the media file exists. [Seerr webhook documentation](https://docs.seerr.dev/using-seerr/notifications/webhook/).

### 6. Avoid Encoding Files Scheduled for Removal

Let Polisharr exclude titles in a Maintainerr collection scheduled for deletion, and offer a separate “shrink and retain” list for titles the owner wants to keep. This avoids spending hours encoding a film that another app will remove tomorrow.

Maintainerr builds collections from rules and applies configured actions after a delay. Its rules include Jellyfin watch-history properties. Collection membership is a plausible initial integration point; research did not establish a stable public Maintainerr API for an atomic “rescue this item” action. Recheck membership before starting work and leave deletion ownership with Maintainerr. [Maintainerr workflow](https://docs.maintainerr.info/3.5.0/works/), [rules](https://docs.maintainerr.info/rules/).

## Useful Additions inside Polisharr

- **Reusable audio and subtitle policies.** Extend the existing preferred-language and stereo settings with original audio plus preferred dub, commentary retention, forced subtitles, accessibility captions, and defaults that match those choices. The [track model](../src/server/types.ts) already records commentary, default, forced, and SDH information. Missing or incorrect flags require an “unknown” state and a preview of tracks that will remain.
- **Review clips and optional undo.** Add short before/after clips for motion, dark scenes, and dialogue. [Output validation](../src/server/optimize.ts) checks media integrity, but it does not establish visual quality. [Promotion](../src/server/promote.ts) removes its temporary backup after success; retaining originals for a user-selected period would add an actual Undo feature and needs a storage limit.
- **Optional consistent-volume stereo.** Offer a separate AAC track with dialogue-friendly loudness while preserving the original surround mix. FFmpeg provides `loudnorm`; its availability makes this feasible, but the product must let the owner listen before choosing the result. [FFmpeg audio filters](https://ffmpeg.org/ffmpeg-filters.html#loudnorm).
- **Sampled quality estimates.** Show a comparison score alongside review clips to identify suspicious encodes. FFmpeg provides `libvmaf`; availability depends on the FFmpeg build. Treat sampled scores as supporting evidence, especially for HDR and scenes outside the sample, rather than an automatic quality guarantee. [FFmpeg libvmaf](https://ffmpeg.org/ffmpeg-filters.html#libvmaf).
- **Outbound events.** Publish “review ready,” “job failed,” and “file kept” events with stable IDs, so a notification service or home automation can summarize work. Existing inbound Arr webhooks and the Homepage widget do not provide this outgoing event stream. Avoid notification buttons that replace files without returning to the authenticated review screen. [Current integration surface](../README.md).

## Suggested Order

Start with playback-aware scheduling and review clips: both improve daily use without changing acquisition rules. Next add Jellyfin playback observations and Bazarr handoff, which let Polisharr explain and fix real viewing problems. Add reusable track policies and the Arr conflict report after those. Seerr priority and Maintainerr exclusions can follow as optional connectors.

Spec review: pass for research only; proposals remain outside the current product contract until accepted. Prose review: pass against RULE-01 through RULE-12; no exceptions. No application files changed or tests required.
