# Plan: Multi-node Polisharr (designated master)

Yes. Polisharr can become multi-node without becoming a second product. The shape that matches this tree is a **designated master on the always-on homeserver stack** that owns settings, library, queue, Review, and Keep, plus **pull-based workers** (the 5090 workstation and any later GPU box) that run encode/mux on the node **you pick** and write sidecars onto the shared NAS.

This is a new capability. Today one container process owns SQLite, inspect, and the job runner (`JobService` ticks every 500 ms, claims work with an in-memory `Set`). There is no cluster protocol. ENG-12 currently says the job runner lives in that one process. Multi-node is a named break of that sentence, not a silent one.

The source of truth for code is `/home/cgreever/polisharr`. Household compose lives under `~/stacks/polisharr` on each host. Master belongs on **homeserver** (`192.168.1.10`), next to Radarr/Sonarr on `arr_net`, with `/mnt/nas`. The 9950x3d / RTX 5090 overlay that exists today becomes a **worker**.

UI language: **Encode target** stays HEVC vs AV1. The machine that runs ffmpeg is **Encode node**. That is the control you designate by hand.

---

## Recommended answers to the product forks

These are locked for this plan.

| Fork | Decision | Why |
| --- | --- | --- |
| Operator surface | **One full UI, on the master.** A worker serves health plus a stub page (“this node is a worker of …”). | Two full UIs means two SQLite writers. Settings “sync” then becomes a distributed database. |
| Master location | **Homeserver always-on Docker stack.** | UI, webhooks, inspect, Keep, and the queue stay up when the workstation sleeps. Arrs already live here. |
| Master encodes? | **Yes, if you designate it.** Homeserver has an RTX 2000E Ada. It is a selectable encode node, not an automatic first pick. | Always-on GPU for when the 5090 is off. You choose which GPU a job uses. |
| Who picks the GPU | **You do.** House default encode node, plus a per-job override. No least-busy auto-balance. No silent failover. | “End user can manually designate the encoding target.” A sleeping 5090 must not shove work onto the 2000E unless you said so. |
| Worker work | **Encode and mux only.** Inspect, language ID, OCR, Arr sync, Review, and Keep stay on master. | `Optimizer` is already the deep seam. Keep talks to Arr/Plex/Jellyfin and replaces library files. |
| Settings | **Configure once on master.** Workers inherit house policy on each job. They do not store a second editable settings blob. | “Sync settings” as the operator experiences it. |
| Paths | **Every node binds the same Arr paths and the same review folder.** No path maps. | Already a v1 non-goal. Household `/mnt/nas:/mnt/nas` already satisfies it. |
| Capability | **Safety filter, not a scheduler.** AV1 jobs cannot run on a node that cannot encode AV1. The picker only lists nodes that can run that plan. | Mixed GPUs stay honest without stealing the operator’s choice. |
| Discovery | **Operator designates master via env.** No leader election. | Two standalones remain two apps. A worker that cannot reach master sits idle. |

---

## Household topology

```
homeserver 192.168.1.10          9950x3d workstation
┌─────────────────────────┐      ┌─────────────────────────┐
│ polisharr ROLE=master   │◄─────│ polisharr ROLE=worker   │
│ RTX 2000E Ada (optional │ pull │ RTX 5090                │
│   encode node)          │ jobs │ encode node you pick    │
│ SQLite, UI, Arr sync,   │      │ stub UI / health        │
│ inspect, Review, Keep   │      │ ffmpeg / mkvmerge only  │
│ arr_net + /mnt/nas      │      │ /mnt/nas (same paths)   │
└──────────▲──────────────┘      └─────────────────────────┘
           │
     Radarr / Sonarr
```

Master compose joins `arr_net` so webhooks can stay `http://polisharr:7373`. Worker compose uses `POLISHARR_MASTER_URL=http://192.168.1.10:7373` (or the homeserver hostname). Do not share `/config`. Each host has its own config volume; only the master volume holds `polisharr.db`.

