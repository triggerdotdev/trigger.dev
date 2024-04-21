---
"trigger.dev": patch
"@trigger.dev/core": patch
---

- Fix additionalFiles that aren't decendants
- Stop swallowing uncaught exceptions in prod
- Improve warnings and errors, fail early on critical warnings
- New arg to --save-logs even for successful builds
