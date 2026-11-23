---
"trigger.dev": patch
---

Preserve the trailing newline in `package.json` when `trigger deploy`/`dev` updates the `@trigger.dev/*` package versions, instead of always writing the file without one.
