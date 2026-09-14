# Plan: Playback Diagnostics, Playback Protection, and Review Previews

Date: 2026-09-14. Status: proposed; implementation has not started. Audience: engineers implementing and reviewing the work.

Product contract: [Playback and Review PRD](../docs/playback-and-review-prd.md). Story IDs in this plan refer to that document. The existing [base PRD](../docs/prd.md), [v2 PRD](../docs/v2%20prd.md), and [engineering standards](../ENGINEERING_STANDARDS.md) still apply.

## Delivery Strategy

Build playback collection first because diagnostics and protection share its observations. Ship diagnostics as an opt-in feature before enabling scheduling changes. Complete replacement recovery before exposing replacement protection. Build previews last, using the same node-admission policy.

| Phase | Deliverable | Dependencies | Relative Scope |
| --- | --- | --- | --- |
| 1 | Jellyfin observation and exact file matching | None | Medium |
| 2 | Playback diagnostics and repair drafts | 1 | Medium |
| 3 | Playback-aware local and remote admission | 1 | Medium |
| 4 | Deferred Keep and direct-write recovery | 1, 3 | Large |
| 5 | Preview tasks, worker capabilities, and file reservations | 3, 4 | Large |
| 6 | Clip rendering, cache, and authenticated delivery | 5 | Large |
| 7 | Review comparison UI | 6 | Medium |
| 8 | Integrated recovery and release verification | 2, 4, 7 | Medium |

Relative scope describes implementation complexity, not a calendar estimate. Preview worker lifecycle and deferred replacement carry more risk than the visible controls.

## Code Baseline and Working-Tree Discipline

At planning time, unrelated edits exist in library, Arr replacement, and web-page modules. Re-read the current diff before implementation. Preserve that work and integrate against its final public contracts.

Relevant existing entry points:

- `notify.ts` owns player connection tests and refresh requests; `external-links.ts` resolves media links.
- `jobs.ts` owns local admission, `claimForNode`, `completeRemote`, `keep`, and `performKeep`.
- `store.ts` owns persistence, pool claims, leases, Review records, and file-sharing queries.
- `worker-loop.ts` handles worker claims, process lifetime, progress, and completion.
- `optimize.ts` produces and validates media; `promote.ts` replaces it.
- `Review.tsx`, `Queue.tsx`, `Title.tsx`, and Settings expose the affected workflows.

Do not copy Jellyfin fetching into queue ticks or React pages. Queue status must remain responsive when Jellyfin is unavailable.

## Module Interfaces

The following names describe proposed modules. Implement only these responsibilities; avoid a general automation or plugin framework.

| Module | Small Public Interface | Responsibility |
| --- | --- | --- |
| `jellyfin-playback.ts` | Fetch a typed session snapshot; resolve a selected media source | Authenticated HTTP, timeouts, unknown-JSON parsing, and Jellyfin-version differences |
| `playback-monitor.ts` | Start/stop; refresh a connection; read current coverage | Poll coalescing, snapshot freshness, file matching, and observation persistence |
| `playback-policy.ts` | Evaluate node admission or file replacement from typed observations | Block reasons, multiple connections, uncertainty, and cooldowns; no HTTP or disk writes |
| `playback-diagnostics.ts` | List diagnostics; produce a repair draft; dismiss | Occurrence grouping, explanations, post-Keep comparisons, and actionable recommendations |
| `review-previews.ts` | Request/cancel/status/serve a pair | Preview lifecycle, cache reservations, publication, and file read reservations |
| `preview-render.ts` | Render a validated pair on a capable node | Finite clip generation, output checks, cleanup, and process cancellation |

Persistence stays in `store.ts` through focused public methods. Existing queue and promotion modules call the new policy interface. Pass a clock, HTTP fetch, and process runner where behavior varies in tests.

Shared policy results use explicit allowed or blocked outcomes with reason codes, affected connection IDs, and observation times. Keep user-facing sentences in one presentation helper. Do not represent unknown playback as an empty session list.

## Data and Migration Design

Use additive migrations with safe defaults. Every new feature is disabled for existing installations.

