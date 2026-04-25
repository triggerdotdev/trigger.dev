---
area: webapp
type: improvement
---

`/realtime/v1/sessions/:session/out` accepts an opt-in `X-Peek-Settled: 1` request header. When set, the route peeks the tail record in S2 before proxying; if the last chunk is `trigger:turn-complete`, it switches the downstream read to `wait=0` and returns `X-Session-Settled: true` so the SSE drains-and-closes in ~1s instead of long-polling for 60s.

Without the header, the route behaves exactly as before the settled work — unconditional `wait=60`. This matters because the peek races a newly-triggered turn's first chunk: the active `sendMessages → subscribeToSessionStream` path would otherwise see the previous turn's `trigger:turn-complete` at the tail and close the SSE before the new turn's chunks land on S2. The smoke test confirmed this race was failing every turn-2 response.

`TriggerChatTransport.reconnectToStream` opts in via the header (that's the reload-on-a-settled-chat case where the fast close is a real UX win). Active send paths don't set the header and keep long-poll semantics.
