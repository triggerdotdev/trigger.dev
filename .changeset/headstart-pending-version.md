---
"@trigger.dev/sdk": patch
---

Head Start now tells you when the agent run it handed over to is waiting on a deployment that is still building, instead of the wait being invisible. The transport emits `run-pending-version` with `source: "head-start"`, and `chat.startHeadStart` and the `chat.handover` handle both return `pendingVersion`.
