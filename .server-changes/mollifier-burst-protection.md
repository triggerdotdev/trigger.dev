---
area: webapp
type: feature
---

Lay the groundwork for an opt-in burst-protection layer on the trigger hot path. This release ships **monitoring only** — operators can observe per-env trigger storms via two opt-in modes, but no trigger calls are diverted or rate-limited yet (active burst smoothing follows in a later release). All new env vars default off, so existing deployments see no behaviour change. With `MOLLIFIER_SHADOW_MODE=1`, each trigger evaluates a per-env rate counter and logs `mollifier.would_mollify` when the threshold is crossed. With `MOLLIFIER_ENABLED=1` plus a per-org `mollifierEnabled` flag, over-threshold triggers are also recorded in a Redis audit buffer alongside the normal `engine.trigger` call, drained by a background no-op consumer. Emits the `mollifier.decisions` OTel counter for per-env rate visibility.
