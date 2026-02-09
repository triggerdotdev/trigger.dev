---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Add `maxDelay` option to debounce feature. This allows setting a maximum time limit for how long a debounced run can be delayed, ensuring execution happens within a specified window even with continuous triggers.

```typescript
await myTask.trigger(payload, {
  debounce: {
    key: "my-key",
    delay: "5s",
    maxDelay: "30m", // Execute within 30 minutes regardless of continuous triggers
  },
});
```
