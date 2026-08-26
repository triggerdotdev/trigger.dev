---
"@trigger.dev/sdk": patch
---

Head Start now tells you when the agent run it handed over to is waiting on a deployment that is still building. Step 1 always streams from your warm process, so the wait only affects step 2, and it used to be invisible: the transport now emits `run-pending-version` with `source: "head-start"`, `chat.startHeadStart` returns `pendingVersion`, and the `chat.handover` session handle exposes it too.

```tsx
onEvent: (event) => {
  if (event.type === "run-pending-version") setDeploying(true);
  if (event.type === "first-chunk") setDeploying(false);
},
```
