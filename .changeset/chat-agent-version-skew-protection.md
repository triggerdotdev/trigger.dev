---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Chat sessions can now be pinned to a deployment, so a conversation keeps talking to the agent version its release shipped with across every turn, idle suspend and recovery. The id is resolved wherever you start the session, exactly as it is for `trigger()`, so there is no chat-specific setup — and if your app sends no id, nothing changes. Pass `triggerConfig: { externalDeploymentId: null }` to opt one chat out.
