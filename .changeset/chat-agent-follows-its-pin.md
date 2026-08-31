---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

A pinned chat session now follows its pin on its own: when your app redeploys and re-pins the session, the agent hands the conversation over at the next turn boundary instead of the new pin only applying to the next run. This replaces writing that yourself with `clientData` and `chat.requestUpgrade()`. Set `versionSkew: "hold"` on an agent that should stay put. If a handoff lands on a deployment that hasn't finished building, the transport emits `run-pending-version` with `source: "upgrade"`.