| Logical Record | Required Information | Lifecycle |
| --- | --- | --- |
| Playback settings | Jellyfin connection ID; history flag; protected node IDs; covered Arr instance IDs; replacement-protection flag | Validate references; explain consequences before saving removal of protection |
| Current snapshot | Connection; successful-observation time; completeness; typed current sessions; health | Live state starts unknown after restart; persisted timestamps never authorize replacement |
| Source match | Connection, item and media-source IDs; local file identity/revision; resolution outcome | Invalidate on path/revision change, integration change, or deleted library item |
| Viewing occurrence | Opaque ID; connection; device identity/label; item/source identity; revision; observed interval; reasons; selected-track roles; gap marker | Thirty-day and 50,000-record limits; aggregate per occurrence, not per poll |
| Diagnostic dismissal | Revision; device identity; reason family | Persists within history retention; a new revision can produce a new issue |
| Replacement intent | Review ID; Keep/direct origin; request time; source and sidecar revisions; state/blockers | Durable until cancellation, failure, or successful replacement |
| Preview task | Review ID; both revisions; interval; audio choices; render profile; state; assigned/active node; lease; error | Independent of optimization jobs and history |
| Preview artifacts | Opaque pair/clip IDs; relative guarded paths; bytes; expiry; last use | Atomic pair publication; bounded cache; delete on Review removal |
| File read reservation | Preview task and lease; canonical source/sidecar identities; expiry | Blocks mutation until release or enforced worker deadline plus safety margin |

Use local file revision records consistently across repair drafts, waiting replacement, and previews. Include canonical path, size, modification time, and available file identity. Do not introduce full-library hashing.

Add uniqueness constraints for one active replacement intent per physical output and one active/published preview per normalized cache key. Include source and sidecar revisions, timestamp, audio selections, and render-profile version in that key.

Deleting viewing history removes occurrences and diagnostic dismissals. It does not erase live monitoring state, pending replacement intents, or the existing kept-file history. Connection removal clears its matching cache and observations through a deliberate cleanup path.

## Proposed HTTP Contracts

All routes below require the existing admin session or documented local bypass. Existing cluster credentials authorize only worker operations. Clip delivery never accepts a Jellyfin token or widget key.

| Route | Purpose and Response |
| --- | --- |
| `GET /api/playback/settings` | Flags, coverage, node selections, and monitor health; no secrets |
| `PUT /api/playback/settings` | Validate and atomically save rules; reconcile polling |
| `POST /api/playback/connections/:id/test` | Verify all-session playback access without enabling collection |
| `GET /api/playback/observations` | Bounded occurrence pages with filters and explicit stale/unmatched states |
| `GET /api/playback/diagnostics` | Bounded grouped problems; seven-day default; stable tie-breaker |
| `POST /api/playback/diagnostics/:id/dismiss` | Dismiss exact revision/device/reason |
| `POST /api/playback/diagnostics/:id/repair-draft` | Revalidate evidence and return a custom-plan draft; creates no job |
| `DELETE /api/playback/history` | Clear retained observation history and dismissals |
| `POST /api/review/:id/cancel-keep` | Cancel a waiting intent; preserve the sidecar; conflict if mutation already began |
| `POST /api/review/:id/previews` | Request normalized timestamp/audio choices; return 202 with opaque task ID, or the matching ready pair |
| `GET /api/review/:id/previews/:previewId` | State, interval, selected tracks, transform labels, and clip IDs |
| `DELETE /api/review/:id/previews/:previewId` | Cancel generation or evict an idle cached pair |
| `GET /api/review/:id/previews/:previewId/clips/:side` | Authenticated MP4 delivery with Range/HEAD semantics; side is original or finished |

Use 400 for invalid input, 401 for missing authentication, 404 for absent resources, and 409 for source changes or conflicting actions. Unsupported preview capability is a typed unavailable result. Asynchronous generation failure appears in task state, not a false HTTP success claiming a clip exists.

Extend existing job and node responses with typed admission reasons. Extend Review responses with waiting count, intent origin, and cancellability. Bulk Keep retains accepted/skipped fields for compatibility and adds started/waiting: accepted equals started plus waiting. A started response means scheduled for promotion, not replacement completed; a last-moment block may move it to waiting.

Single Keep returns accepted plus current disposition. Unchanged callers may use accepted; updated UI must display waiting accurately. Repeated Keep on an existing intent returns a conflict and does not add another intent.

Add explicit preview-task claim/progress/complete/fail routes under the cluster namespace. Reuse lease primitives where they fit. Do not send a preview document through the current optimize-job parser or reuse an optimization job ID.

## Phase 1: Observe Jellyfin and Match Actual Files

