---
name: authoring-tasks
description: >
  Covers writing backend Trigger.dev tasks with @trigger.dev/sdk: defining task() and
  schemaTask(), the run function and its ctx, retries, waits, queues and concurrency,
  idempotency keys, run metadata, logging, triggering other tasks (and the Result shape),
  scheduled/cron tasks, and the essentials of trigger.config.ts. Load this whenever you are
  authoring or editing code inside a /trigger directory, defining a task, or writing backend
  code that triggers tasks. Realtime/React hooks and AI chat are covered by separate skills.
type: core
library: trigger.dev
sources:
  - docs/tasks/overview.mdx
  - docs/tasks/schemaTask.mdx
  - docs/tasks/scheduled.mdx
  - docs/triggering.mdx
  - docs/queue-concurrency.mdx
  - docs/idempotency.mdx
  - docs/runs/metadata.mdx
  - docs/logging.mdx
  - docs/errors-retrying.mdx
  - docs/wait.mdx
  - docs/wait-for.mdx
  - docs/wait-until.mdx
  - docs/wait-for-token.mdx
  - docs/context.mdx
  - docs/config/config-file.mdx
---

# Authoring Trigger.dev Tasks

Tasks are functions that can run for a long time with strong resilience to failure. Define them in files under your `/trigger` directory. Always import from `@trigger.dev/sdk`. Never import from `@trigger.dev/sdk/v3` (deprecated alias) or `@trigger.dev/core`.

## Setup

```ts
// /trigger/hello-world.ts
import { task } from "@trigger.dev/sdk";

export const helloWorld = task({
  id: "hello-world", // unique within the project
  run: async (payload: { message: string }, { ctx }) => {
    console.log(payload.message, "attempt", ctx.attempt.number);
    return { ok: true }; // must be JSON serializable
  },
});
```

The `run` function receives the payload and a second argument with `ctx` (run context), an abort `signal`, and a deprecated `init` output. The return value is the task output and must be JSON serializable.

## Core patterns

### 1. Validate the payload with `schemaTask`

`schema` accepts a Zod / Yup / Superstruct / ArkType / valibot / typebox parser or a custom `(data: unknown) => T` function. A validation failure throws `TaskPayloadParsedError` and skips retrying.

```ts
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const createUser = schemaTask({
  id: "create-user",
  schema: z.object({ name: z.string(), age: z.number() }),
  run: async (payload) => ({ greeting: `Hi ${payload.name}` }),
});
```

### 2. Configure retries and abort early

The default `maxAttempts` is 3. Throw `AbortTaskRunError` to stop retrying immediately. Task-level `retry` overrides the config-file defaults.

```ts
import { task, AbortTaskRunError } from "@trigger.dev/sdk";

export const charge = task({
  id: "charge",
  retry: { maxAttempts: 5, factor: 1.8, minTimeoutInMs: 500, maxTimeoutInMs: 30_000, randomize: true },
  run: async (payload: { amount: number }) => {
    if (payload.amount <= 0) throw new AbortTaskRunError("Invalid amount"); // no retry
    // work that may throw and retry
  },
});
```

For finer control, `catchError: async ({ payload, error, ctx, retryAt }) => {...}` can return `{ skipRetrying: true }`, `{ retryAt: Date }`, or `undefined` (use normal logic). `retry.onThrow`, `retry.fetch`, also exist for in-task retrying.

### 3. Trigger another task and handle the Result

From inside a task use `yourTask.triggerAndWait(payload)`. The result is a Result object that you must check (`ok`), or `.unwrap()` to throw on failure.

```ts
export const parentTask = task({
  id: "parent-task",
  run: async () => {
    const result = await childTask.triggerAndWait({ data: "x" });
    if (result.ok) return result.output; // typed child output
    console.error("child failed", result.error);
    // or: const output = await childTask.triggerAndWait({ data: "x" }).unwrap();
  },
});
```

`SubtaskUnwrapError` carries `runId`, `taskId`, and `cause`. For fan-out use `childTask.batchTriggerAndWait([{ payload: a }, { payload: b }])`; the result has a `.runs` array, each entry `{ ok, id, output?, error?, taskIdentifier }`.

### 4. Trigger from backend code with a type-only import

Outside a task, import the task type only and trigger by id. Do not import the task instance into backend bundles.

```ts
import { tasks } from "@trigger.dev/sdk";
import type { emailSequence } from "~/trigger/emails";

const handle = await tasks.trigger<typeof emailSequence>(
  "email-sequence",
  { to: "a@b.com", name: "Ada" },
  { delay: "1h" }
);
```

`tasks.batchTrigger` and `batch.trigger([{ id, payload }])` cover batches. Trigger options include `delay`, `ttl`, `idempotencyKey`, `idempotencyKeyTTL`, `debounce`, `queue`, `concurrencyKey`, `maxAttempts`, `tags`, `metadata`, `priority`, `region`, and `machine`. Inspect runs with `runs.retrieve`, `runs.cancel`, and `runs.reschedule`.

### 5. Idempotency keys

`idempotencyKeys.create(key, { scope })` returns a 64-char hashed key. A raw string key defaults to `"run"` scope (v4.3.1+); for once-ever behavior use `scope: "global"`.

```ts
import { idempotencyKeys, task } from "@trigger.dev/sdk";

export const processOrder = task({
  id: "process-order",
  run: async (payload: { orderId: string; email: string }) => {
    const key = await idempotencyKeys.create(`confirm-${payload.orderId}`);
    await sendEmail.trigger({ to: payload.email }, { idempotencyKey: key });
  },
});
```

### 6. Waits and run metadata