Cutover (ops, after the feature exists): move the current 5090 `/config` to homeserver `~/appdata/arr/polisharr/config` so the library is not re-inspected from scratch. Point Radarr/Sonarr Connect at the homeserver URL if it is not already `polisharr` on `arr_net`. Then start the 5090 container as a worker with the cluster token.

---

## What exists today (constraints)

- **One SQLite file** at `{CONFIG_DIR}/polisharr.db` with WAL. Library, inspections, suggestions, jobs, reviews, settings, Arr keys, and the admin user all live there. Two processes must not share that file.
- **House settings** are one JSON blob (`settings.key = 'app'`): language, review path, size caps, suggestion defaults, encode target (HEVC/AV1), concurrency, off-peak, write mode, and friends. Arr/player connections are a separate `instances` table with encrypted secrets.
- **Hardware is not a setting.** Each process probes ffmpeg plus `/dev/nvidia*` or `/dev/dri`.
- **Jobs are optimize-only.** Inspect, Whisper LID, and PGS OCR are not queue rows. One job payload is an `ExecutablePlan` plus the library path and inspection report.
- **Sidecars land on `reviewPath`.** Keep (and Direct write promote) replace the library file, refresh Arr, and notify players. Workers must not do that in v1 of this feature.
- **Concurrency** is a single house integer (1–16) used for local ffmpeg children and for Keep copies. Encode slots become **per node**. Keep copies stay a master-local cap.
- **Cancel** is an in-memory `Set` plus `SIGTERM` of a child of this process. Remote cancel needs a flag the worker polls.
- **Restart** turns `running` jobs back into `queued`. Leased remote jobs need a heartbeat so a live worker is not stolen on master reboot.

---

## Architectural decisions

Durable across every phase. Do not share the database. Do not add Redis, NATS, or SQLite-over-NFS.

### Roles

Same image. Role from env, default preserves today’s app:

- `POLISHARR_ROLE=standalone` (default): current single-node behavior. No cluster calls. Encode node is this process.
- `POLISHARR_ROLE=master`: UI + SQLite + inspect + Keep + node registry + lease API. Encodes only jobs **assigned to this node**.
- `POLISHARR_ROLE=worker`: no library sync, no inspect walk, no first-run wizard, no mutating Settings/Queue/Review. Heartbeat + claim jobs assigned to this node + run `Optimizer` + report.

Worker also needs:

- `POLISHARR_MASTER_URL` (homeserver, example `http://192.168.1.10:7373`)
- `POLISHARR_CLUSTER_TOKEN` (shared secret; hashed at rest on master, same presentation rules as the Arr webhook token)
- Optional `POLISHARR_NODE_NAME` (defaults to hostname; this is the label in the Encode node picker)

### Encode node (manual designation)

This is the scheduler. Capability matching only filters the picker.

**House default.** Settings → Nodes (or Encode): **Default encode node**. A dropdown of registered, enabled nodes that currently report a hardware encoder. Standalone has one implicit choice (this machine). Saving does not rewrite jobs already in Queue.

**Per-job override.** Queueing from Suggestions, a title page, Optimize all, or a custom plan can pick a different node. The choice is stored on the job as `assigned_node_id` at enqueue (same snapshot idea as `writeMode`). Waiting jobs can be moved with a Queue action **Run on…**.

**No silent failover.** If the assigned node is offline, drained, or at capacity, the job stays `queued` (or `held` if you are also outside off-peak). Home Status and Queue say which node it is waiting for. It does not jump to the 2000E because the 5090 slept.

**Capability filter.** The picker and `Run on…` omit nodes that cannot execute that plan (AV1 on a HEVC-only GPU, video transcode on `backend: none`). Tracks-only / remux jobs can run on any node that has ffmpeg/mkvmerge, including a GPU-less master if you really pick it.

