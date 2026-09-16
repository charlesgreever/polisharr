# Plan: Agent MCP for Polisharr

Date: 2026-09-16. Status: implemented in tree (not shipped until tagged). Audience: engineers implementing and reviewing the work.

An operator should be able to tell an AI agent (Grok TUI, Claude Desktop, Cursor, and similar) to find a title and queue work: encode to a target size, add stereo, run the existing suggestion, or report queue and Review state. The agent talks to Polisharr over MCP. Polisharr remains the only process that inspects, plans, encodes, and Keeps.

This plan does not change encode argv, Keep, or Arr replacement. It adds a machine-facing door onto the same operations the title page already uses.

Related specs: [prd.md](../docs/prd.md) stories 7–8 (auth), 30 (row actions), 60 (honest queue success), [v2 prd.md](../docs/v2%20prd.md) stories 20–27 and 50 (custom size/quality plans), [ENGINEERING_STANDARDS.md](../ENGINEERING_STANDARDS.md) ENG-04 through ENG-09.

## Product contract

1. An agent can search the library by title and get a stable item id, current size, codec, and whether a suggestion or Review sidecar already exists.
2. An agent can queue **sidecar** work for one inspected title: the open suggestion, add stereo, or a custom size-target / quality encode. Queue returns at once with a job id. The library file does not change until Keep.
3. An agent can read job status, logs excerpt, Review pending items, and node health.
4. Keep, Discard, replace-and-search, and stop-tracking are **separate tools** that require an explicit confirm string. They are not implied by “optimize.”
5. Direct write stays off unless the household Settings already allow it **and** the tool argument names it. Default for agent-queued work is sidecar.
6. The agent cannot invent ffmpeg flags, write under the Arr library path, or skip inspection. Invalid size targets fail closed with the same validator errors as the title page.
7. MCP is off until the operator mints a token in Settings. The token is shown once, stored hashed, and never echoed again.

Example operator sentences this should support:

- “Encode *Man of Steel* to about 8 GB.”
- “Add stereo to the SpongeBob episode that is still surround-only.”
- “What is in Review, and Keep the one that already looks good.”
- “Is the 5090 actually encoding that job?”

## Architectural decisions

- **Transport**: Streamable HTTP MCP on the **master** process only, path `/mcp`. Workers do not serve MCP. Grok and other clients connect with `url` plus an `Authorization: Bearer` header (also accept `X-Api-Key` for Arr-style clients). Optional later: a stdio shim that only forwards to that URL, so Docker users are not required to exec into the container.
- **Auth**: New household **MCP token**, same mint-once / SHA-256-at-rest pattern as the widget key, webhook token, and cluster token. Cookie sessions stay for browsers. Local-address bypass does **not** authorize MCP; a remote agent on the 5090 talking to homeserver must present the token. First-run and language confirmation still block optimize, queue, and Keep (ENG-07).
- **Implementation**: One module owns MCP JSON-RPC, tool schemas, and token checks. Each tool calls the existing `JobService`, `validateCustomPlan`, search, and store helpers. Do not add a second encode or Keep path. Do not expose raw SQL or ffmpeg.
- **Tool results**: Short JSON an agent can read. Include `itemId`, `displayTitle`, `jobId`, `status`, human `reasons` / `error`. Cap lists (search 20, jobs 20, review 20) so MCP output stays inside client size limits.
- **Size targets**: Agent may pass `targetBytes` or a decimal GB number. Convert GB to bytes in the tool, then run `validateCustomPlan` with `video: { mode: "size", targetBytes, codec? }`. The existing 1 MB minimum and “not wildly larger than the source” rules apply. Codec defaults to the title or house encode target (HEVC, or AV1 when the cluster can encode it).
- **Write mode**: Agent-queued custom plans use sidecar unless the argument is `direct` **and** Settings write mode allows direct. Never silently switch to direct.
- **Destructive tools**: `keep_review`, `discard_review`, `replace_and_search`, and `untrack` require `confirm` equal to a fixed phrase from the tool description (for example `KEEP` / `DISCARD`). Untrack stays Arr-API-only (ENG-09).
- **Out of v1**: Settings mutation, minting other tokens, cluster hello, playback protection toggles, preview clip generation, and arbitrary custom track graphs. Those can be later tools once search + size queue is trusted.
- **Tests**: Public MCP JSON-RPC and HTTP status (ENG-04). Fake library items and inspections. No live GPU or NAS.

## Delivery strategy

