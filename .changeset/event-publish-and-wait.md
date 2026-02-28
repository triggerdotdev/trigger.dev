---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
"apps-webapp": patch
---

Add publishAndWait support to the event system. Events can now be published
with parentRunId to create waitpoints for each subscriber run, enabling
fan-out / fan-in patterns. The SDK exposes `event.publishAndWait()` which
publishes, blocks the parent run, and returns aggregated results from all
subscriber completions.