**Suggestions AV1.** Offer AV1 when **any enabled node** currently reports AV1, not only the master’s probe. The job still does not start until you (or the house default) assign a node that can encode AV1.

### Settings vs node-local

**House policy (master only, included in each job document):** preferred language, size caps, suggestion defaults, encode target (HEVC/AV1), write mode, review path, off-peak window, conservative mode, profile auto-assign, default encode node id, exclusions, per-title encode target / series audio mix as already snapshotted into the plan.

**Node-local (never cloned as “the” settings):** GPU probe, this node’s concurrency, `CONFIG_DIR` / SQLite / `.secret`, PUID/PGID, tool binary paths, NVIDIA vs `/dev/dri` compose.

**Master-only secrets:** admin user, sessions, Arr/player API keys, webhook token, widget key. Workers never receive Arr keys if they do not Keep.

Concurrency is per node, stored on the node row, edited on Settings → Nodes. First hello can default from worker env `POLISHARR_CONCURRENCY` or `1`. Keep copy concurrency stays on the master (NAS replace), independent of encode slots.

Off-peak stays a master scheduler concern: a node only ever receives jobs that are already allowed to run (`queued`, not `held`).

### Job document

The worker does not need the library catalog. Master hands it the existing optimizer request:

- job id
- assigned node id (must match the claimant)
- source path (Arr-reported, must exist on the worker mount)
- review directory (same string as Settings)
- executable plan
- inspection report
- video target (HEVC/AV1)
- conservative flag
- write mode (see Direct write below)
- lease token

Worker probes **its own** GPU and fills `backend` / `vaapiDevice` locally. Master does not send “use CUDA.”

Work temps go to `{reviewPath}/.work/{nodeId}/{jobId}` so two GPUs do not collide under `.work/`. Sidecar name stays `{basename}-{jobId}.mkv`.

### Lease protocol (pull)

Workers pull. Master never opens a connection into the worker (the workstation does not need a published worker port for the protocol).

Cluster routes, token-auth only (not the login cookie):

- `POST /api/cluster/hello` — register or refresh node id, name, version, hardware, concurrency
- `POST /api/cluster/heartbeat` — last seen, currently running job ids; response includes job ids to cancel
- `POST /api/cluster/claim` — atomic take of up to `freeSlots` **queued jobs assigned to this node**
- `POST /api/cluster/jobs/:id/progress` — phase, progress, log chunk; renews lease
- `POST /api/cluster/jobs/:id/complete` — sidecar path + output probe + warning
- `POST /api/cluster/jobs/:id/fail` — error sentence

Claim is SQL, not an in-memory `Set`:

```
UPDATE jobs SET status = 'running', node_id = ?, lease_until = ?, lease_token = ?
WHERE id = ? AND status = 'queued' AND assigned_node_id = ?
```

A worker cannot claim another node’s jobs. The master local runner only starts jobs whose `assigned_node_id` is the master node.

Lease TTL about 30 seconds; heartbeat about 10 seconds. Expired lease with no fresh heartbeat returns the row to `queued` **on the same assigned node**. Master restart does **not** blindly `running → queued` for rows whose lease is still valid.

Cancel: Queue still sets `cancelled` immediately (today’s UX). Worker sees the id on the next heartbeat and `SIGTERM`s its child. A complete that arrives after cancel is ignored; sidecar is deleted if present.

### Direct write and Keep

Workers **always** write a sidecar. They never replace a library original.

- `writeMode: sidecar` → master inserts the Review row from the complete payload (today’s success path).
- `writeMode: direct` → master runs the existing promote/Keep path on the sidecar (Arr refresh, player notify, delete review copy). Failure is a failed job, not a silent library write on the worker.

Keep/Discard of Review cards stays on master. That is why master lives on homeserver: Keep still works when the 5090 is off, as long as the sidecar already landed on the NAS.

### Auth and split-brain

Cluster token: generated in Settings, SHA-256 at rest, shown once, rotated like the webhook token. Accept `Authorization: Bearer` or `X-Api-Key`. Wrong token is a generic 401.

