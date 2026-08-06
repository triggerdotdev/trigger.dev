---
"@trigger.dev/core": patch
---

Fix `debounce` doing nothing when `delay` was longer than an hour. An undocumented server limit released debounced runs after an hour, so a longer delay could never push its run back and every trigger created its own.

Debounce keys now keep collapsing triggers for as long as they keep arriving, so set `maxDelay` when the work has to happen eventually. Settings that could never debounce, such as a `maxDelay` no longer than the `delay`, are now rejected rather than quietly ignored.
