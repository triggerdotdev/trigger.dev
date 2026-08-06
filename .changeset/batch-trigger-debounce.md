---
"@trigger.dev/sdk": patch
---

`debounce` now works when you pass an array of items to `batchTrigger` or `batchTriggerAndWait`. Previously the option was accepted by the types and dropped before the request was sent, so every item created its own run instead of collapsing onto the debounce key.

```ts
await myTask.batchTrigger([
  { payload: { id: "a" }, options: { debounce: { key: "same-key", delay: "30s" } } },
  { payload: { id: "b" }, options: { debounce: { key: "same-key", delay: "30s" } } },
]);
```

The streaming (async iterable) forms of these calls were already forwarding `debounce` correctly.