| Phase | Deliverable | Dependencies | Relative scope |
| --- | --- | --- | --- |
| 1 | Token mint, `/mcp` handshake, `search_titles` | None | Medium |
| 2 | Read tools: title, suggestion, jobs, nodes, Review list | 1 | Small |
| 3 | Queue suggestion, add stereo, cancel job | 2 | Medium |
| 4 | Size-target and quality custom encode (headline) | 2 | Medium |
| 5 | Keep / Discard with confirm | 4 | Medium |
| 6 | Docs and household Grok wiring | 1–5 | Small |

Phase 4 is the reason for the work. Phases 1–3 make it safe to find the right file and not double-queue. Phase 5 is optional for a first ship if Review stays in the browser; include it so “ask the agent to Keep” is a complete loop.

---

## Phase 1: Machine token and search

**User stories**: 7–8 (auth), 45–46 (search).

### What to build

Settings grows a **Mint MCP token** control, shown once, hashed like the widget key. The master serves MCP at `/mcp` only when a hash is stored. `initialize` and `tools/list` work with a valid Bearer token. One read tool: `search_titles` (`query: string`) returns up to 20 hits from the existing title search (id, type, display title, instance name, size, codec if inspected).

Wrong or missing token is 401 with no distinction between “no token configured” and “wrong token” beyond a generic failure. Workers return 404 for `/mcp`.

### Acceptance criteria

- [ ] Minting returns the raw token once; later Settings payloads only show `hasMcpToken: true`.
- [ ] `search_titles` for a known movie returns that `itemId` over MCP with a valid token.
- [ ] The same call without a token, or against a worker, does not search.
- [ ] Regenerating the token invalidates the previous one.

---

## Phase 2: Read tools

**User stories**: 38, 62–63, 67 (suggestion and health facts).

### What to build

Read-only tools that wrap existing pages:

| Tool | Purpose |
| --- | --- |
| `get_title` | One item: path basename (not a lecture), size, codec, HDR, tracks summary, open suggestion actions/reasons, pending Review id if any |
| `list_suggestions` | Optional query; same filters as Suggestions search, capped |
| `list_jobs` | Waiting / running / recent finished, node name, progress, error |
| `list_nodes` | Name, online, enabled, hardware label, current job |
| `list_review` | Pending sidecars: title, original vs sidecar size, status |

No mutation. Errors use the same copy as the HTTP API.

### Acceptance criteria

- [ ] `get_title` on an uninspected item says the file is unread, and does not invent a plan.
- [ ] `list_jobs` shows a running encode’s node name and progress.
- [ ] Read tools do not enqueue work.

---

## Phase 3: Queue the existing plan

**User stories**: 30, 60–61, 32 (optimize all stays UI-only in this phase).

### What to build

| Tool | Purpose |
| --- | --- |
| `queue_suggestion` | Enqueue the current automatic suggestion for one `itemId` (same as row Queue) |
| `add_stereo` | Same as row Add stereo; if the file already has stereo, return the existing “nothing changed” error |
| `cancel_job` | Cancel one waiting or running job by id |

`queue_suggestion` fails if there is no open suggestion, a sidecar is already pending, or optimize is gated (language / first-run). Return `{ ok, jobId }` or `{ ok: false, error }`. Do not claim success when nothing queued.

### Acceptance criteria

- [ ] Queueing a title with an open suggestion creates a sidecar job; the library path is unchanged.
- [ ] Queueing a healthy title fails with a readable error, HTTP-equivalent, not 200.
- [ ] Add stereo on a file that already has stereo reports nothing changed.
- [ ] Cancel removes a queued job the UI also shows as cancelled.

---

## Phase 4: Size and quality encodes

**User stories**: v2 20, 26–27, 50 (custom size/quality). This is the headline slice.

### What to build

| Tool | Purpose |
| --- | --- |
| `preview_plan` | Dry-run `validateCustomPlan`; return reasons, warnings, estimated bytes, errors. Queue nothing. |
| `queue_encode` | Queue a custom sidecar encode |

`queue_encode` arguments (all except `itemId` optional with defaults):

- `itemId` (required)
- `targetGb` **or** `targetBytes` (one required for size mode)
- `quality` (CRF-style integer; if set, size fields are ignored — same mutex as the title page)
- `codec`: `hevc` \| `av1` \| omit (house / title target)
- `downscale1080p`: boolean, default false
- `writeMode`: `sidecar` \| `direct`, default sidecar
- `assignedNodeId`: optional pin