Stories: PD-01 through PD-04, PD-09, PD-10; foundation for PP-01 and PP-06.

### Work

1. Add playback settings, typed connection health, and additive persistence.
2. Implement authenticated `GET /Sessions` with a server API key. Do not filter by general session activity when determining playback.
3. Parse nullable current-item, play-state, and transcoding fields. Keep unknown enum values for diagnostics without treating them as supported actions.
4. Resolve `PlayState.MediaSourceId` with `GET /Items/{itemId}/PlaybackInfo` when the current session lacks a verified path. Match the returned source ID exactly. Never open a stream.
5. Reject remote/non-file sources for local repair. Match canonical full paths against Arr files; retain explicit ambiguous/unmatched results.
6. Cache source lookups per connection/item/source for at most 60 seconds. Invalidate on local revision changes and refresh before repair or replacement. Limit resolution to two concurrent requests per connection.
7. Run one monitor on the standalone/master process. Workers receive decisions, never Jellyfin credentials. Coalesce polling and promotion-triggered refreshes.
8. Use complete session snapshots for freshness. Limit responses to 2 MiB and 1,000 sessions; exceeding either marks the snapshot incomplete and holds protection. Bound raw reason lengths and diagnostic text.
9. Group observations and enforce retention limits. Collection outages mark observation gaps rather than completed playback.

### Acceptance and Tests

- Fixtures cover Direct Play, audio-only conversion, video conversion, paused video, missing state, unknown reasons, and an empty successful response.
- API-key access passes; ordinary-user credentials cannot enable household protection. Validate the chosen server API-key credential type rather than inferring scope from how many sessions happen to be visible.
- Two versions sharing provider IDs attach to their own paths. Basename-only and title-only matches remain unresolved.
- Repeated polls create one occurrence; disappearance and return create another; failure does not claim a stop.
- Two HTTP refresh requests and a timer share one in-flight fetch. Cached page responses remain available while it blocks.
- Restart begins with unknown protection state even when yesterday's snapshot was idle.
- Clearing history and disabling history leave enabled protection functioning.

Demo: observe one playback on a test Jellyfin server and show its device, file, selected tracks, and reported conversion reason.

## Phase 2: Explain Problems and Open Repair Drafts

Stories: PD-05 through PD-08.

### Work

1. Implement reason-family presentation and the PRD's recommendation table as a pure decision interface.
2. Add Playback navigation and bounded problem/observation views. Keep playback counts separate from file inspection Errors and automatic Suggestions counts.
3. Add a title-page summary and diagnostic-to-custom-editor handoff using server-issued, revision-validated drafts.
4. Preserve existing exclusion, language, hardware, and shared-file locks when the user queues the draft. Recompute against the current inspection; reject stale evidence.
5. Link before/after observations through the existing successful Keep event and revisions. Capture device, track roles, and available local/remote context. Omit improvement language when context is missing or differs.
6. Implement dismissal and history clearing with visible outcomes.

### Acceptance and Tests

- A reported audio conversion with surround and no stereo yields an add-stereo draft while leaving the queue empty.
- Existing stereo yields playback guidance; subtitle and unknown reasons never remove tracks.
- Unsupported video playback does not automatically choose HEVC or AV1.
- Automatic import queueing remains unchanged when a playback problem appears.
- Ranking counts viewing occurrences rather than polls. Pagination and filters compose.
- A fresh direct-play observation after Keep is displayed as observed evidence. No later playback produces “Not yet observed.”
- Keyboard and mobile flows can open the diagnostic and review the draft before queueing.

Demo: open a real audio-conversion problem, inspect the draft, queue it explicitly, and show the later observation without a causal claim.

## Phase 3: Hold New Work During Playback

Stories: PP-01 through PP-06.

### Work

1. Implement one typed policy evaluator for node admission and file replacement. Give it snapshots, coverage, and the clock.
2. Define the initial idle cooldown from the first successful idle observation after startup. A blocking or unknown observation resets eligibility.
3. Apply node policy to both `jobs.tick` and remote `claimForNode` before reserving slots. Evaluate all relevant connections.
4. Leave jobs in their existing schedule/manual state and expose playback as an additional admission reason. Do not reuse off-peak `held` as the sole representation of every blocker.
5. Exclude protected nodes from pool-spread available capacity. Unassigned jobs can use another eligible node; pinned jobs remain pinned.
6. Add Settings coverage/node selectors and Queue/node explanations. Run now must not bypass playback protection.
7. Share capacity/admission accounting with the upcoming preview scheduler rather than adding a second independent slot limit.

