---
area: webapp
type: feature
---

Wire the real A-side trip evaluator into the mollifier gate. With `MOLLIFIER_SHADOW_MODE=1`, each trigger evaluates the per-env sliding-window rate counter; bursts above threshold are logged as `mollifier.would_mollify` (no buffer write — phase 3 activates that). Emits the `mollifier.decisions` OTel counter. Behaviour with `MOLLIFIER_ENABLED=0` (default) is unchanged.
