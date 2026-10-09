---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Feat(webapp): animated resizable panel

Adds animated open/close transitions to Resizable panels using react-window-splitter built-in animation hooks. Includes new exports: RESIZABLE_PANEL_ANIMATION, collapsibleHandleClassName(), and useFrozenValue(). Converts inspector/detail side panels from conditionally-mounted to always-mounted collapsible panels across multiple routes (batches, runs, schedules, deployments, logs, waitpoints, bulk-actions).
