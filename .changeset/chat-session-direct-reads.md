---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Chat session response streams (`.out`) can now be read directly from the realtime stream store instead of relaying every chunk through Trigger.dev's servers, removing a network hop from the streamed response. `useTriggerChatTransport` and `AgentChat` use the direct path automatically for the active streaming turn. The SDK obtains the read grant on its own (from the session-start response, or from a lightweight grant endpoint if your `startSession` doesn't forward it), refreshes it on turn-complete as it nears expiry, and transparently falls back to the relayed path whenever a grant can't be obtained or used (reconnects, hydrated sessions after a reload, or watch mode). Failing to obtain a grant never breaks the chat. No code changes are required to benefit.

The direct read turns on by default only when you haven't customized `.out` routing. If you set a custom `baseURL`/`streamBaseURL` (e.g. fronting chat traffic with your own edge proxy), it stays off and `.out` follows your routing, so updating changes nothing for those setups. Use `directStreamReads: true`/`false` to override.
