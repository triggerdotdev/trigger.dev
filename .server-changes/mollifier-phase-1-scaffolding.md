---
area: webapp
type: feature
---

Add scaffolding for the trigger mollifier (phase 1). New env vars (all default off), `evaluateGate` (the mollifier gate) wired into the trigger hot path as a no-op, lazy singletons for the dedicated mollifier Redis client and drainer. No behavioural change while `MOLLIFIER_ENABLED=0`.
