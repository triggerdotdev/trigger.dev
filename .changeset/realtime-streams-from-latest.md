---
"@trigger.dev/react-hooks": patch
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Subscribe to a realtime stream from its latest record instead of replaying the whole history. Pass `from: "latest"` to `useRealtimeStream`, `streams.read()`, or `fetchStream` to start at the current tail (the latest record, then live updates) instead of replaying (a live "last value" view), and `maxParts` to keep the accumulated `parts` array bounded. A reconnect or remount resumes from the last record it saw, so no records are missed and none are replayed. `from: "latest"` needs a server that supports it; older servers safely fall back to a full replay.

`useRealtimeStream` also gains a `lastEventId` option and returns the `lastEventId` of the last part seen, so you can persist the cursor (for example across a page reload) and resume exactly where you left off. An `onParts` callback delivers each throttled batch of parts with their event ids.

```tsx
const { parts, lastEventId } = useRealtimeStream<Frame>(runId, "frames", {
  from: "latest", // skip history, start at the current tail
  maxParts: 1, // keep only the most recent frame
  lastEventId: savedCursor, // resume from a persisted cursor
  onParts: (batch) => save(batch.at(-1)?.id), // track the cursor
  accessToken,
});
```