No auto-discovery. Two `ROLE=master` processes do not reconcile. A worker without `MASTER_URL` or token refuses to start encode work and says so on its stub page.

Protocol version: worker sends image version; master rejects a worker it cannot speak to.

### UI

- Settings **Nodes**: this machine (role, hardware, local concurrency) plus each worker (name, last seen, GPU, slots, current title, enabled/drain). **Default encode node** is a required dropdown once more than one node exists.
- Queue, Suggestions, title page, custom plan: **Encode node** picker, defaulting to the house node. Waiting jobs show “Waiting for {node}” when that node is offline.
- Queue **Working now**: which node is running the job. **Run on…** for waiting jobs.
- Home Status: “Encoding {title} on {node}” or “Waiting for {node}.”
- Worker stub: hardware, master URL, current job, “open the master” link. No second first-run.

Do not reuse the words **Encode target** for the machine. Encode target remains HEVC/AV1.

### Compose

Master on homeserver (NVIDIA runtime for the 2000E, `arr_net`, `/mnt/nas`):

```yaml
environment:
  POLISHARR_ROLE: master
  POLISHARR_NODE_NAME: homeserver
  POLISHARR_CLUSTER_TOKEN: <token>
```

Worker on the 5090 box (same media bind, its own `/config`, no shared DB):

```yaml
environment:
  POLISHARR_ROLE: worker
  POLISHARR_NODE_NAME: 5090
  POLISHARR_MASTER_URL: http://192.168.1.10:7373
  POLISHARR_CLUSTER_TOKEN: <token>
```

Port 7373 on a worker can stay published for the stub/health, or not. The protocol is worker-outbound.

### Standards break

**ENG-12 (named):** each container remains one process. The job runner on a master may execute locally **only when the job is assigned to the master node**, or lease it to the assigned worker. Interrupted local jobs still return to the queue. Interrupted remote jobs return only when the lease is dead, still assigned to that node. Keep recovery on master is unchanged. Do not hard-code household IPs in server code; master URL is env.

Path mapping, SSH-to-NAS, copy-to-local-disk, CPU encode, least-busy auto-balance, and multi-master remain out of scope.

---

## Modules (deep seams)

| Module | Interface | Stays behind it |
| --- | --- | --- |
| Cluster | hello, heartbeat, token check, node list | node table, stale detection, protocol version |
| Encode node | default node, per-job assignment, capable-node list | picker filtering, offline waiting copy |
| Job lease | claim, renew, expire, complete, fail, cancel-ids | SQL claim scoped to `assigned_node_id`, lease TTL |
| JobService | enqueue, schedule, Keep, public job list | off-peak, shared-file lock, Review insert, direct-write promote |
| Optimizer | already `OptimizeRequest` → sidecar | ffmpeg / mkvmerge / GPU |
| Worker loop | poll master, run optimizer, report | no SQLite catalog, no Arr |

JobService today schedules, runs, and Keeps. The new seam is “run”: local in-process runner vs remote lease, both gated on assigned node. Keep and enqueue stay on master. Optimizer is not rewritten.

---

## Alternatives rejected

- **Master on the 5090 workstation.** The queue, UI, and Keep would die when that box sleeps. Homeserver is the always-on Arr stack.
- **Least-busy or “fill master first” scheduling.** Conflicts with manual designation. A sleeping 5090 must not spill onto the 2000E unless you moved the job.
- **Shared `polisharr.db` on NFS.** WAL plus two Node writers will corrupt the queue.
- **Two full UIs with bidirectional settings sync.** That is multi-master. Arr keys, first-run, and suggestion recompute do not have a merge story.
- **Push jobs from master to worker HTTP.** The workstation would need a published port. Pull fits a LAN GPU box that may be off.
- **External Redis/NATS.** One household master and a handful of GPUs do not earn a broker.
- **Workers also inspect / Keep.** Inspect is the catalog; Keep is Arr+library replace. Encode is the slow part, and Keep must survive worker downtime.

