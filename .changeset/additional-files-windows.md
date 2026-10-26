---
"@trigger.dev/build": patch
---

`additionalFiles` now strips leading `..` segments on Windows too, so a pattern like `../shared/**` copies files inside the build instead of outside it.
