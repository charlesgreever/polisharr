# Plan: Spread leftover pool jobs across encode nodes

Today a worker asks for every free slot in one claim. The 5090 with four slots can take the last five **Any open node** jobs in a single heartbeat. The Mac and deskmini then sit idle while that one box finishes the tail of the queue.

The user wants the opposite when the queue is running out: start the remaining jobs on several machines, not fill every slot on the first GPU that checks in.

## What exists today

- Pool jobs have `assigned_node_id` null. Pinned jobs name a node.
- `claimQueuedJobs` takes pinned work up to `freeSlots`, then fills the rest from the pool. No regard for other nodes.
- Workers heartbeat every 10s and send `freeSlots` = unused concurrency. The master may return that many jobs.
- The master local tick (500ms) also starts up to `capacity` matching jobs, including pool jobs.
- Capability still applies: AV1 pool jobs skip HEVC-only nodes.
- A job pinned to the 5090 does not move. That lock stays.

## Product locks

- **Pinned jobs still fill that node.** Spreading applies only to **Any open node** pool jobs.
- **No silent failover.** Do not reassign a named node.
- **If only one capable node has a free slot, fill it.** Spreading when nobody else can run the leftover only delays the only GPU.
- **Deep queues still fill slots.** When there is more pool work than cluster free slots, each node may take all of its free slots. The 5090 should not sit at 1/4 while 200 titles wait.
- **No new Settings toggle.** This is how the pool behaves, not a second policy.

## Algorithm

Pure function, then used by `claimQueuedJobs` and the master local tick.

Inputs for the claiming node:

- `freeSlots` after taking pinned jobs
- `pool` = queued pool jobs this node can encode
- `peerFreeSlots` = free slots on other enabled, online nodes that can encode at least one of those pool jobs (same capability filter)

Output: how many pool jobs this claim may take.

```
if freeSlots == 0 or pool == 0: 0
if peerFreeSlots == 0: freeSlots          // we are the only capable machine
if pool <= freeSlots + peerFreeSlots: 1   // remaining work fits in parallel — spread
else: freeSlots                           // queue is still deep — fill this GPU
```

Worked examples:

| Pool left | This node free | Other capable free | Take |
| --- | --- | --- | --- |
| 5 HEVC | 5090 has 4 | Mac 4 + deskmini 2 + homeserver 1 = 7 | 1 (5 ≤ 11) |
| 200 HEVC | 5090 has 4 | 7 | 4 (200 > 11) |
| 2 AV1 | 5090 has 4 | 0 (nobody else has AV1) | 4, actually 2 jobs exist so 2 |
| 3 HEVC, 5090 already running 3 | 5090 has 1 | Mac idle 4 | 1 (3 ≤ 5) |
| 2 pinned + 3 pool | 4 slots | peers 7 | 2 pinned + 1 pool |

Sequential heartbeats then naturally deal the tail: 5090 takes 1, Mac takes 1, deskmini takes 1, homeserver takes 1.

Workers do not change their request. They still send `freeSlots: 4`. The master returns fewer pool jobs.

## Phase 1: Spread pool claims on the master

**User story to add:** 108d. Extends 108c.

### What to build

- `poolSpreadLimit` in the cluster module (pure, table-tested).
- `claimQueuedJobs` uses it for the pool half only.
- Master local tick uses the same limit for unassigned jobs (pinned local jobs still fill).
- Count peer free slots from node rows: enabled, online (`lastSeen`), `concurrency - runningCount`, `nodeCanEncode` for the remaining pool mix. Conservative and cheap: a peer counts if it can encode **any** remaining pool job this claimant can encode.

### Acceptance criteria

- [ ] Five HEVC pool jobs, four capable nodes with free slots: first claim with 4 free slots receives 1 pool job
- [ ] Two hundred HEVC pool jobs: a node with 4 free slots still receives 4
- [ ] Two AV1 pool jobs and only the 5090 can encode AV1: that node may take both (no idle peer)
- [ ] Pinned jobs on the 5090 still claim up to that node’s free slots even when the pool is spreading
- [ ] An HEVC-only node still cannot claim an AV1 pool job
- [ ] A job pinned to an offline node still does not start on another machine

## Out of scope

- Changing heartbeat interval
- Rebalancing jobs that are already running
- Auto-unpin of named-node waiting jobs
- A Settings control for this
- Least-busy pick at enqueue time (already skipped in the open-node plan)

## Notes

- Tests live next to the existing pool-claim fixture in store tests, plus `poolSpreadLimit` cases in cluster tests.
- Copy: none required in the UI. Queue already says **Any open node**.
- After approval, save as `plans/spread-pool-jobs.md` and add PRD 108d.

One phase. Demo: queue five Any-open-node titles with four GPUs idle and watch Working now show four machines, not four jobs on the 5090.
