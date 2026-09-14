# PRD: Playback Diagnostics, Playback Protection, and Review Previews

Date: 2026-09-14. Status: proposed specification, ready for implementation review. Audience: the project owner and engineers building these features.

Implementation plan: [Playback and Review](../plans/playback-and-review.md). Background: [integration research](integration-opportunities-research.md).

## Problem Statement

Polisharr inspects media and recommends smaller files or cleaner tracks. It does not know which files cause trouble during Jellyfin playback. A smaller file can still require conversion on a particular TV.

Background encodes can compete with playback on the same computer. Keep and direct write can also replace a file while someone watches it. Fixed off-peak hours cannot respond to an unexpected movie night.

Review compares size, codec, duration, and tracks. These facts help verify an encode, but the owner must leave Polisharr to compare its picture and sound.

## Outcome and Scope

Deliver three features:

1. Explain observed Jellyfin playback conversions and offer relevant, explicit repair plans.
2. Hold new work on selected encode nodes during playback and defer replacement of files that are playing.
3. Generate matching before/after clips for a pending Review result.

These features extend the existing application. [The base PRD](prd.md) and [v2 PRD](v2%20prd.md) continue to govern other behavior. This document takes precedence only for the changes listed below.

| Existing Contract | Scoped Extension |
| --- | --- |
| Player integration tests connections and refreshes libraries | Opted-in Jellyfin connections also supply playback observations |
| Scheduling uses off-peak hours, node availability, and slots | Playback protection adds another admission condition |
| Direct write skips Review after validation | A playback-blocked direct write retains its output in Review until replacement is allowed |
| Review compares file facts | Review also offers optional temporary preview clips |
| Video encoding requires hardware | Preview video also requires supported hardware; no software encode fallback |
| Arr and Polisharr use identical media paths | Exact path matching remains required; this release adds no mount-path translation |

Undo Keep, retained originals, Bazarr, Plex playback monitoring, and quality scores are later work. The current temporary replacement backup remains a crash-recovery mechanism.

## Existing Implementation

The implementation baseline is the working tree inspected on 2026-09-14. Other library-filter and replacement work is in progress and remains separate.

| Area | Current Behavior and Source |
| --- | --- |
| Jellyfin | Connection test and library refresh in [notify.ts](../src/server/notify.ts); title links in [external-links.ts](../src/server/external-links.ts) |
| Scheduling | Local admission, off-peak holds, remote claims, and completion in [jobs.ts](../src/server/jobs.ts) |
| Cluster | Worker polling and leases in [worker-loop.ts](../src/server/worker-loop.ts), [cluster.ts](../src/server/cluster.ts), and [store.ts](../src/server/store.ts) |
| Review | File facts and Keep/Discard controls in [Review.tsx](../src/web/pages/Review.tsx) |
| Integrity | Output probe, duration, codec, and track checks in [optimize.ts](../src/server/optimize.ts) |
| Promotion | Replacement and player notification in [promote.ts](../src/server/promote.ts) |

## Product Defaults

The following values are product decisions for this release. They are not promises made by Jellyfin.

| Setting or Limit | Initial Decision |
| --- | --- |
| Observe Jellyfin playback | Off for each connection |
| Protect encode nodes | Off; owner selects node IDs explicitly |
| Protect file replacement | Off; owner enables it and selects covered Arr instances; initial selection is all |
| Observation history | 30 days; maximum 50,000 summarized viewing occurrences globally, oldest first |
| Polling | Every 10 seconds per enabled connection; one request cycle at a time |
| Request timeout | 5 seconds per Jellyfin request |
| Snapshot freshness | Stale after 30 seconds without a complete successful session response |
| Admission after idle | Two successful idle observations and at least 30 seconds since the last blocking observation |
| Replacement preflight | A successful session snapshot no older than 5 seconds, refreshed asynchronously when necessary |
| Preview length | 15 seconds; shorter when either file ends sooner |
| Preview sample starts | 10%, 50%, and 85% of the common playable duration; also accept a custom timestamp |
| Preview output | At most 1080p, H.264 video and AAC stereo in MP4 |
| Preview storage | Dedicated subdirectory of the review path; 2 GiB global cache, including reserved work |
| Preview expiry | 24 hours or removal of the Review result, whichever happens first |
| Preview concurrency | One pair per node and two pairs across the cluster; each pair consumes one normal node slot |
| Preview timeout | Five minutes of execution per pair; time waiting for a node is separate |

Polling, timeout, and concurrency limits must be injectable for tests. Keep the initial UI focused on feature enablement, covered libraries, and node selection.

