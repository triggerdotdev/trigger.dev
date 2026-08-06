---
"@trigger.dev/sdk": patch
"@trigger.dev/react-hooks": patch
---

`debounce` now works when you pass an array of items to `batchTrigger` or `batchTriggerAndWait`, and when you trigger from `useTaskTrigger`. Previously the option was accepted by the types and dropped before the request was sent, so every trigger created its own run instead of collapsing onto the debounce key.

```ts
await myTask.batchTrigger([
  { payload: { id: "a" }, options: { debounce: { key: "same-key", delay: "30s" } } },
  { payload: { id: "b" }, options: { debounce: { key: "same-key", delay: "30s" } } },
]);
```

The streaming (async iterable) forms of the batch calls were already forwarding `debounce` correctly.
