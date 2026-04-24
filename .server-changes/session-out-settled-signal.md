---
area: webapp
type: improvement
---

`/realtime/v1/sessions/:session/out` now peeks the tail record in S2 at connection time. If the last chunk is `trigger:turn-complete` (agent finished a turn and is either idle-waiting on `.in` or has exited), the downstream S2 read uses `wait=0` so the SSE drains and closes immediately instead of holding the connection open for 60s. The response also carries `X-Session-Settled: true` so the client can tell the close is terminal rather than a normal long-poll cycle.

Lets `TriggerChatTransport.reconnectToStream` return quickly on page reloads of settled chats without requiring callers to persist an `isStreaming` flag — the server decides from the stream's own tail. Mid-turn tails still take the 60s long-poll path unchanged.
