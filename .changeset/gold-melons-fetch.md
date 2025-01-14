---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Add support for specifying machine preset at trigger time. Works with any trigger function:

```ts
// Same as usual, will use the machine preset on childTask, defaults to "small-1x"
await childTask.trigger({ message: "Hello, world!" });

// This will override the task's machine preset and any defaults. Works with all trigger functions.
await childTask.trigger({ message: "Hello, world!" }, { machine: "small-2x" });
await childTask.triggerAndWait({ message: "Hello, world!" }, { machine: "small-2x" });

await childTask.batchTrigger([
  { payload: { message: "Hello, world!" }, options: { machine: "micro" } },
  { payload: { message: "Hello, world!" }, options: { machine: "large-1x" } },
]);
await childTask.batchTriggerAndWait([
  { payload: { message: "Hello, world!" }, options: { machine: "micro" } },
  { payload: { message: "Hello, world!" }, options: { machine: "large-1x" } },
]);

await tasks.trigger<typeof childTask>(
  "child",
  { message: "Hello, world!" },
  { machine: "small-2x" }
);
await tasks.batchTrigger<typeof childTask>("child", [
  { payload: { message: "Hello, world!" }, options: { machine: "micro" } },
  { payload: { message: "Hello, world!" }, options: { machine: "large-1x" } },
]);
```