### Acceptance and Tests

- A blocking snapshot prevents both a local start and remote lease issuance.
- Direct Play blocks configured nodes; paused video releases node protection after cooldown but still protects the file.
- Two idle polls without 30 seconds elapsed do not resume work. Recovery also respects off-peak and manual pause.
- One blocked connection holds a node even if another is idle. Unrelated nodes continue.
- A stale monitor holds configured resources and displays its timestamp. HTTP status reads do not call Jellyfin.
- Existing running jobs finish, Cancel remains usable, and no named-node failover occurs.

Demo: start playback, queue local/pool/pinned jobs, then stop playback and show admission after the cooldown.

## Phase 4: Defer Replacement and Recover It Safely

Stories: PP-07 through PP-12.

### Work

1. Add durable replacement intents and the Review waiting state. Include waiting in every shared-file lock, removal guard, pending-output check, and restart recovery path.
2. Route single/bulk Keep and both local/remote direct-write completion through one promotion request interface.
3. Persist a validated direct-write result and its intent before acknowledging remote completion. Release the encode slot and lease without losing the sidecar.
4. Capture the job's effective write mode when dispatched. Remote completion must use that captured value rather than a later Settings value. Existing new-import jobs stay sidecar-only.
   Capture the source revision at the same point, before processing. Carry it through remote work and reject replacement when completion sees a different revision. Legacy Review rows without a trusted pre-encode revision cannot gain a deferred automatic intent; expose the missing evidence and require reinspection plus an explicit new decision.
5. Add a bounded master intent dispatcher. Apply file protection after acquiring a replacement slot; refresh stale preflight data asynchronously.
6. Verify source/sidecar revisions and acquire the shared file mutation lock before any move. Known alias paths participate in the same lock.
7. Implement cancel-wait and Discard ordering. Failure clears automatic intent and returns pending with an actionable error.
8. Make remote completion retry idempotent for the current task/output identity. A duplicate callback cannot create another Review card or restart replacement.
9. Record exactly one kept event and savings update per successful output. Preserve existing Arr refresh/profile assignment and player notification after actual promotion only.
10. Restore waiting intents on restart, require new observations, and reconcile interrupted keeping through the existing replacement-recovery machinery.

### Acceptance and Tests

- Keep during playback returns promptly, preserves both input files, and exposes a cancellable intent.
- Direct write finishing locally or remotely becomes a waiting Review result. No savings or player refresh occurs before promotion.
- Duplicate completion and Keep requests create one result and one eventual history entry.
- Restart before replacement, during replacement, and after file placement recovers with original-byte and exactly-once accounting assertions.
- An Arr upgrade while waiting cancels the intent and remains untouched.
- Mixed bulk Keep reports started, waiting, and skipped accurately. Waiting cards are not selected again by Keep all.
- A fresh preflight failure returns waiting; an actual file-operation failure returns pending without an automatic retry loop.
- Cancellation before mutation preserves the original and finished copy. Cancellation after mutation starts returns conflict.

Demo: finish a direct-write job during paused playback, restart the master, cancel its wait, and later Keep explicitly. Repeat with automatic resumption after playback ends.

## Phase 5: Schedule Preview Work and Reserve Inputs

Stories: RP-05 through RP-10; infrastructure for all previews.

### Work

1. Add an independent preview-task lifecycle: queued, running, ready, failed, cancelled, and expired. Waiting reasons describe node, playback, input lock, or cache capacity.
2. Advertise an optional versioned preview capability in node heartbeats: H.264 encoder, supported render profiles, and preview protocol version. Old workers advertise none and keep receiving ordinary jobs.
3. Detect H.264 preview support separately from HEVC/AV1 library support. Include a small runtime render/probe smoke check before advertising a profile.
4. Reuse node slot accounting for all running optimize and preview work. A pair consumes one slot, with one pair per node and two globally.
5. Choose any capable open node for preview tasks; ordinary job pinning does not pin previews. Expose the actual node in preview status.
6. Prefer an explicitly requested preview for at most one consecutive admission on a node when ordinary work waits. Then admit ordinary work before another preview, preventing starvation.
7. Acquire source/sidecar read reservations atomically with task dispatch. Keep/Discard withdraw preview publication rights and cancel readers before acquiring mutation ownership.
8. Add worker-local lease deadlines and an independent watchdog that terminates preview child processes on cancellation, master disconnection past the deadline, or timeout.
9. Use a 30-second preview lease, renew at most every 10 seconds, and a five-second master safety margin after expiry. Use monotonic worker time and account for request elapsed time when installing a renewed deadline.
10. Reject late progress/completion with stale lease or revoked publication rights. Master mutation waits until readers acknowledge release or the enforced lease deadline plus margin passes.

