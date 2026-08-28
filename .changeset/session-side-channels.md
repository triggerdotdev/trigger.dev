---
"@trigger.dev/react-hooks": patch
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Named side channels on a Session: durable, two-way realtime streams that outlive a single run and are shared across runs. Open a channel with `session.channel(name)` to get an `.in`/`.out` pair addressed by name rather than the reserved default pair. Writing a side channel's `.in` does not wake or trigger a run, so a channel can carry out-of-band data (a stream of frames, a control signal) that many clients read while the agent produces it.

```ts
// Producer (inside a task): stream frames on a named channel, wakes nothing
await session.channel("screenshots").out.append(frame);

// A run observes a side channel's .in without suspending
session.channel("screenshots").in.on((data) => { /* ... */ });
```

Define channel record types once and infer them on both sides with `defineSessionChannel`, and read a channel from React with `useSessionStreamChannel`. Channels get a default retention that keeps them bounded, overridable per channel.
