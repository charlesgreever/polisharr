# Plan: Sidebar work counts, node activity, and open-node assignment

Queue and Review already badge in the sidebar (`GET /api/work`, PRD 165b). Home already has suggestion and error totals. Movies and Series pages already compute suggestion counts. Encode jobs already pin to a house default node and wait if that node is busy or asleep. This plan extends those seams. It does not add a second poller or a silent GPU balancer.

## What exists today

- Sidebar badges: Queue (`queueActive` = waiting + running) and Review. Zero is hidden.
- Header: one line, `Working · {title}` for a **single** running job. Twelve concurrent encodes still look like one title.
- Home Status: one running title plus node name, or `Waiting for {node}`, or `{n} waiting`.
- Queue: Working now cards say `On 5090`. Waiting rows say `Waiting for MacBook Pro` only when that node is **offline**, not when it is full. `Run on…` is the existing Encode node picker.
- Settings → Nodes: name, role, hardware, online/drained, concurrent slots. No current title. Help text: new jobs use the default node; offline does not move them.
- Assignment: enqueue always stores `assigned_node_id` (per-job override or house default). `claimQueuedJobs` only takes rows assigned to **that** node. A free Mac will not pick up a job pinned to the 5090.
- Capability: AV1 / no-encoder nodes are disabled in the picker. That stays.

## Product locks (all phases)

- **Badges mean remaining work, not library size.** Suggestions = open suggestion rows. Movies = movies with an open suggestion. Series = episodes with an open suggestion. Those three add up. Hide `0`, same as Queue/Review. Do not badge total movies/shows (thousands, always on).
- **One poll.** Keep the existing 4s `GET /api/work` in Shell. Do not add a second interval. Counts and node activity ride that payload. `/api/home` can reuse the same summary.
- **No silent failover.** A job pinned to the 5090 stays there if the 5090 is asleep or full. That was the multi-node lock: a sleeping workstation must not shove work onto the 2000E. Overflow is an **explicit** assignment, not a surprise.
- **“Any open node” is opt-in.** Stored as `assigned_node_id = NULL` on the job. House default uses the sentinel `any` so empty still means this machine. Picker and Queue make the choice visible.
- **Capability still filters.** A pool job is only claimed by a node that can run that plan (AV1, video encode). Tracks-only can run anywhere with ffmpeg.
- **Language:** Encode **node** (machine). Encode **target** stays HEVC vs AV1. Slots = concurrent jobs on that node.

## Open-node options (phase 3)

Ways to get waiting work onto an idle GPU, ranked:

1. **Picker labels only.** `5090 (2 of 4 busy)`, `MacBook Pro (idle)`, `homeserver (offline)`. Operator still picks. Cheap; does not drain a stuck queue by itself.
2. **Queue action “Move to an open node”.** One click on a waiting job (or bulk on Waiting). Master picks the capable online node with the most free slots **at click time** and **pins** that id. Operator-visible, no surprise later.
3. **“Any open node” pool (recommended house option).** `assigned_node_id` null. Claim order: jobs pinned to this node first, then pool jobs this node can run, up to free slots. New enqueue can use the pool when house default is “Any open node”, or a per-job picker choice.
4. **Overflow list.** Skip this pass.
5. **True least-busy auto at enqueue.** Skip this pass.

**Recommendation:** ship (1)+(2)+(3). Keep the current named default as the factory setting so existing queues do not change behavior until the operator picks “Any open node”.

---

## Phase 1: Sidebar counts for Suggestions, Movies, and Series

**User stories:** 165c. Reuse 25a / 33a / 38.

### What to build

Extend `GET /api/work` (and the Shell poll) with:

- `suggestions` — dismissed=0 suggestion rows (already in `workSummary`, not returned today)
- `movieSuggestions` — movies with an open suggestion
- `seriesSuggestions` — episodes with an open suggestion (so movie + series = suggestions)

Sidebar uses the same badge chip as Queue/Review. Errors can ride along (`errors` is already in `workSummary`) and badge the Errors item; hide at zero.

SQL stays aggregate. Do not scan the library into the 4s poll.

### Acceptance criteria

- [ ] Suggestions, Movies, and Series show a count when that count is > 0 and hide it at 0
- [ ] Movie badge + series badge = suggestions badge on a fixture library
- [ ] Queue and Review badges still match today’s `queueActive` / `review`
- [ ] `GET /api/work` stays a small authenticated JSON object (no library rows)
- [ ] Existing Movies/Series page pills still match the same SQL definition

---

## Phase 2: What each node is doing

**User stories:** 165d. Extends 126 / 165 / 142.

### What to build

`GET /api/work` (and Home) include a `nodes` array, one row per registered node:

- name, online, enabled, slots used, slots max
- running jobs: title, phase, progress, href (not only `currentJobId`)
- waiting pinned to that node (count)

Surfaces:

- **Header:** if one job, keep `Working · {title}`. If several, `Working · 3 on 5090, 2 on MacBook Pro`. Inspect still wins.
- **Home:** replace the single Status sentence with a short node list when more than one node exists.
- **Queue Waiting:** say `Waiting for {node} (busy)` when the node is online but at capacity, not only when it is offline.
- **Settings → Nodes:** show current titles and `2 / 4` on each card.

### Acceptance criteria

- [ ] Two running jobs on two nodes both appear in the work payload and on Home
- [ ] Header does not imply a single encode when several are running
- [ ] A waiting job on an online-but-full node says it is waiting because that node is busy
- [ ] Offline vs drained vs full are different sentences
- [ ] Single-node / standalone UI does not grow a useless cluster table (hide the node list when `nodes.length <= 1`)

---

## Phase 3: Suggest and assign an open node

**User stories:** 108b, 108c.

### What to build

**Picker labels.** Every Encode node option includes load: idle, `n of m busy`, offline, drained, no encoder. House default suffix stays.

**House default.** Settings dropdown gains **Any open node** (`any`). Help text: named default waits for that machine; Any open node uses the next free capable slot. Saving does not rewrite jobs already in Queue.

**Per-job picker.** Same extra option on Suggestions, title page, Optimize all, Queue waiting rows.

**Claim.** For each node with free slots:

1. Take queued jobs whose `assigned_node_id` is this node.
2. If slots remain, take queued jobs with `assigned_node_id` IS NULL that this node can encode.
3. Never claim another node’s pinned jobs.

**Queue “Move to an open node”.** Waiting job (and bulk on Waiting): master selects the capable online enabled node with the most free slots. If several tie, prefer the house named default if it is in the tie set, else stable name order. Write that node id (pin). If none capable and online, 409: `No encode node is free for this plan.`

### Acceptance criteria

- [ ] A job pinned to an offline 5090 does not start on the Mac
- [ ] A pool job starts on the first capable node that has a free slot
- [ ] AV1 pool jobs skip HEVC-only nodes
- [ ] “Move to an open node” pins a named idle node and the Queue line updates
- [ ] Picker labels show busy vs idle without the operator opening Settings
- [ ] Existing installs keep a named house default; behavior of already-queued jobs does not change until the operator picks the pool or Move

---

## Out of scope

- Auto-Keep, software encode, changing Encode target
- Leader election, Redis, sharing SQLite
- Homepage widget fields beyond what `/api/work` already inspired
- Progress bars in the sidebar
- Reordering the Menu list

## Suggested build order

Phase 1 is a one-sitting vertical slice and is useful alone. Phase 2 makes the queue readable with four GPUs. Phase 3 is the behavior change; do not start it until the activity strip exists so the operator can see *why* a job moved.
