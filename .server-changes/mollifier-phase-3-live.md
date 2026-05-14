---
area: webapp
type: feature
---

Activate the trigger mollifier end-to-end (Phase 2). When an org-enabled organization trips the per-env burst threshold, the trigger is diverted into a Redis buffer instead of `engine.trigger()` and a synthesised `TriggerTaskResponse` is returned to the caller immediately. A background drainer replays buffered snapshots through `engine.trigger()` at a controlled rate, materialising the run in Postgres asynchronously.

The customer-facing run-retrieve API gains a read-fallback that synthesises a `QUEUED` run from the buffer when Postgres hasn't received the row yet (presenter/loader wiring deferred to a follow-up). The trigger response carries an optional `notice` field — `{ code: "mollifier.queued", message, docs }` — so SDKs can surface guidance (e.g. recommend `batchTrigger` for large fan-outs) without the trigger appearing to fail. OTEL spans `mollifier.queued` (caller side) and `mollifier.drained` (drainer side, with `dwell_ms` + `attempts`) emit on the run's trace.

C1/C3/F4 bypasses: debounce triggers, OneTimeUseToken triggers, and single `triggerAndWait` calls (parentTaskRunId + resumeParentOnCompletion) skip the gate entirely — `batchTriggerAndWait`, the dominant TRI-8654 burst pattern, still funnels through per item.

Defaults to off. Per-org enablement via the existing `Organization.featureFlags` JSON pattern (`mollifierEnabled` key) — matches `canAccessAi`, compute-beta, and the rest of the codebase's org-scoped flag mechanism. Hard global kill via `MOLLIFIER_ENABLED=0` env var.