`wait.for({ seconds })` and `wait.until({ date })` durably pause the run. `metadata.*` is readable and writable only inside `run()`; updates are synchronous and chainable (`set`, `del`, `replace`, `append`, `remove`, `increment`, `decrement`).

```ts
import { task, metadata, wait } from "@trigger.dev/sdk";

export const importer = task({
  id: "importer",
  run: async (payload: { rows: unknown[] }) => {
    metadata.set("status", "processing").set("total", payload.rows.length);
    await wait.for({ seconds: 5 });
    metadata.set("status", "complete");
  },
});
```

For human-in-the-loop, `wait.createToken({ timeout, tags })` returns `{ id, url, publicAccessToken, ... }`; resume with `wait.forToken<T>(token: string | { id: string })` which returns `{ ok, output?, error? }` (or `.unwrap()`), and complete it elsewhere with `wait.completeToken(tokenId, output)`. Metadata max is 256KB and is not propagated to child tasks; push values to a parent with `metadata.parent.*` / `metadata.root.*`. (`metadata.stream` is deprecated since 4.1.0 in favor of `streams.pipe()`.)

### 7. Scheduled (cron) tasks

```ts
import { schedules } from "@trigger.dev/sdk";

export const dailyReport = schedules.task({
  id: "daily-report",
  cron: { pattern: "0 5 * * *", timezone: "Asia/Tokyo" },
  run: async (payload) => {
    console.log("scheduled at", payload.timestamp, "next", payload.upcoming);
  },
});
```

The payload includes `timestamp`, `lastTimestamp`, `timezone`, `scheduleId`, `externalId`, and `upcoming`. Attach schedules dynamically with `schedules.create({ task, cron, timezone?, externalId?, deduplicationKey })` (the dedup key is required and per-project), plus `retrieve / list / update / activate / deactivate / del / timezones`.

### 8. Queues and concurrency

Set `queue: { concurrencyLimit }` on a task, or share a queue across tasks:

```ts
import { queue, task } from "@trigger.dev/sdk";

export const emails = queue({ name: "emails", concurrencyLimit: 5 });

export const sendEmail = task({ id: "send-email", queue: emails, run: async () => {} });
```

At trigger time override with `{ queue: "queue-name" }` and add `concurrencyKey` for per-tenant queues. Manage queues with `queues.list / retrieve / pause / resume / overrideConcurrencyLimit / resetConcurrencyLimit`.

### 9. `trigger.config.ts` essentials

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "<project ref>",
  dirs: ["./trigger"],
  machine: "small-1x",
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, randomize: true },
  },
});
```

`build.external` controls which packages stay out of the bundle. Build extensions (`additionalFiles`, `prismaExtension`, `puppeteer`, `ffmpeg`, `aptGet`, etc.) come from `@trigger.dev/build`. `telemetry` configures instrumentations and exporters.

### Logging

`logger.debug / log / info / warn / error(message, dataRecord?)` write structured logs; `logger.trace(name, async (span) => {...})` adds a span. Module-level metrics use `otel.metrics.getMeter(name)`.

## Common mistakes

1. **CRITICAL: Treating the wait result as the output.** `triggerAndWait` and `wait.forToken` return a Result object, not the raw output.
   - Wrong: `const out = await childTask.triggerAndWait(p); use(out.foo);`
   - Correct: `const r = await childTask.triggerAndWait(p); if (r.ok) use(r.output.foo);` (or `.unwrap()`).

2. **Wrapping `triggerAndWait` / `batchTriggerAndWait` / `wait` in `Promise.all`.**
   - Wrong: `await Promise.all([childTask.triggerAndWait(a), childTask.triggerAndWait(b)]);`
   - Correct: `await childTask.batchTriggerAndWait([{ payload: a }, { payload: b }]);` (or a sequential for-loop).

3. **Importing the task instance into backend code.**
   - Wrong: `import { emailSequence } from "~/trigger/emails";` in a route handler.
   - Correct: `import type { emailSequence }` plus `tasks.trigger<typeof emailSequence>("email-sequence", payload)`.

4. **Calling `metadata.set/get` outside `run()`.**
   - Wrong: setting metadata at module scope or in unrelated backend code (a no-op; `get` returns `undefined`).
   - Correct: call inside `run()` or a task lifecycle hook.

5. **Assuming child tasks inherit the parent's queue or metadata.**
   - Wrong: expecting a subtask to share the parent's `concurrencyLimit` or see its metadata.
   - Correct: subtasks run on their own queue; pass metadata explicitly via `{ metadata: metadata.current() }`, or push up with `metadata.parent.*`.

6. **Bundling native/WASM packages.**
   - Wrong: leaving `sharp`, `re2`, `sqlite3`, or WASM packages in the default bundle.
   - Correct: add them to `build.external` in `trigger.config.ts`.

7. **Relying on a raw string idempotency key being global.**
   - Wrong: `trigger(p, { idempotencyKey: "welcome-email" })` expecting once-ever (true only in v4.3.0 and earlier).
   - Correct: `await idempotencyKeys.create("welcome-email", { scope: "global" })`.

## References

Sibling skills:

- **realtime-and-frontend** for subscribing to runs and triggering from the frontend with React hooks.
- **authoring-chat-agent** and **chat-agent-advanced** for building AI chat agents.

Docs:

- [Tasks overview](https://trigger.dev/docs/tasks/overview)
- [Triggering](https://trigger.dev/docs/triggering)
- [Configuration file](https://trigger.dev/docs/config/config-file)

## Version

This skill is bundled inside `@trigger.dev/sdk` and read directly from `node_modules`, so it always matches your installed SDK version (see the adjacent `package.json`). The full documentation for these APIs ships alongside it under `@trigger.dev/sdk/docs/`.
