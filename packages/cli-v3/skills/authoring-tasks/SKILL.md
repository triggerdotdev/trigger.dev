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
---

# Authoring Trigger.dev Tasks

The full, version-pinned reference for authoring tasks ships **inside your installed `@trigger.dev/sdk`**. Read it before writing code — it always matches the SDK version in this project, so it never drifts:

- **Skill:** `node_modules/@trigger.dev/sdk/skills/authoring-tasks/SKILL.md` — the complete guide (setup, `schemaTask`, retries, triggering + the Result shape, idempotency, waits, metadata, scheduled tasks, queues/concurrency, `trigger.config.ts`).
- **Docs:** `node_modules/@trigger.dev/sdk/docs/` — exhaustive detail. Grep for an API, e.g. `grep -rl "schemaTask" node_modules/@trigger.dev/sdk/docs/`.

If those paths don't exist, `@trigger.dev/sdk` isn't installed yet — install it first. In a non-hoisted layout, resolve the package with `node -p "require.resolve('@trigger.dev/sdk/package.json')"` and read `skills/` + `docs/` beside it.

Always import from `@trigger.dev/sdk` — never `@trigger.dev/sdk/v3` (deprecated alias) or `@trigger.dev/core`.

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

Sibling skills: **realtime-and-frontend** (subscribe to runs, trigger from the frontend), **authoring-chat-agent** and **chat-agent-advanced** (AI chat agents).
