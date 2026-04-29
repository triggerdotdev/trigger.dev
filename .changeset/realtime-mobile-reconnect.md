---
"@trigger.dev/react-hooks": patch
"@trigger.dev/core": patch
---

Realtime SSE: keep subscriptions alive across mobile background-suspends and flaky networks.

- `SSEStreamSubscription` now retries forever with jittered exponential backoff (250ms → 30s, capped) instead of giving up after 5 attempts. 4xx errors (except 408/429) still terminate immediately.
- `useRealtimeRun`, `useRealtimeRunWithStreams`, `useRealtimeRunsWithTag`, `useRealtimeBatch`, and `useRealtimeStream` now re-establish their subscriptions when the tab becomes visible again or the network comes back online — covering cases where mobile OSes silently kill the underlying socket without firing a close event.