## Feature A: Jellyfin Playback Diagnostics

### User Experience

Add a Playback page with Recent problems and Recent observations views. A title page shows its own observations and links to Playback. Each entry names the movie or episode, player connection, device label, time, playback method, and observed reason.

Use concrete sentences such as “Jellyfin converted the audio on Living Room TV.” Show the original reason when Jellyfin supplies one. Missing data reads “Jellyfin did not report the reason.”

The default problem order is distinct affected viewing occurrences in the last seven days, then most recent occurrence. Show that time window beside the count. A filter switches to 30 days.

Separate observed facts from suggested actions. “Open repair plan” opens the existing custom-plan editor with a proposed change and explanation. The owner reviews and queues it through the normal flow.

### Requirements

| ID | User Story and Acceptance |
| --- | --- |
| PD-01 | As an owner, I can enable observation for an existing Jellyfin connection. Test playback access verifies all-session credentials and reports missing access separately from a basic connection failure. |
| PD-02 | As an owner, I can see client, playback method, selected track information when available, and raw plus translated conversion reasons. Missing or unknown fields remain explicit. |
| PD-03 | As an owner with multiple versions, I see observations attached only to the matching physical file. A title, TMDB ID, or episode name alone never authorizes a file repair. |
| PD-04 | As an owner, I see one viewing occurrence with accumulated reason changes instead of one problem for every poll. Counts describe observed occurrences, not all plays or completed watches. |
| PD-05 | As an owner, I can filter by title, Jellyfin connection, client, date window, and reason family. HTTP pages cap at 100 entries and preserve filters during refresh. |
| PD-06 | As an owner, I can open a relevant repair draft. Observation, enablement, or a suggestion never queues, rewrites, removes, or searches for media automatically. |
| PD-07 | As an owner, I can dismiss a recommendation for a file revision, device, and reason. Ordinary repeated polling does not restore it. A new file revision can receive a new recommendation. |
| PD-08 | As an owner, I can compare observations before and after Keep. A later qualifying observation can say “Direct playback observed on this device after Keep.” With no qualifying observation, the result remains “Not yet observed.” |
| PD-09 | As an owner, I can disable history collection and clear stored history. Live playback protection can continue without retaining viewing history. |
| PD-10 | As an owner, I can see stale connections and unmatched playback. Neither appears as a corrupt media file in Errors. |

### Identity and Evidence Rules

Use Jellyfin connection ID, session ID, item ID, and selected media-source ID as remote identity. Resolve the selected media source to its path through authenticated Jellyfin data. Match that path to the actual local library file.

Reuse exact-match lookup helpers where suitable. Do not reuse a title-link fallback that can choose a different edition. Normalize paths according to the host filesystem; do not lowercase case-sensitive paths or match by basename.

A local revision includes canonical path, size, high-resolution modification time, and stable file identity where available. It is a change detector, not a content checksum. Revalidate it before applying a repair or generating a preview.

All local rows sharing the same verified physical file receive the observation. A shared Sonarr episode file still counts as one affected file. Different files of the same title remain separate.

When resolution fails, show an unmatched observation. Users can inspect the problem, but repair actions stay disabled. Different mount layouts require correcting configuration outside this release.

Collapse repeated polls into an occurrence keyed by connection, session, item, and media source. After two complete polls omit that playback identity, close the occurrence. A return starts a new occurrence. A collection outage or restart closes the old occurrence with an observation-gap label; it does not prove playback ended.

Store reason changes within the occurrence. Count it once per reason family. History includes only minimal device and media facts. Do not persist usernames, IP addresses, tokens, full session JSON, or remote-control capabilities. Disclose device-label and viewing-history collection beside the enable control.

### Initial Recommendation Rules

| Observed Evidence | Proposed Response | Limit |
| --- | --- | --- |
| Audio conversion; inspected selected audio is surround; no suitable preferred-language stereo exists | Draft an additional AAC stereo track using the existing custom-plan operation | Preserve the source mix; conversion alone does not prove stereo will fix every device |
| Audio conversion with a suitable stereo track already present | Explain which existing track to try in Jellyfin | No duplicate audio track or encode job |
| Subtitle conversion or burn-in reason | Explain the subtitle format and open track details | No automatic subtitle removal, OCR conversion, or Bazarr download |
| Video codec, profile, level, or bit-depth incompatibility | Show the reported constraint and open the custom editor without an automatic video target | HEVC/AV1 encoder availability does not establish client compatibility |
| Bitrate limitation and an existing inspected size-reduction suggestion | Link to that suggestion and explain that network/client limits may still apply | No invented bitrate target or automatic repeat encode |
| Container-only conversion | Explain that video may remain unchanged and show the container | MP4-to-MKV conversion is not a universal playback fix |
| Unknown reason or incomplete stream data | Display the observation without a repair recommendation | No guessed cause |

