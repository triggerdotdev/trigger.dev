---
"@trigger.dev/react-hooks": patch
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Named side channels on a Session: durable, two-way realtime streams that outlive a single run and are shared across runs. Open a channel with `sessions.open(id).channel(name)` (or `chat.channel(name)` inside a `chat.agent`) to get an `.in`/`.out` pair addressed by name rather than the reserved default pair. Writing a side channel's `.in` does not wake or trigger a run, so a channel can carry out-of-band data (a stream of frames, a control signal) that many clients read while the agent produces it.

```ts
// Inside a chat.agent: stream frames on a named channel, wakes nothing
const frames = chat.channel("screenshots");
await frames.out.append(frame);
frames.in.on((control) => { /* client control, no suspend */ });
```

Declare channel record types once with `sessions.defineChannel(...)` and infer them on both the producer and the consumer, including `useSessionStreamChannel` in React. Channels get a default retention that keeps them bounded, overridable per channel.
