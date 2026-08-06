---
"@trigger.dev/core": patch
---

Debouncing with a `delay` longer than an hour now works. A hidden server-side limit was releasing debounced runs after an hour, so any `delay` at or above that never got to push its run back at all: every trigger created its own run, with no error and nothing on the run to show the debounce key had been ignored.

That limit is gone. A debounce key with no `maxDelay` now keeps pushing its run back for as long as triggers keep arriving, which means it never executes while they do. Set `maxDelay` when the work has to happen eventually, and keep `delay` well below it, since the room available to push is the gap between the two.

Triggers we know cannot debounce are now rejected instead of quietly doing nothing: a `maxDelay` no longer than the `delay`, an unparseable `maxDelay`, and a `delay` given as a date rather than a duration. Self-hosters who configure a maximum debounce duration get the same treatment for a `delay` at or above it.

```ts
await myTask.trigger(payload, {
  debounce: {
    key: "conversation-123",
    delay: "10s",
    maxDelay: "5m",
  },
});
```