Existing exclusions, pending-review locks, source checks, language confirmation, and hardware checks apply to every repair. Existing automatic import queueing must not pick up playback recommendations implicitly.

Post-Keep comparisons require the same device identity, selected-track roles, and compatible playback context. Show changed context rather than claiming an improvement when local/remote mode or selected subtitles differ. Observational comparisons never claim that Polisharr caused the outcome.

## Feature B: Playback-Aware Scheduling and Replacement

### User Experience

Settings offers “Let Jellyfin playback take priority” per connection. The owner selects the encode nodes that share resources with that server. A separate control protects replacement in selected Arr libraries.

Queue displays “Waiting for Jellyfin playback to finish” or “Waiting for Jellyfin playback status.” Node details name the blocking connection. Run now continues to bypass only off-peak hours.

This release stops new work from starting. It lets running encodes finish. It does not suspend ffmpeg, stop a viewer, or move jobs pinned to a named node.

### Requirements

| ID | User Story and Acceptance |
| --- | --- |
| PP-01 | As an owner, I explicitly map a Jellyfin connection to protected nodes. Playback protection works for local admission and remote claims, including preview tasks. |
| PP-02 | As an owner, I see mapped nodes hold new processing during any unpaused video playback, including Direct Play. This conservative policy does not infer an exact GPU from Jellyfin's codec backend. |
| PP-03 | As an owner, I see paused video release node protection after the idle cooldown. Its file remains protected against replacement while Jellyfin still reports it as the current item. |
| PP-04 | As an owner, I see work resume after the idle conditions are satisfied. Off-peak, manual pause, disabled nodes, capability checks, and existing queue order still apply. |
| PP-05 | As an owner, I see pinned work remain on its node. Unassigned work may run on another capable, unblocked node through the existing pool policy. |
| PP-06 | As an owner, I see stale or failed monitoring hold new work on mapped nodes and replacement in covered libraries. An unavailable server never implies an idle server. |
| PP-07 | As an owner, I can request Keep while a file is playing. Polisharr records that request and displays a cancellable wait; the original and finished copy remain intact. |
| PP-08 | As an owner using direct write, I see a validated blocked result in Review as “Waiting to replace after playback.” The encode slot and remote lease are released; replacement resumes on the master. |
| PP-09 | As an owner, I can cancel a waiting replacement without discarding the result. The card returns to ordinary pending Review. Discard explicitly cancels the intent before deleting the finished copy. |
| PP-10 | As an owner, I see Keep selected/all report started, waiting, and skipped counts. Repeated requests do not create duplicate replacement intents or savings entries. |
| PP-11 | As an owner, I can restart the master while replacement waits. The persisted intent survives, but replacement requires fresh observations after restart. |
| PP-12 | As an owner, I receive a visible error if the original changed before deferred replacement. Polisharr cancels the intent and preserves the result for review; it does not replace an Arr upgrade. |

### Protection Policy

An unpaused session with a current video item blocks mapped nodes. A paused current item blocks only replacement. A current video with missing pause state blocks both conservatively. A session with no current item does not block by itself; audio-only sessions do not trigger video protection.

A reported current item whose media type is missing remains potentially video and blocks conservatively. Do not infer audio-only playback from an incomplete response.

Use current-item reports rather than treating LastActivityDate as a playback stop event. When Jellyfin retains a paused item, the wait can continue indefinitely. The UI explains this and identifies the connection.

For exact file matches, protect all aliases and shared episode rows. If a current video cannot be resolved, hold replacement throughout that connection's selected Arr libraries. Matching uncertainty must remain visible.

Multiple connections combine their blocks. A node or file becomes eligible only when every relevant connection allows it. Disabling protection removes that connection's block after Settings saves; the UI explains that queued replacements may then resume. Disabling or deleting the underlying connection also explains and removes its protection rules.

At startup, protected resources are unknown and held until monitoring succeeds. A partial or malformed session response cannot clear a previous block. Read-only status endpoints use cached state and never wait for Jellyfin.

Immediately before replacement, obtain the fresh snapshot inside the master replacement slot. Revalidate the source revision and acquire the existing file-level mutation lock. If any condition fails, return to waiting or pending with a specific reason.

