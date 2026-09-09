---
"@trigger.dev/sdk": patch
---

Chat sessions can now be pinned to a deployment, so a conversation keeps talking to the agent version its release shipped with, and follows the pin on its own when your app redeploys. Opt out with `triggerConfig: { externalDeploymentId: null }` or `versionSkew: "hold"`. Also fixes `AgentChat` ignoring `maxDuration`, `region` and `lockToVersion`, and a restored `AgentChat` session never picking up a new deployment id.
