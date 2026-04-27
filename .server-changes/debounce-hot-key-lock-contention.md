---
area: webapp
type: fix
---

Reduce 5xx feedback loops on hot debounce keys by quantizing `delayUntil`,
adding an unlocked fast-path skip, and gracefully handling redlock
contention in `handleDebounce` so the SDK no longer retries into a herd.