Jellyfin and Polisharr do not share a transaction or playback lock. A viewer can start between the final check and file replacement. The feature reduces this race; it cannot guarantee that nobody starts playback during Keep. Already-started replacement completes through existing crash recovery.

### Deferred Replacement Contract

Review gains a distinct waiting state with the intent origin: explicit Keep or configured direct write. Each intent records source revision, sidecar revision, request time, and blockers. Only those two authorized origins may resume automatically.

Capture the source revision before encoding begins. At completion, verify that the source still matches before creating a replacement intent. Capturing only the current revision after encoding could mistake an Arr upgrade for the original input.

The job becomes succeeded when its validated output reaches deferred Review. That means the encode finished; it does not mean the file was kept. History and savings update only after successful replacement.

Normal pending sidecars never gain an automatic replacement intent. Newly imported jobs retain their existing sidecar-only behavior. No saved-setting change retroactively turns ordinary pending Review cards into direct write.

Replacement state transitions are pending → waiting → keeping → removed on success. A clear Keep can enter keeping directly. Cancellation returns waiting → pending. Failure returns keeping → pending with an error and no automatic retry loop.

Keep selected/all targets pending cards. Waiting cards are skipped because they already have an intent. Review exposes separate pending, waiting, and keeping counts; its total includes all retained cards. Existing lock checks include waiting cards everywhere.

## Feature C: Before/After Review Previews

### User Experience

A pending or waiting Review card offers “Compare clips.” Opening it lists the three sample positions without starting work. Selecting a position requests one matching pair. The owner can enter a different timestamp.

Show Original and Finished copy with linked seek/play controls and a single audible side. Desktop may show both; mobile uses an A/B switch. Track selectors show language, channels, codec, and whether a track was added or removed.

The default selects corresponding retained audio, or original surround and the added stereo when that is the change under review. The owner can change either selection. The original surround preview is downmixed for browser playback and must be labelled accordingly.

### Requirements

| ID | User Story and Acceptance |
| --- | --- |
| RP-01 | As an owner, I request previews on demand for a specific Review card. Opening Review never starts encodes for every result. |
| RP-02 | As an owner, I compare the same source-relative interval from both files. The player keeps displayed positions within 250 ms, pausing to resynchronize when necessary. |
| RP-03 | As an owner, I hear only one side at a time and can switch with keyboard controls. Labels and focus remain usable on mobile and with assistive technology. |
| RP-04 | As an owner, I see the preview scale, selected audio, and any HDR conversion. The UI explains that preview encoding can hide or introduce differences. |
| RP-05 | As an owner, I can generate a clip on a capable worker when the master has no GPU. Generation obeys normal node slots and playback protection. |
| RP-06 | As an owner, I see a precise unsupported or failed state when no node can produce the required preview. Facts, Keep, and Discard remain usable. |
| RP-07 | As an owner, I can cancel preview generation without cancelling the optimize job or discarding its result. Cache cleanup never touches the source or sidecar. |
| RP-08 | As an owner, I see changed or missing files invalidate cached previews. A clip from an earlier revision is never presented as the current pair. |
| RP-09 | As an owner, I can Keep or Discard after requesting previews. Polisharr cancels active preview readers and waits for their release before moving or deleting their input files. |
| RP-10 | As an owner, I can retry a failed preview. Preview jobs, failures, and cache files do not change optimization totals, savings, library Errors, or ordinary Review counts. |

### Rendering Rules and Limits

Generate finite MP4 clips using a hardware H.264 encoder. Probe that capability explicitly; an HEVC-capable node is not automatically preview-capable. H.264 is a preview format, not a new library encode target.

Use the same scale and render settings for both sides, preserve aspect ratio, and never upscale. AAC stereo permits browser comparison but cannot validate a home-theater surround path. Start with subtitles off; embedded subtitle rendering and subtitle switching are outside this release.

The first supported color path is SDR. HDR10 inputs require a separately verified, identical HDR-to-SDR transform for both sides and an explicit label. If either side lacks a supported transform, the pair is unavailable. Dolby Vision and HDR10+ pairs remain unavailable in this release. No silent color flattening is allowed.

ISO source previews are unavailable in this release. A finished MKV alone cannot serve as the before/after pair. Zero duration, missing streams, or less than one second of common playable duration also return unavailable.

Both clips start at the requested presentation time after timestamp normalization, with accurate seek rather than keyframe-only trimming. Clamp presets so a full clip fits where possible. Validate custom timestamps against the shorter duration and report the actual interval.

Generate both sides sequentially on one node, reserving one slot for the pair. Probe each output before publishing either. Publish the pair atomically; a one-sided success is a failed pair with temporary files cleaned.