---

## Phase 1: Node identity, token, Nodes UI, default encode node (standalone-safe)

**What to build**

A running standalone shows itself as a node: name, role, live hardware, local concurrency. Settings can mint/rotate a cluster token the same way it mints the Arr webhook token. Default encode node is this machine and is not yet a second picker on Queue. Existing queue behavior is unchanged.

**Acceptance criteria**

- [ ] Default `POLISHARR_ROLE` omitted or `standalone` matches today’s app: one process, one GPU, same tests.
- [ ] Settings shows this node’s hardware and local concurrency without a second save path for house language/caps.
- [ ] Cluster token is hashed at rest, shown once, never echoed on GET settings (`hasClusterToken` only).
- [ ] ENG-12 still holds for standalone: restart returns interrupted local jobs to the queue.

---

## Phase 2: Worker role, hello, heartbeat, stub page

**What to build**

A second container with `ROLE=worker`, `MASTER_URL`, and the token registers, heartbeats, and refuses first-run / library mutation. Master Settings → Nodes lists it (last seen, GPU, version). Worker HTTP is health + stub. If master is down, the worker stays idle and says so. Default encode node becomes a real dropdown once a second node has said hello.

**Acceptance criteria**

- [ ] Worker does not create an admin user, does not sync Arr, does not inspect, does not start a local catalog job tick.
- [ ] Hello without a valid token is 401 with a generic error.
- [ ] Stale heartbeat marks the node offline in Settings. Default encode node still names it; Queue will wait, not reroute.
- [ ] Worker stub names the master URL and the probed GPU.
- [ ] Two standalones without worker env still do not talk to each other.

---

## Phase 3: Assigned-node lease, remote optimize, sidecar Review

**What to build**

Enqueue snapshots `assigned_node_id` from the house default or the per-job picker. Master’s local runner only starts jobs assigned to itself. Workers claim only jobs assigned to them. Worker runs the existing optimizer against the NAS paths, streams phase/progress/log, and completes with a sidecar path. Master inserts the Review row.

Queue shows the node name. Waiting for an offline node is visible. Cancel on master stops a remote ffmpeg via heartbeat. Lease expiry requeues **on the same node**. Changing Settings default does not move already-queued jobs; Queue **Run on…** does.

House settings the optimizer needs travel on the job document. Changing Settings on master affects the **next** claimed job; in-flight jobs keep the plan they were claimed with.

**Acceptance criteria**

- [ ] Two fake workers cannot claim the same job (atomic SQL claim).
- [ ] A worker cannot claim a job assigned to a different node.
- [ ] Master does not locally start a job assigned to a worker.
- [ ] A sidecar job completed by a worker appears on Review with the same compare payload as a local job.
- [ ] Queue Working now names the node; a queued job names the assigned node; logs are readable from the master UI.
- [ ] Cancel marks cancelled immediately; worker deletes temp/sidecar; library original is untouched.
- [ ] Killing a worker without complete causes lease expiry and the job returns to queued on that node (once).
- [ ] Master restart does not steal a job whose lease is still alive.
- [ ] Assigned node offline: job stays queued; it does not start on another GPU.
- [ ] Shared-file lock (two episodes, one MKV) still 409s before any claim.
- [ ] Worker work dir is namespaced; two nodes encoding at once do not clobber `{reviewPath}/.work`.
- [ ] Standalone with no workers: Phase 1 tests still pass.

---

## Phase 4: Pickers, capability filter, per-node concurrency, drain

**What to build**

Suggestions, title queue, Optimize all, and custom plan get an Encode node picker defaulting to the house node. The list is nodes that can run that plan (AV1 filtered). Per-node slot counts in Settings → Nodes. Drain/disable a node: no new claims; in-flight jobs finish; waiting jobs stay assigned unless you **Run on…** elsewhere.

