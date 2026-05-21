---
area: webapp
type: fix
---

Close the PG+buffer idempotency-key race during the mollifier gate-transition window. Without this, two simultaneous same-key triggers arriving as the gate trips could each become race-winners (one PG, one buffer) — the customer would receive two distinct runIds for the same idempotency key, and operations on the buffered "loser" would silently vanish on drain. Design: `_plans/2026-05-21-mollifier-idempotency-claim.md`.

`IdempotencyKeyConcern.handleTriggerRequest` now does a pre-gate Redis `SETNX` claim after the existing PG + buffer cache checks miss. All same-key triggers serialise through this claim before the gate decides PG-passthrough vs mollify; losers poll until the winner publishes its runId, then return that runId with `isCached:true`. Skipped for `resumeParentOnCompletion` (triggerAndWait bypasses the gate via F4 and is PG-canonical).

`RunEngineTriggerTaskService.callV2` wraps the trigger pipeline in a try/catch around the claim: on success, the winning runId is published to the claim key so waiters resolve; on any pipeline error, the claim is released so the next claimant can retry. Failure to publish/release is logged but non-fatal — the claim TTL (default 30s) is the safety net.

Verified by `scripts/mollifier-challenge/04-idempotency-collision.sh`: 30 cold-gate same-key triggers (no pre-warm) now converge on one runId, one `isCached:false` response, 29 `isCached:true`. Before this fix the same test produced 2 unique runIds and 2 `isCached:false` responses.
