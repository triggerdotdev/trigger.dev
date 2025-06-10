---
"@trigger.dev/react-hooks": patch
---

Added the ability to specify a "createdAt" filter when subscribing to tags in our useRealtime hooks:

```tsx
// Only subscribe to runs created in the last 10 hours
useRealtimeRunWithTags("my-tag", { createdAt: "10h" })
```

You can also now choose to skip subscribing to specific columns by specifying the `skipColumns` option:

```tsx
useRealtimeRun(run.id, { skipColumns: ["usageDurationMs"] });
```