### Acceptance and Tests

- A GPU-less master dispatches preview work to a capable worker. An old worker receives none.
- Combined optimize and preview work never exceeds configured node slots or global preview limits.
- Playback blocks new preview tasks under the same policy as optimization.
- A partitioned worker terminates reading at its deadline; Keep waits through the deadline and safety margin.
- Keep and Discard racing with preview requests cannot delete an input still held by an authorized reader.
- Cancellation and late completion never publish an artifact or alter an optimize job.

Demo: request a preview on a remote worker, disconnect it, and show a waiting Keep proceed only after the reader deadline is safe.

## Phase 6: Render, Cache, and Serve Matching Clips

Stories: RP-01, RP-02, RP-04, RP-06 through RP-10.

### Work

1. Normalize presets/custom timestamps against common duration. Resolve audio choices through actual stream indices and approved track correspondence, not display-list positions.
2. Build finite argument-array render commands. Generate both clips sequentially with a shared profile, accurate seek, timestamp reset, matched scale, and AAC stereo.
3. Select the smaller supported dimensions across the two inputs, capped at 1080p, while preserving each display aspect ratio. Report differing source aspect ratios instead of stretching either image.
4. Ship tested SDR rendering first. Add HDR10 only when the complete transform passes matching fixtures and device checks; leave Dolby Vision, HDR10+, and ISO unavailable.
5. Enforce a 128 MiB pair reservation, execution timeout, and actual output-size cap. Kill the process if the cap is exceeded rather than exhausting review storage.
6. Probe both clips for playable streams, expected audio presence, interval duration, and matching presentation starts. Publish the complete pair atomically.
7. Implement 24-hour expiry and 2 GiB cache accounting. Evict expired and idle least-recently-used pairs; never remove a running or actively streamed pair.
8. Register preview directories with existing review-cleanup guards. Startup marks interrupted tasks retryable, removes unowned partials, and validates published pairs before reuse.
9. Implement opaque, authenticated clip routes with correct MIME, byte ranges, HEAD, private/no-store browser caching, and request cancellation. Guard against traversal and symlink escape using server-owned paths.
10. Invalidate every affected pair on source/sidecar change, Keep, Discard, or Review removal. Bound active streaming pins and release them on disconnect.

### Acceptance and Tests

- Requests for identical revisions/interval/tracks reuse one task. A changed audio choice or source revision produces a different pair.
- Fixture clips start at matching presentation times and remain within 250 ms. Short media clamps correctly; invalid timestamps return 400.
- One-sided generation failure publishes neither clip and removes only its temporary artifacts.
- Missing hardware, unsupported HDR, and ISO produce accurate unavailable states with no CPU video fallback.
- Range/HEAD/invalid-range behavior is correct. Authentication failure and path traversal never return media bytes.
- Cache reservations prevent overcommit from simultaneous requests; failed cleanup retains accounting and warns.
- Logout, missing Review, and stale clip IDs prevent new reads. An already-open response releases its pin on closure.

Demo: generate an SDR pair, seek both clips, change audio selections, reuse the cached pair, and demonstrate safe eviction.

## Phase 7: Build the Review Comparison UI

Stories: RP-01 through RP-04, RP-06, RP-07, RP-09.

### Work

1. Add Compare clips to pending and waiting cards. Open a focused dialog or detail panel; do not start generation until a sample is selected.
2. Show preset positions, custom timestamp, original/finished track choices, and actual interval. Load preview status without overlapping polls.
3. Link play, pause, and seek. Pause both players on buffering and resynchronize when drift exceeds 250 ms. Keep only one audio element audible.
4. Use a side-by-side desktop view and A/B mobile view with clear active-side labels. Provide keyboard controls, focus management, and accessible status announcements.
5. Label scaled picture, AAC/downmixed audio, and HDR-to-SDR rendering. Explain that clips support review but do not prove native HDR or surround playback quality.
6. Display queued, playback-held, generating, unavailable, failed, and ready states. Retry/cancel remains independent of the optimize job.
7. Coordinate Keep/Discard with preview cancellation and input release. Preserve selected Review rows and paging after these actions.

