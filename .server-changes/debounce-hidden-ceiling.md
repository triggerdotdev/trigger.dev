---
area: webapp
type: fix
---

Fix debounce doing nothing when the delay was longer than an hour, which made every trigger
create its own run instead of collapsing onto the debounce key. Debounced runs now keep being
pushed back for as long as triggers keep arriving, so set `maxDelay` when the work has to happen
eventually, and settings that could never debounce are rejected rather than silently ignored.
