---
area: webapp
type: improvement
---

Add `mutateWithFallback` helper in `app/v3/mollifier/mutateWithFallback.server.ts`. Composes PG-first (replica) lookup, `MollifierBuffer.mutateSnapshot`, and writer-side spin-wait into the Q3 wait-and-bounce flow. Returns a discriminated outcome (`pg` / `snapshot` / `not_found` / `timed_out`) without throwing Response objects, keeping the helper route-agnostic and unit-testable. Wait knobs (`safetyNetMs=2000`, `pollStepMs=20`, `pgTimeoutMs=50`) are overridable for tests. Each PG poll is bounded by `pgTimeoutMs` via `Promise.race` so a slow query can't burn the safety net. Phase C mutation endpoints (tags, metadata-put, reschedule, cancel) will consume this helper.
