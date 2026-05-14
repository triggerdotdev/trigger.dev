---
area: webapp
type: feature
---

Add the trigger mollifier: an opt-in burst-protection layer for the trigger hot path that detects per-env trigger storms and (when enabled) buffers them into Redis so the run engine can drain them at a sustainable rate. All new env vars default off, so existing deployments see no behaviour change. Operators can enable shadow-mode-only observability with `MOLLIFIER_SHADOW_MODE=1` (logs `mollifier.would_mollify` when an env exceeds the configured threshold, no buffer writes). Enabling `MOLLIFIER_ENABLED=1` with a per-org `mollifierEnabled` flag turns on dual-write monitoring: each over-threshold trigger is recorded in a Redis buffer alongside the normal `engine.trigger` call, and a background drainer pops and acks entries. Emits the `mollifier.decisions` OTel counter for per-env rate visibility.