The tool builds the same `CustomPlanDraft` the title page posts to `/api/library/items/:id/queue`. Track policy for this v1 encode is **keep current audio and subtitles** unless a later phase adds track ops. Size-only work must still pass `validateCustomPlan` (minimum size, not 4× source, hardware for AV1).

`preview_plan` is what the agent should call when the operator says “about 8 GB” so it can echo the real estimate and warnings before queue.

### Acceptance criteria

- [ ] `preview_plan` for 8 GB on an inspected movie returns a size-mode plan and estimated bytes; no job row.
- [ ] `queue_encode` with `targetGb: 8` creates a custom-origin sidecar job whose plan targets ~8 GB.
- [ ] `targetGb` below 1 MB equivalent or many times the source size fails with the title-page validator message.
- [ ] AV1 when no node can encode AV1 fails closed; no software fallback.
- [ ] `writeMode: "direct"` is rejected when Settings do not allow direct write.
- [ ] A second queue on the same title while a sidecar is pending fails with the existing lock error.

---

## Phase 5: Review Keep and Discard

**User stories**: Keep/Discard from the base PRD; ENG-09.

### What to build

| Tool | Purpose |
| --- | --- |
| `keep_review` | `confirm` must be `KEEP`. Calls existing Keep (Arr refresh, players). Returns 202 accepted. |
| `discard_review` | `confirm` must be `DISCARD`. Removes the sidecar only. |

Wrong confirm returns 400 and does not mutate. Keep still never deletes the library file itself; replacement stays Arr/promote.

Replace-and-search and untrack are **not** in this phase. If an agent asks to delete from Radarr, the tool should say those actions are browser-only until a later phase, rather than silently no-op.

### Acceptance criteria

- [ ] Keep with `confirm: "KEEP"` on a pending sidecar starts replacement; library path updates only after Keep succeeds (same as UI).
- [ ] Keep with any other confirm string leaves files and Review unchanged.
- [ ] Discard removes the sidecar and leaves the original.

---

## Phase 6: Docs and household wiring

### What to build

README Settings section: what MCP is for, mint token, example Grok `~/.grok/config.toml`:

```toml
[mcp_servers.polisharr]
url = "http://192.168.1.10:7373/mcp"
headers = { Authorization = "Bearer <token>" }
enabled = true
```

On-page help: the token is a household secret; MCP does not run on GPU workers; agents still cannot Keep without the confirm phrase.

No change to compose beyond documenting that only the master needs the port published (already true).

### Acceptance criteria

- [ ] A junior operator can mint a token and connect Grok using only README + Settings help.
- [ ] README does not print a live token or Arr API key.

---

## Tool catalog (v1)

| Tool | Mutates? | Phase |
| --- | --- | --- |
| `search_titles` | No | 1 |
| `get_title` | No | 2 |
| `list_suggestions` | No | 2 |
| `list_jobs` | No | 2 |
| `list_nodes` | No | 2 |
| `list_review` | No | 2 |
| `preview_plan` | No | 4 |
| `queue_suggestion` | Queue only | 3 |
| `add_stereo` | Queue only | 3 |
| `queue_encode` | Queue only | 4 |
| `cancel_job` | Queue only | 3 |
| `keep_review` | Library via Keep | 5 |
| `discard_review` | Sidecar only | 5 |

## Non-goals

- A second REST style distinct from `/api/*` besides `/mcp`.
- Letting the agent pass ffmpeg filter graphs or muxer flags.
- Auto-Keep when encode finishes.
- MCP on worker containers.
- Using the cluster token or Arr API keys as the MCP credential.

## Risks

- **Wrong title**: search must return instance name and year-like quality so “Man of Steel” 1080p vs 4K is distinguishable. `get_title` before queue is the expected agent loop; tool descriptions should say so.
- **Size confusion**: operators say “8 GB”; the validator uses bytes. The tool accepts `targetGb` and states the converted byte count in the result.
- **Token on the LAN**: same threat model as Arr keys. Hash at rest, HTTPS is the operator’s reverse proxy, not this phase.
- **Output size**: MCP clients truncate large tool results. Lists stay capped; job logs are a short tail, not the full ffmpeg log.

## Suggested first demo

After phase 4: from Grok, “Find Man of Steel 4K and show a plan to encode it to 8 GB.” Agent calls `search_titles` → `get_title` → `preview_plan`. Then “queue that.” `queue_encode` returns a job id visible on Queue in the browser. Keep remains a click in Review until phase 5.
