---
"trigger.dev": patch
---

`trigger.dev init` now stops with a clear error when the target directory has no `package.json`, instead of installing packages into a parent project. A custom task directory entered during interactive `init <path>` is now written to `trigger.config.ts` relative to the project directory.
