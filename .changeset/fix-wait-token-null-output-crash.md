---
"@trigger.dev/sdk": patch
---

Fix crash when a timed-out waitpoint token has no output payload. When `result.output` is null, `data` is `undefined` and accessing `data.message` throws a `TypeError` before the timeout error reaches the caller. Uses optional chaining with a fallback message, matching the pattern already used in `sharedRuntimeManager` for the same case.
