---
"trigger.dev": patch
---

Running a CLI command like `dev`, `deploy`, `preview`, or `update` before initializing a project no longer crashes with a raw `Cannot find matching package.json` stack trace. The CLI now detects the missing project and points you to `npx trigger.dev@latest init` instead.