Suggestions treat cluster AV1 as “any enabled node reports AV1,” not “this process.”

**Acceptance criteria**

- [ ] An AV1 plan’s picker omits a HEVC-only worker; enqueue to that node is rejected.
- [ ] House HEVC/AV1 target still offers AV1 when a worker reports AV1 even if the master GPU does not.
- [ ] House default 5090 + one job override to homeserver can run both GPUs at once (each slot count 1).
- [ ] Drained node takes no new jobs; existing lease can complete; queued jobs assigned to it wait.
- [ ] Copy does not say “Encode target” for the machine picker.
- [ ] No CPU encode path is introduced (ENG-05).

---

## Phase 5: Direct write via master promote; docs, compose, household cutover notes

**What to build**

Worker complete of a `writeMode: direct` job does not replace the library file. Master promotes using the existing Keep/direct-write machinery, then records history the same way a local direct write does.

Document master-on-always-on-host, worker overlay, identical binds, cluster token, Encode node vs Encode target, and the ENG-12 break. Example `compose.worker.yaml` next to the NVIDIA/Intel examples.

Household (not product code): homeserver `~/stacks/polisharr` is `ROLE=master`; the current 9950x3d compose becomes the worker; move `/config` once so the DB is not duplicated.

**Acceptance criteria**

- [x] Direct write completed by a worker replaces the library file only on master after integrity checks; worker never writes `{dest}.opt-old`.
- [x] Arr refresh / rename / player notify still happen once, from master, even if the worker has gone offline after complete.
- [x] Queue new Arr imports still lock sidecar even when workers exist, and still snapshot the house default encode node.
- [x] README states: one master (prefer the always-on Arr host); same media path on every node; do not share `/config`; pick an encode node; waiting jobs do not fail over.
- [x] `npm test`, `npm run typecheck`, and `npm run build` pass.

---

## Testing decisions

Good tests stay on public behavior (ENG-04): HTTP claim/complete payloads, assigned node, job status, Review rows, filesystem sidecar path, cancel, lease expiry with a fake clock, picker rejection of an incapable node. Do not assert SQL column names in UI tests.

Prior art: `jobs.test.ts`, `jobs-keep.test.ts`, `jobs-shared-file.test.ts`, `arr-webhook.test.ts` (hashed token shown once), `app.test.ts` (401 without leaking). Fake optimizer already proves enqueue stays responsive; reuse that for a fake cluster worker.

No live NAS or GPU in unit tests. A fake worker client and a fake optimizer are enough to prove two-claimer exclusion, cross-node claim rejection, lease steal, offline wait, and Review insert.

---

## Out of scope

- Path mapping between different mount layouts
- SSH / clonefile / copy-to-local-scratch before encode
- Multi-master, automatic failover, or leader election
- Least-busy auto-balance or spilling a 5090 job onto homeserver when the workstation sleeps
- Workers running inspect, language ID, OCR, or Keep
- Sharing `polisharr.db` or `.secret` across containers
- CPU video encode
- Kubernetes-style replicas of the UI
- Automatically rewriting Radarr/Sonarr webhook URLs during household cutover

---

## Suggested PR order

1. **Node row + cluster token + Settings Nodes (this machine)** — standalone-safe.
2. **Worker role + hello/heartbeat + stub page + default encode node dropdown.**
3. **`assigned_node_id` + claim scoped to that node + remote sidecar Review + cancel/lease expiry + offline wait.**
4. **Pickers on queue paths + capability filter + per-node concurrency + drain + Run on…**
5. **Direct-write complete on master + worker compose + README.**

Each PR is reviewable without the next. After PR 3 you can encode on the 5090 while the UI and Keep stay on homeserver.

---

## Open questions

None that block the design. Remaining taste, not architecture:

1. Should Queue new Arr imports always use the house default node (recommended: yes), or skip auto-queue when that node is offline?
2. Exact default node names (`homeserver`, `5090`) vs hostname?