### Acceptance and Tests

- Opening Review or Compare alone creates no preview work.
- UI actions request the correct interval and tracks, display the actual response, and preserve failure details.
- Keyboard-only and mobile users can compare both sides and switch audio.
- Buffering, seeking, and audio switching keep one audible side and bounded synchronization.
- Preview failure leaves facts and ordinary Keep/Discard available.
- Removing a card closes its preview and stops outstanding playback/status requests.

Demo: compare dialogue and motion from desktop and mobile, then Keep while preview generation is pending.

## Phase 8: Verify the Integrated Release

### Required Checks

Run focused tests during each phase. At the integrated gate run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Extend public HTTP, fake-process, and filesystem fixtures instead of asserting private SQL or flag ordering (ENG-04).

Record real browser and hardware smoke results separately from unit tests. Test each advertised backend and deployed Jellyfin version. A missing test environment means the associated capability remains unadvertised until verified.

| Scenario | Evidence Required |
| --- | --- |
| Playback diagnostics | One occurrence after repeated polls; accurate raw/mapped reasons; explicit repair approval |
| File identity | Multiple versions, shared episodes, aliases, unmatched paths, and source replacement |
| Scheduler | Local/remote/pool/pinned work; off-peak interaction; multiple players; stale data; cooldown |
| Deferred replacement | Both completion paths; repeat requests; cancellation; source change; all crash boundaries |
| Preview lifecycle | Hardware checks; remote dispatch; lease partition; cancellation; atomic pair publication |
| Media delivery | Range/HEAD/auth; browser synchronization; track choices; unsupported color formats |
| Resource bounds | Slow Jellyfin; maximum response; history pruning; cache pressure; simultaneous tasks |
| Regressions | Existing import queueing, exclusions, Keep accounting, Arr follow-up, and library responsiveness |

Use a seeded 50,000-occurrence history and a large library to verify page bounds and inspect query plans where needed. Capture response size and latency on a named test environment. Do not introduce machine-sensitive latency assertions into the normal suite.

### Rollout and Recovery

1. Deploy schema and read-only collection with protection disabled. Verify matching on representative movie, episode, and multi-version paths.
2. Enable diagnostics for one Jellyfin connection and confirm reason quality before enabling recommendations broadly.
3. Enable node protection on one node. Verify local and remote admission plus the unavailable-server behavior.
4. Enable replacement protection only after deferred-write crash tests pass. Confirm the owner understands pending automatic replacement intents.
5. Advertise preview profiles only on verified workers, then expose Compare clips.

To disable collection, stop retaining history while keeping live monitoring required by protection. To disable protection, show that waiting authorized replacements may resume. To stop those replacements instead, cancel their intents first.

Do not downgrade to a build that cannot interpret waiting Review intents or preview read reservations. Cancel/drain those tasks and validate the migration compatibility procedure before a binary rollback. Feature disablement is the initial rollback mechanism.

## Source Verification and Remaining Implementation Checks

The product decisions above are settled for this plan. Implementation must verify deployed-version details without weakening those decisions:

