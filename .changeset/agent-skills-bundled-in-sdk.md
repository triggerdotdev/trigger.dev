---
"@trigger.dev/sdk": patch
"trigger.dev": patch
---

`@trigger.dev/sdk` now bundles the Trigger.dev agent skills and a curated snapshot of the docs those skills reference. The skills that `trigger skills` installs into your coding agent read this content from node_modules, so the guidance your AI assistant follows is pinned to the SDK version installed in your project and stays current across upgrades instead of going stale until the next reinstall.