Limit each pair to 128 MiB and reserve that amount before dispatch. Evict expired, then least-recently-used idle pairs to fit the 2 GiB cap. If space remains insufficient, wait with a cache-capacity reason. Retain the existing review-volume free-space reserve.

Preview inputs are read-only. Temporary files stay in a dedicated, guarded review subdirectory. Client requests contain Review IDs, timestamps, and validated track selections; they never supply filesystem paths or ffmpeg flags.

Authenticated same-origin media routes serve the cached clips with byte-range support. Browser responses expose opaque clip IDs, not filesystem locations or Jellyfin tokens. Logout and session expiry prevent new clip reads.

Worker leases cover preview reads. Keep and Discard cancel readers before changing files. A partitioned worker must stop on its local lease deadline; the master waits through that deadline plus a safety margin before mutation. Startup cleanup retains only valid published pairs and cancels interrupted generation.

## Failure and Recovery Summary

| Condition | Required Result |
| --- | --- |
| Jellyfin offline, unauthorized, or malformed | Connection warning; diagnostics marked stale; configured protection holds |
| Multiple media versions cannot be resolved | Unmatched observation; no repair; conservative replacement block in covered libraries |
| Node becomes protected after task starts | Running task completes; later admissions wait |
| Remote encode completes during protected playback | Durable deferred Review result; release encode lease; preserve original |
| Original changes before delayed Keep | Cancel intent; keep result; require a new inspection and explicit decision |
| Master restarts with waiting replacement | Recover intent and require fresh monitoring before any mutation |
| Preview worker disappears | Revoke publication after lease expiry; clean partial pair; expose retry |
| Preview succeeds after cancellation | Reject publication; delete its cache artifacts only |
| Keep/Discard races with preview generation | Serialize using file read reservations and mutation locks |
| Cache cleanup fails | Surface cleanup warning and retain accounting; do not claim freed space |

## Release Evidence

Automated tests use recorded Jellyfin documents, fake HTTP, fake time, fake process runners, and temporary media files. A live GPU or NAS is not required for the normal suite.

The release requires the following recorded demonstrations:

- Audio conversion appears once after repeated polls, opens a stereo repair draft, and queues nothing until the owner acts.
- A 1080p and 4K copy of one movie resolve independently, while a shared episode file receives one file-level block.
- Local and remote jobs wait during playback, then resume after the cooldown. A named-node job never migrates.
- A failed monitor holds protected work with a visible reason. Recovery clears only the applicable blocker.
- Local and remote direct-write completions wait safely, survive restart, and count savings exactly once after replacement.
- A matched SDR clip pair plays on current Chromium, Firefox, and Safari, including a mobile viewport and keyboard-only navigation.
- Hardware preview generation passes on each backend advertised as supported. Record tested versions and render capability; hide unverified capabilities.
- Cancel, worker loss, Keep, Discard, source change, and cache eviction preserve the original bytes in failure fixtures.

Operational targets: show an observation within 15 seconds of Jellyfin reporting it under normal connectivity; keep cached status endpoints independent of external latency. Preview requests return an accepted task before rendering starts. Performance checks use bounded pages and report the test environment.

## External Contracts and Sources

Jellyfin exposes current sessions and playback metadata; it does not provide this product's historical diagnostic database. These source links describe the integration inputs. Freeze fixtures against the installed server version during implementation.

- [Session controller and access rules](https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/SessionController.cs)
- [Session model](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Controller/Session/SessionInfo.cs)
- [Session response fields](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Model/Dto/SessionInfoDto.cs)
- [Selected media source and track state](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Model/Session/PlayerStateInfo.cs)
- [Read-only media source lookup](https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/MediaInfoController.cs)
- [Transcoding information](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Model/Session/TranscodingInfo.cs)
- [Jellyfin client codec support](https://jellyfin.org/docs/general/clients/codec-support/)
- [FFmpeg filters, including scale and color processing](https://ffmpeg.org/ffmpeg-filters.html)

## Document Review

Spec axis: this proposal covers the three requested features and names its overrides of existing contracts. Deferred direct write is the only new automatic replacement path, and it retains prior authorization.

Standards axis: the plan requires observable tests (ENG-04), hardware failure reporting (ENG-05), authenticated media delivery (ENG-06/07), argument-array process execution (ENG-08), and original-file preservation (ENG-09). Prose uses explicit outcomes and qualified evidence under RULE-01, RULE-03, and RULE-08. Implementation review remains a separate release gate.
