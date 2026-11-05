---
"@trigger.dev/core": patch
---

Fix `eventFilterMatches` returning `false` for nested `$exists: false` filters when the parent key is missing or `null`
