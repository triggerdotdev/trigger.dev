---
"@trigger.dev/core": patch
---

API requests now run under a request timeout (default 30s), so a half-open keep-alive connection can no longer hang a call until the runtime's socket default (minutes). On timeout the request aborts and retries on a fresh connection, and the retry is duplicate-safe via the request idempotency key. This mostly affects long-lived processes that reuse connections, including tasks that trigger other tasks.

Set the timeout per request, per client, or globally (most specific wins, `0` disables):

```ts
tasks.trigger("my-task", payload, undefined, { timeoutInMs: 10_000 }); // per request
new TriggerClient({ accessToken, requestOptions: { timeoutInMs: 10_000 } }); // per client
// or globally: TRIGGER_API_REQUEST_TIMEOUT_MS=10000
```
