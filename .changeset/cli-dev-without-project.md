---
"trigger.dev": patch
---

Running `trigger.dev dev` (or `update`) before initializing a project no longer crashes with a raw `Cannot find matching package.json` stack trace. The CLI now detects the missing project and points you to `npx trigger.dev@latest init` instead.
