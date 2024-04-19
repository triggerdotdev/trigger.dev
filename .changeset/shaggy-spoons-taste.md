---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Updates the `trigger`, `batchTrigger` and their `*AndWait` variants to use the first parameter for the payload/items, and the second parameter for options.

Before:

```ts
await yourTask.trigger({ payload: { foo: "bar" }, options: { idempotencyKey: "key_1234" } });
await yourTask.triggerAndWait({ payload: { foo: "bar" }, options: { idempotencyKey: "key_1234" } });

await yourTask.batchTrigger({ items: [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }] });
await yourTask.batchTriggerAndWait({ items: [{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }] });
```

After:

```ts
await yourTask.trigger({ foo: "bar" }, { idempotencyKey: "key_1234" });
await yourTask.triggerAndWait({ foo: "bar" }, { idempotencyKey: "key_1234" });

await yourTask.batchTrigger([{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }]);
await yourTask.batchTriggerAndWait([{ payload: { foo: "bar" } }, { payload: { foo: "baz" } }]);
```

We've also changed the API of the `triggerAndWait` result. Before, if the subtask that was triggered finished with an error, we would automatically "rethrow" the error in the parent task.

Now instead we're returning a `TaskRunResult` object that allows you to discriminate between successful and failed runs in the subtask:

Before:

```ts
try {
  const result = await yourTask.triggerAndWait({ foo: "bar" });

  // result is the output of your task
  console.log("result", result);

} catch (error) {
  // handle subtask errors here
}
```

After:

```ts
const result = await yourTask.triggerAndWait({ foo: "bar" });

if (result.ok) {
  console.log(`Run ${result.id} succeeded with output`, result.output);
} else {
  console.log(`Run ${result.id} failed with error`, result.error);
}
```
