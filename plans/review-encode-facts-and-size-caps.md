# Plan: Review encode facts, TV 4K HDR cap, Settings size-cap grid

Three product changes on one settings/review surface. They share types and copy, so they ship as two reviewable PRs: caps+grid first, then Review provenance.

---

## 1. Review: which node, which GPU, how long

**Today.** A Review card is Now vs Sidecar (codec, size, duration, GB/hour, tracks). It does not say which encode node ran the job, whether that was NVIDIA or Intel/AMD, or how long the job took. Jobs have `createdAt` (enqueue time) and `nodeId` while running, but no `startedAt`, and `insertReview` only stores the compare JSON.

**Store on the review row** (not derived later from a vanished node):

| Field | Meaning |
| --- | --- |
| `nodeName` | Encode node label (`deskmini`, `5090`, `homeserver`) |
| `encodeApi` | The encode API ffmpeg actually used: `CUDA`, `VAAPI`, or `QuickSync`. |
| `gpuName` | Device name from the node probe (`NVIDIA GeForce RTX 5090`, `Intel Battlemage G31`, `AMD Raphael`). |
| `encodeMs` | Wall clock from first `running` to Review insert (stereo + mux + encode). Null on old cards. |

**Job `startedAt`.** Add `jobs.started_at`. Set when the row first becomes `running` (local `JobService.run` and SQL claim). Do not use `createdAt` (that includes queue wait). `encodeMs = now - startedAt` at sidecar Review insert. Direct write has no Review card; leave History unchanged.

**Copy** on the card, under the title, before Now/Sidecar:

`Ran on deskmini · VAAPI · Intel Battlemage G31 · 23 min`

`Ran on 5090 · CUDA · NVIDIA GeForce RTX 5090 · 8 min`

Rules: skip any missing piece; skip the whole line if nothing is stored (old reviews). Duration: under 90 seconds as `48 sec`, else `12 min`, `1 hr 4 min` if ≥ 60 min. Do not say “cluster.”

**Encode API vs marketing names.** Snapshot the backend the job used, not a guess from the PCI vendor:

- `cuda` → `CUDA` (`hevc_nvenc` / `av1_nvenc`)
- `vaapi` → `VAAPI` (`hevc_vaapi` / `av1_vaapi`) — this is what deskmini runs today
- `qsv` → `QuickSync` only if we actually invoke `hevc_qsv` / `av1_qsv`

Intel QuickSync is a different ffmpeg encoder family. Polisharr’s Intel path is VAAPI. Do not label a VAAPI job as QuickSync. If we later add a QSV path, `HardwareBackend` gains `"qsv"` and Review follows.

**GPU name probe** (per node, on hello/heartbeat, stored on the node row and copied onto the review):

- NVIDIA: `nvidia-smi --query-gpu=name --format=csv,noheader` (first GPU)
- Else: first DRM render node’s PCI ID via `/sys/class/drm/renderD128/device/{vendor,device}` mapped with a small table, or `lspci -mm` if present (`Intel Corporation Battlemage G31`, `AMD Raphael`)

Keep `HardwareInfo` extended with optional `gpuName: string | null`. Probe failures leave `gpuName` null; the Review line still shows node + API + duration.

**UI.** One muted `text-sm` line. `frameFacts` stays for the contact sheet. Help sentence adds that the card names the encode node, the GPU API, the device, and how long it ran.

**Tests.** `formatEncodeDuration`; Review line builder omits empty parts and orders `node · API · GPU · duration`; insertReview round-trip of `encodeApi` + `gpuName` + `encodeMs`; complete (local and remote) stamps them; existing reviews still load with nulls; a VAAPI fixture must not print `QuickSync`.

---

## 2. Size cap: TV 4K HDR

**Today.** Movies split 4K SDR vs HDR (`movie4kSdr` 6 GB/hr, `movie4kHdr` 8). TV 4K is a single `tv4k` (4 GB/hr). `sizeCategory` already computes `hdr` the same way for both, then ignores it for episodes:

```ts
if (isTv) return fourK ? "tv4k" : "tv1080p";
```

House of the Dragon 2160p HDR is scored against 4 GB/hr, the same as SDR 4K TV.

**Add `tv4kHdr`.** Keep `tv4k` as 4K SDR TV (no rename, no settings migration of the old key). HDR detection stays the existing `report.hdr !== "none"` or quality/resolution matching `hdr|dolby|dv`.

