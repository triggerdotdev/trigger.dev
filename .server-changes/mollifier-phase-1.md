---
area: webapp
type: feature
---

Add the trigger mollifier (phase 1 — dual-write monitoring + shadow mode). New env vars (all default off), `evaluateGate` wired into the trigger hot path, lazy singletons for the dedicated mollifier Redis client and drainer. With `MOLLIFIER_SHADOW_MODE=1`, each trigger evaluates the per-env sliding-window rate counter and logs bursts as `mollifier.would_mollify` (no buffer write). With `MOLLIFIER_ENABLED=1` plus a per-org `mollifierEnabled` flag, the buffer is dual-written alongside `engine.trigger` and the no-op drainer pops/acks the entries. Emits the `mollifier.decisions` OTel counter. Behaviour with `MOLLIFIER_ENABLED=0` (default) is unchanged.
