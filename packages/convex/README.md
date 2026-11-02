# @trigger.dev/convex

Run Trigger.dev tasks from Convex mutations and read their status and results through Convex reactive queries.

Use Convex for application state and Trigger.dev for work that needs longer execution, more memory, ffmpeg, Playwright, Python, or other system dependencies. Tasks are still written and deployed normally with Trigger.dev.

**Experimental MVP.** No HTTP routes, webhooks, Trigger lifecycle hooks, or changes to your Trigger server are required.

## Example

[Try the live demo](https://ardent-rabbit-965.convex.site).

The [image-editing example](https://github.com/triggerdotdev/trigger.dev/tree/main/packages/convex/example) demonstrates private image processing, Realtime progress, and Convex synchronization. It uses Trigger.dev `4.8.3` from npmjs and runs as a standalone pnpm workspace. The example is not included in npm packages or component builds.

## Install

```sh
npm install @trigger.dev/convex convex
npx convex env set TRIGGER_SECRET_KEY tr_dev_...
```

Choose the Trigger environment's secret key. Never expose it to browser code.

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import trigger from "@trigger.dev/convex/convex.config.js";

const app = defineApp();
app.use(trigger);
export default app;
```

Run `npx convex dev` to generate your application's component references.

```ts
// convex/trigger.ts
import { Trigger } from "@trigger.dev/convex";
import { components, internal } from "./_generated/api";

export const trigger: Trigger = new Trigger(components.trigger, {
  onComplete: internal.jobs.onComplete, // Optional internal mutation
});
```

The explicit `Trigger` annotation avoids circular type inference through Convex's generated API when configuring a completion callback.

## Example: request work and read the result

The example assumes a Trigger task named `render-video` exists. Type-only task imports do not bundle task code into Convex.

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  jobs: defineTable({
    owner: v.string(),
    runId: v.optional(v.string()),
    status: v.string(),
    output: v.optional(v.any()),
  }).index("by_runId", ["runId"]),
});
```

```ts
// convex/jobs.ts
import { vRun } from "@trigger.dev/convex";
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { trigger } from "./trigger";
import type { renderVideo } from "../trigger/renderVideo";

export const request = mutation({
  args: { videoUrl: v.string() },
  handler: async (ctx, { videoUrl }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Unauthorized");

    const jobId = await ctx.db.insert("jobs", {
      owner: user.subject,
      status: "PENDING",
    });
    const runId = await trigger.trigger<typeof renderVideo>(
      ctx,
      "render-video",
      { videoUrl },
      { tags: [`job:${jobId}`] },
    );
    await ctx.db.patch(jobId, { runId });
    return jobId;
  },
});

export const status = query({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const user = await ctx.auth.getUserIdentity();
    const job = await ctx.db.get(jobId);
    if (!user || !job || job.owner !== user.subject) return null;
    return job.runId ? trigger.getRun(ctx, job.runId) : null;
  },
});

export const onComplete = internalMutation({
  args: { run: vRun },
  handler: async (ctx, { run }) => {
    const job = await ctx.db.query("jobs")
      .withIndex("by_runId", q => q.eq("runId", run.id))
      .unique();
    if (job) await ctx.db.patch(job._id, {
      status: run.status,
      output: run.output,
    });
  },
});
```

```tsx
// React
const run = useQuery(api.jobs.status, { jobId });
// run.status, run.output, run.error, run.metadata, run.syncStatus
```

The ID returned by `trigger.trigger` identifies the **component record**, not the Trigger.dev run. The latter becomes available as `run.runId` after submission.

## Agent skill

The package ships a versioned [`trigger-convex` skill](https://github.com/triggerdotdev/trigger.dev/blob/main/packages/convex/skills/trigger-convex/SKILL.md) covering transactional triggering, owned reactive queries, callbacks, Realtime + refresh, reload recovery, and token safety.

Ask your coding assistant to read `node_modules/@trigger.dev/convex/skills/trigger-convex/SKILL.md`, or copy it into your assistant's native skill directory. For example, from a project with this package installed:

```sh
mkdir -p .agents/skills/trigger-convex
cp node_modules/@trigger.dev/convex/skills/trigger-convex/SKILL.md .agents/skills/trigger-convex/SKILL.md
```

Use `.claude/skills/`, `.cursor/skills/`, or `.github/skills/` instead if appropriate for your assistant. Re-copy after upgrading `@trigger.dev/convex`; copied files do not update automatically. For non-hoisted installs, locate the package with `node -p "require.resolve('@trigger.dev/convex/package.json')"`.

This skill is installed manually, not through `npx trigger.dev@latest skills`. Older package versions may not contain it.

## API

- `trigger(ctx, taskId, payload, options?)`: enqueue work. Calling from a mutation makes the request atomic with your application's writes.
- `getRun(ctx, id)`: read one record reactively.
- `listRuns(ctx, paginationOpts)`: paginate records, newest first, up to 100 per page and a bounded read budget.
- `refresh(ctx, id)`: schedule an earlier status check for an active, submitted run. Returns `null` after scheduling, not the updated run.
- `resume(ctx, id)`: resume paused synchronization using the current credentials.

Trigger options include tags, delay, queue name, concurrency key, machine, metadata, max attempts, max duration, TTL, and a component-level idempotency key.

An optional `idempotencyKey` deduplicates requests across this component instance, regardless of task. Reusing a key returns the original record, even if its payload or task differs. Keys remain reserved while records exist.

The constructor accepts `secretKey` (defaults to `TRIGGER_SECRET_KEY`), `baseUrl` (defaults to `https://api.trigger.dev`), and `onComplete`. HTTP base URLs are permitted only for localhost development.

**Authorization belongs in your application's functions.** The component has no tenant or user model. Do not expose arbitrary record IDs or `listRuns` to clients without enforcing ownership. Queries never return stored credentials or request payloads.

## Realtime progress and faster result delivery

Use [Trigger Realtime](https://trigger.dev/docs/realtime/overview) for responsive browser progress, and Convex queries for durable application state. When Realtime reports that a run is complete, call an ownership-checked application mutation that requests a component refresh:

```ts
// convex/jobs.ts
export const refresh = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const user = await ctx.auth.getUserIdentity();
    const job = await ctx.db.get(jobId);
    if (!user || !job || job.owner !== user.subject) throw new Error("Unauthorized");
    if (job.runId) await trigger.refresh(ctx, job.runId);
  },
});
```

Pass the component record ID to `refresh`, not the remote Trigger run ID. Your browser subscribes to the latter, available as `run.runId` from `getRun`.

A refresh is only a hint: the component retrieves status and output directly from Trigger and uses the same validation, completion callback, and credential cleanup as normal polling. It never accepts client-supplied status or output. Observe `getRun` or your application query for the persisted result; awaiting `refresh` does not wait for that result.

- Refresh requests are coalesced per run. Status checks requested this way start at least five seconds after the previous status check.
- A hint received during a check queues one follow-up instead of interrupting or discarding the in-flight response. If that response completes the run, no follow-up is needed.
- Pending submissions, paused synchronization, and completed records are no-ops. Refresh never submits a task or resumes paused work; use `resume` after repairing a paused synchronization.
- Call refresh when Realtime observes completion, including an already-completed run after reconnecting. Do not call it on every metadata update to animate progress.
- Scheduled polling and its watchdog remain enabled. Convex can still finish the run if the browser closes, the subscription disconnects, or the refresh request fails. No persistent subscription inside a Convex action is required.

**Realtime token safety:** authenticate the token request, verify job ownership, and issue a short-lived token scoped to the exact remote run. Keep the root Trigger key server-side. A run-read token can also read the run through REST, including its payload; Realtime `skipColumns` is not a restriction on REST access. Keep worker credentials, storage-upload capabilities, and other secrets out of token-readable payloads, outputs, metadata, and errors. Application mutations must enforce ownership even when component refreshes are coalesced.

## Execution and reliability

1. The calling mutation writes a component record and schedules submission. If the transaction rolls back, neither survives.
2. A short action submits to the existing Trigger API with a stable key derived from the record ID.
3. Scheduled actions retrieve status with backoff from approximately 15 to 60 seconds between checks. Nothing runs in Convex between checks.
4. A terminal state, including cancellation, is persisted. The optional completion mutation runs in the same transaction, then stored request data and credentials are deleted.

A scheduled watchdog is committed before each network action. An interrupted action is retried on the next check; obsolete responses cannot overwrite newer observations.

Remote submission uses a 24-hour idempotency TTL. Automatic submission retries stop within one hour of creating the record, well before that TTL. This is **not an unlimited exactly-once guarantee**.

Permanent API errors pause synchronization immediately. Eight consecutive transient or callback failures also pause it. Check `syncStatus === "paused"` and `syncError`. Fix the cause, then call `resume` from an authorized mutation. If submission has not been confirmed, it can only resume within the original one-hour window. After that, reconcile with the Trigger dashboard before creating new work.

Keep the same Trigger environment when resuming. Changing credentials does not migrate remote runs between environments. Existing requests retain their original credentials until resumed.

Completion callbacks should be short mutations. If a callback throws, completion and its application writes roll back together and are retried. A broken callback can therefore delay the component's completion state; `syncError` reports synchronization trouble. No callback is needed to use reactive results.

## Limits

- Polling costs Convex executions and Trigger API requests. This MVP is for validating the integration, not high-volume fan-out or subsecond progress.
- Payload plus trigger options must fit within 256 KiB. Pass storage references for larger inputs.
- Output, error, and metadata each have a 256 KiB inline budget. Oversized output is omitted with `outputOmitted: true`. Oversized error or metadata is omitted.
- Trigger's `outputPresignedUrl`, when supplied, is preserved rather than downloaded. These URLs expire. Retrieve the run again through the Trigger API when you need a fresh URL.
- Run records are retained. Paused requests retain their payload and credentials for recovery. Automatic retention cleanup is not included.
- No batch API, cancellation command, waitpoint completion, schedules, or streaming yet. Trigger tasks themselves can use those features normally.

## Development

From the repository root:

```sh
pnpm --filter @trigger.dev/convex build
pnpm --filter @trigger.dev/convex test
```

Tests use Convex's in-memory test runtime and real HTTP requests to a local server.
