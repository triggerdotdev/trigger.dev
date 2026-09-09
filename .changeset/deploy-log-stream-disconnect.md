---
"trigger.dev": patch
---

When the build log stream cannot be opened or disconnects during a build server deploy, the CLI now explains that the deployment itself is unaffected and exits immediately with a non-zero code, since it can no longer confirm the outcome. Previously a disconnect printed the raw stream error and left the process hanging.
