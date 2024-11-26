---
"@trigger.dev/react-hooks": minor
"@trigger.dev/sdk": minor
"@trigger.dev/core": minor
---

Improved Batch Triggering:

- The new Batch Trigger endpoint is now asynchronous and supports up to 500 runs per request.
- The new endpoint also supports triggering multiple different tasks in a single batch request (support in the SDK coming soon).
- The existing `batchTrigger` method now supports the new endpoint, and shouldn't require any changes to your code.

- Idempotency keys now expire after 24 hours, and you can customize the expiration time when creating a new key by using the `idempotencyKeyTTL` parameter:

```ts
await myTask.batchTrigger([{ payload: { foo: "bar" }}], { idempotencyKey: "my-key", idempotencyKeyTTL: "60s" })
// Works for individual items as well:
await myTask.batchTrigger([{ payload: { foo: "bar" }, options: { idempotencyKey: "my-key", idempotencyKeyTTL: "60s" }}])
// And `trigger`:
await myTask.trigger({ foo: "bar" }, { idempotencyKey: "my-key", idempotencyKeyTTL: "60s" });
```

### Breaking Changes

- We've removed the `idempotencyKey` option from `triggerAndWait` and `batchTriggerAndWait`, because it can lead to permanently frozen runs in deployed tasks. We're working on upgrading our entire system to support idempotency keys on these methods, and we'll re-add the option once that's complete.