| Category | Default GB/hr | Arr profile name |
| --- | --- | --- |
| `tv1080p` | 1.0 (unchanged) | Polisharr TV 1080p |
| `tv4k` | 4.0 (unchanged, now SDR only) | Polisharr TV 4K |
| `tv4kHdr` | **6.0** | Polisharr TV 4K HDR |

6 sits with Movie 4K SDR and above current TV 4K, so HDR episodes are not pulled down to the SDR TV budget. Existing saved settings: `validSizeCaps` already fills missing keys from `DEFAULT_SIZE_CAPS`, so a stored blob without `tv4kHdr` gets 6.0. Suggest recompute on save (already happens when size caps change).

**Touch list.** `SizeCategory` / `SizeCaps` / `DEFAULT_SIZE_CAPS`; `sizeCategory`; `PROFILE_NAMES` + Sonarr `SONARR_CATEGORIES`; store profile CASE SQL; `sizeCapLabel`; suggest tests for a 2160p HDR episode vs `tv4kHdr` and SDR 4K episode still `tv4k`; arr-profiles tests.

---

## 3. Settings: size-cap grid

**Today.** `Object.entries(data.sizeCaps)` in `grid-cols-1 sm:grid-cols-2` with a short `h-10 w-28` number box. Order is object-key order. Movie and TV mix. Profile preview is a separate dump under the form.

**Layout.** Two columns (Movies | TV), three rows (1080p, 4K SDR, 4K HDR). Mobile: still two columns if the card is wide enough; `grid-cols-2` from `sm` up, stacked groups on the smallest width (`grid-cols-1 md:grid-cols-2`).

```
Size caps (GB per hour)
Help: Automatic Suggestions transcode when the file is above the cap for its kind.

Movies                         TV
1080p        [ 2.5 ]           1080p        [ 1.0 ]
4K SDR       [ 6.0 ]           4K SDR       [ 4.0 ]
4K HDR       [ 8.0 ]           4K HDR       [ 6.0 ]
             42.7 MB/min                    17.1 MB/min   (preview under each field)
```

Each cell: label, full-width `FIELD_CONTROL` number input (`step="0.1"`, `min="0.1"`), one-line preview `GB/hr · MB/min` from existing `profilePreviews`. Do not use `Object.entries` for layout; a fixed `SIZE_CAP_GRID` in `settings-copy.ts` so TV 4K HDR cannot fall off the page.

Drop the separate preview list under the form once previews live in the cells.

**Tests.** `sizeCapLabel("tv4kHdr") === "TV 4K HDR"`; grid keys are the six categories; Settings still saves a number for `tv4kHdr`.

---

## Phases / PRs

### Phase A — TV 4K HDR + Settings grid

Tracer: a 2160p HDR episode uses `tv4kHdr` (6 GB/hr default); Settings shows a Movies/TV grid with six boxes; Sonarr profile preview includes Polisharr TV 4K HDR.

Acceptance:

- [ ] `sizeCategory` for 2160p HDR episode is `tv4kHdr`; SDR 2160p episode stays `tv4k`.
- [ ] Saved settings without the new key get `tv4kHdr: 6`.
- [ ] Settings grid is Movies | TV × 1080p / 4K SDR / 4K HDR; copy does not say “sizeCaps”.
- [ ] Profile auto-assign can create/update `Polisharr TV 4K HDR`.
- [ ] `npm test` and `npm run typecheck` pass.

### Phase B — Review encode node, GPU, duration

Tracer: a sidecar Review card shows `Ran on deskmini · VAAPI · Intel Battlemage G31 · 12 min` after a worker complete; an old review card has no extra line.

Acceptance:

- [ ] Job `startedAt` set on first running (claim and local run); Review `encodeMs` is that delta.
- [ ] Node name, encode API (`CUDA` / `VAAPI` / `QuickSync` only if used), and GPU name snapshotted at insertReview (local and remote complete).
- [ ] A VAAPI complete does not say QuickSync.
- [ ] Direct write still has no Review card.
- [ ] Old reviews load; the provenance line is omitted when fields are null.
- [ ] Duration copy uses sec / min / hr as above.

---

## Out of scope

- History page duration/node
- Per-job GPU picker (Encode node already exists)
- Path mapping; changing HDR detection rules
- Renaming `tv4k` to `tv4kSdr` in the database key
- Live GPU telemetry on Review (we snapshot at complete)

---

## Defaults locked unless you say otherwise

1. **TV 4K HDR default 6 GB/hr** (not copied from `tv4k` 4). HDR TV gets more budget than SDR TV.
2. **Encode duration is the whole job** (stereo + mux + encode), not ffmpeg-only.
3. **Settings grid is Movies | TV columns**, not a single wrapping list.
