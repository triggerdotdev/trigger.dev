# CK virtual-time scheduling: known limitations (read before enabling)

The feature ships behind `RUN_ENGINE_CK_VTIME_SCHEDULING_ENABLED` (off by default).
A three-model blind adversarial review found no Critical issues; the correctness
and safety fixes it surfaced are applied. The items below are the review findings
that were deliberately NOT code-fixed because they are bounded, self-healing, or
pre-existing. They are the checklist for the "enable in production" decision.

## Bounded state drift on paths that don't GC `ckVtime`

The vtime dequeue command GCs a drained variant from both `ckIndex` and `ckVtime`.
But `acknowledgeMessageCkTracked`, `expireTtlRuns`, `moveToDeadLetterQueueCkTracked`,
and the flag-off dequeue command do NOT remove a drained variant from `ckVtime`
(they were left byte-identical). Consequences, all bounded:

- A low-tag tombstone (a variant emptied by ack/TTL/DLQ without a vtime serve) is
  the minimum entry, so the very next vtime dequeue visits it first, finds the
  queue empty, and GCs it: self-heals in ~1 call. It can pin the floor low for
  that one call.
- A high-tag tombstone (a heavily-served variant whose remaining backlog is then
  removed out-of-band) lingers until the floor climbs to its tag or the 24h state
  TTL fires. Pure memory drift, does not affect fairness.
- Rollback (flag on -> off): variants drained by the old command leave inert
  `ckVtime` entries. Old code never reads them; they expire within `stateTtl`
  (default 24h) once the base queue stops receiving writes. To reclaim sooner,
  delete the `*:ckVtime` / `*:ckVtimeFloor` keys after disabling.

A full fix (vtime-aware ack/TTL/DLQ command variants) is deferred: it adds three
more command variants for a bounded, self-healing drift on a dark feature.

## Tie-break among equal virtual-time tags is member-name order

When variants tie at the same tag (a fresh batch at the floor: cold start, new
deploy, or a GC'd variant re-entering), pass 1's `ZRANGE ckVtime` falls back to
Redis's lexicographic member order, i.e. the fully-qualified queue name including
the client-chosen concurrency key. A lex-early name gets a first-serve head start
in a tie. This is PRE-EXISTING (the head-timestamp baseline ties the same way) and
bounded: tags diverge after the first serve, so it affects only first-serve order,
not long-run fairness. A future improvement is to tie-break by head age instead of
member name. Do not rank fairness on an untrusted string if that head start ever
matters at scale.

## Future-scheduled / retry-backoff variants occupy pass-1 window slots

Enqueue and nack register a variant in `ckVtime` even when its head message is
scheduled in the future (delayed run, nack backoff). Pass 1 selects by tag with no
readiness filter, so a burst of future-headed variants can fill the pass-1 window
(`maxCount * scanWindowMultiplier`, default 3x); actual serves then come from pass
2 (today's age order). Work conservation still holds (pass 2 is a superset), so
this is fairness degradation under a retry storm, not loss. Widen
`scanWindowMultiplier` if observed.

## Minor operational notes

- Idle-polling a CK queue whose only work is future-scheduled now does a couple of
  extra Redis writes per poll (floor SET + EXPIRE) vs the old early-return. Bounded;
  visible in Redis write metrics after enabling.
- `descriptorFromQueue` positional parsing mis-splits a concurrency key containing
  a literal `:` (pre-existing; not introduced here). The vtime feature uses the
  full queue key as the ZSET member, which is unaffected, but any code that parses
  the member back into fields inherits the pre-existing limitation.

## Rollout (from the plan)

1. Deploy with the flag off (new command scripts registered, never called).
2. Enable on a staging cell; watch dequeue-latency spans and Redis op rates against
   the op-count budget; run a sybil-shaped workload and confirm the light key's wait.
3. Enable in production; during the instance-rolling window behaviour interpolates
   between age order and fair order (both endpoints safe).
4. Rollback = flip the env var off; stale vtime keys expire via TTL within 24h.