- Jellyfin `IsActive` describes session-controller activity, not playback. Use current item and play state. [Session implementation](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Controller/Session/SessionInfo.cs).
- Selected media source and track indices come from play state. [Player state](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Model/Session/PlayerStateInfo.cs).
- Read media sources through GET PlaybackInfo; never POST to open playback. [Media controller](https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/MediaInfoController.cs).
- Read actual conversion reasons from session TranscodingInfo. MediaSourceInfo's TranscodeReasons property is excluded from JSON. [Media source model](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Model/Dto/MediaSourceInfo.cs).
- Server API keys supply household visibility; ordinary users may see only their sessions. [Session manager](https://raw.githubusercontent.com/jellyfin/jellyfin/master/Emby.Server.Implementations/Session/SessionManager.cs).
- Verify hardware H.264 and the full render chain at runtime. Implementations exist for [NVENC](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/nvenc_h264.c), [VAAPI](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/vaapi_encode_h264.c), and [VideoToolbox](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/videotoolboxenc.c).
- HDR tone mapping requires correctly prepared color inputs. [FFmpeg tone mapping](https://ffmpeg.org/ffmpeg-filters.html#tonemap).

If the installed Jellyfin version cannot expose enough information to verify household visibility or exact media identity, report unavailable coverage. Do not quietly enable protection with partial visibility.

## Review Gates

Spec review: every PD, PP, and RP story maps to a phase and observable acceptance evidence. The plan preserves ordinary sidecar approval and separates preview work from optimization totals.

Standards review: implementation must satisfy ENG-01 through ENG-14 where applicable, especially shared policy locality (ENG-10), typed remote inputs (ENG-03), public tests (ENG-04), and original-byte preservation (ENG-09). User-facing copy follows RULE-01, RULE-03, and RULE-08. No standards exception is proposed.

Planning validation is complete when document links resolve, each story has phase coverage, and PRD/plan defaults agree. Application tests are required when implementation begins; this documentation change does not alter runtime behavior.

## PR Plan

### PR 1: Observe Jellyfin and match actual files

- **Description:** Add opt-in Jellyfin session observation, exact path matching to library files, occurrence grouping, retention, and playback settings persistence. No scheduling or repair drafts yet. Stories PD-01 through PD-04, PD-09, PD-10.
- **Files/components affected:** src/server/jellyfin-playback.ts, src/server/playback-monitor.ts, src/server/store.ts, src/server/app.ts, src/server/notify.ts, src/server/types.ts, tests
- **Dependencies:** None

### PR 2: Explain problems and open repair drafts

- **Description:** Add Playback page, reason-family recommendations, dismiss, repair drafts that open the custom plan editor, and title-page observation summaries. Stories PD-05 through PD-08.
- **Files/components affected:** src/server/playback-diagnostics.ts, src/server/app.ts, src/web/pages/Playback.tsx, src/web/App.tsx, src/web/pages/Title.tsx, src/web/pages/Settings.tsx, tests
- **Dependencies:** PR 1

### PR 3: Hold new work during playback

- **Description:** Typed playback policy for node admission on local ticks and remote claims. Settings maps Jellyfin connections to protected nodes. Queue shows waiting-for-playback. Stories PP-01 through PP-06.
- **Files/components affected:** src/server/playback-policy.ts, src/server/jobs.ts, src/server/cluster.ts, src/web/pages/Queue.tsx, src/web/pages/Settings.tsx, tests
- **Dependencies:** PR 1

### PR 4: Defer replacement and recover it safely

- **Description:** Durable replacement intents, waiting Review state, deferred Keep/direct-write, cancel-wait, restart recovery, and exactly-once kept accounting. Stories PP-07 through PP-12.
- **Files/components affected:** src/server/jobs.ts, src/server/promote.ts, src/server/store.ts, src/server/app.ts, src/web/pages/Review.tsx, tests
- **Dependencies:** PR 1, PR 3

### PR 5: Schedule preview work and reserve inputs

- **Description:** Independent preview-task lifecycle, worker preview capability, slot sharing, read reservations, and cluster claim/progress/complete routes. Stories RP-05 through RP-10 infrastructure.
- **Files/components affected:** src/server/review-previews.ts, src/server/worker-loop.ts, src/server/cluster.ts, src/server/store.ts, src/server/jobs.ts, tests
- **Dependencies:** PR 3, PR 4

### PR 6: Render, cache, and serve matching clips

- **Description:** Finite H.264/AAC clip rendering, atomic pair publication, 2 GiB cache, authenticated Range/HEAD clip delivery. Stories RP-01, RP-02, RP-04, RP-06 through RP-10.
- **Files/components affected:** src/server/preview-render.ts, src/server/review-previews.ts, src/server/app.ts, src/server/optimize.ts, tests
- **Dependencies:** PR 5

### PR 7: Build the Review comparison UI

- **Description:** Compare clips dialog, presets, linked playback, desktop side-by-side and mobile A/B, Keep/Discard coordination with preview cancellation. Stories RP-01 through RP-04, RP-06, RP-07, RP-09.
- **Files/components affected:** src/web/pages/Review.tsx, src/web/api.ts, tests
- **Dependencies:** PR 6

### PR 8: Verify the integrated release

- **Description:** Integrated tests, typecheck, build, and git diff --check. Confirm diagnostics, scheduler, deferred replacement, preview lifecycle, and existing Keep/import regressions. Phase 8 required checks.
- **Files/components affected:** tests, package.json
- **Dependencies:** PR 2, PR 4, PR 7

