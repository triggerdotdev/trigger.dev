---
"trigger.dev": patch
---

When the build log stream disconnects during a build server deploy, the CLI now explains that the deployment itself is still running and exits immediately with a non-zero code, instead of printing the raw stream error and hanging.
