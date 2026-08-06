---
"@trigger.dev/core": patch
---

Debounce windows can now run up to 24 hours by default, and a `debounce.delay` that leaves no room to extend the run is rejected instead of silently doing nothing.

A debounced run is only pushed later while its new execution time stays inside `maxDelay` (or the server maximum) measured from the first trigger, so the room you have to push is `maxDelay` minus `delay`. Setting a `delay` at or above that ceiling previously meant every trigger created its own run, with no error and nothing on the run to show the debounce had been ignored. Those triggers now fail with a message naming both values and how to fix them.

```ts
await myTask.trigger(payload, {
  debounce: {
    key: "conversation-123",
    delay: "12h",
    maxDelay: "36h",
  },
});
```
