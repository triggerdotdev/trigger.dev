---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"trigger.dev": patch
---

Thrown error `cause` chains are now captured and shown. When a task throws an error that wraps another one, the run's error in the dashboard, the CLI dev output, and failure alerts all carry the chain instead of only the outermost message.

```ts
throw new Error("Could not sync the customer", { cause: originalError });
```

The chain is flattened outermost first, capped at five causes, and cycle safe. It also rides on the `error` of API and realtime run records as a `causes` array, and `triggerAndWait` and `triggerAndSubscribe` rebuild it as a native `cause` on the error they hand back, so `err.cause` works in your own catch blocks.
