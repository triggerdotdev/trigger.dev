---
name: trigger-convex
description: >
  Integrates Trigger.dev background tasks with Convex using @trigger.dev/convex.
  Use when triggering work transactionally from a Convex mutation, showing reactive
  run state, handling completion callbacks, combining Trigger Realtime with Convex,
  restoring jobs after reload, or repairing paused synchronization. Covers ownership,
  idempotency, scoped browser tokens, and credential-safe task payloads. Not for
  Convex-only applications or Trigger.dev applications without Convex.
license: Apache-2.0
---

# Trigger.dev with Convex

## Check the installed contract first

Locate `@trigger.dev/convex/package.json`, then read the adjacent `README.md` and
`dist/client/index.d.ts`. In a non-hoisted installation, resolve the package with:

```bash
node -p "require.resolve('@trigger.dev/convex/package.json')"
```

Use the installed declarations as authority. Older releases do not expose
`refresh()`. If it is absent, use durable polling or upgrade to a compatible
release; do not invent a replacement method or accept browser-supplied run state.
Keep the application's Convex version compatible with the package's peer dependency.
Do not pin an arbitrary preview URL unless the user explicitly needs that preview.

Choose the relevant flow:

| Request | Approach |
| --- | --- |
| Enqueue a report, render, import, or AI task | Call `trigger.trigger` inside the application's authenticated mutation. |
| Display durable status/results | Authorize the application's job, then call `trigger.getRun` from a query. |
| Update application records on completion | Register a short internal mutation using `vRun`. |
| Display responsive browser progress | Subscribe to Trigger Realtime; request an authorized Convex refresh on terminal events. |
| Restore an edit after reload or leaving the page | Persist the selected application job/request ID and inputs; recover owned work from Convex. |
| Recover paused status synchronization | Repair credentials/callback failures, then call authorized `resume`; do not enqueue another task. |

## Install and configure

Install `@trigger.dev/convex` and `convex`. Deploy the actual task separately with
Trigger.dev; the component does not deploy task code. Keep `TRIGGER_SECRET_KEY`
only in the Convex server environment, for the intended Trigger environment.

```typescript
// convex/convex.config.ts
import { defineApp } from "convex/server";
import triggerComponent from "@trigger.dev/convex/convex.config.js";

const app = defineApp();
app.use(triggerComponent);
export default app;
```

Run `npx convex dev` to generate the application's component references.

```typescript
// convex/trigger.ts
import { Trigger } from "@trigger.dev/convex";
import { components } from "./_generated/api";

export const trigger: Trigger = new Trigger(components.trigger);
```

Constructor options are `secretKey`, `baseUrl`, and `onComplete`. The default API
is `https://api.trigger.dev`; `TRIGGER_API_URL` is not automatically read by the
component. Set `baseUrl` explicitly for a different API host. HTTP is allowed only
for localhost development. Keep server keys out of `VITE_`/`NEXT_PUBLIC_` variables.

## Enqueue atomically and authorize reads

Maintain an application-owned job table. The component has no user/tenant model.
This example assumes an existing deployed `process-text` task that accepts `{ text }`.
Validate business limits and authorize any referenced documents/files before enqueueing.

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  jobs: defineTable({
    owner: v.string(),
    requestId: v.string(),
    text: v.string(),
    componentRunId: v.optional(v.string()),
  }).index("by_owner_request", ["owner", "requestId"])
    .index("by_componentRunId", ["componentRunId"]),
});
```

```typescript
// convex/jobs.ts
import { vRun } from "@trigger.dev/convex";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { trigger } from "./trigger";

export const request = mutation({
  args: { text: v.string(), requestId: v.string() },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Unauthorized");
    const owner = user.tokenIdentifier;
    const existing = await ctx.db.query("jobs")
      .withIndex("by_owner_request", q => q.eq("owner", owner).eq("requestId", args.requestId))
      .unique();
    if (existing) {
      if (existing.text !== args.text) throw new Error("Request ID reused for different input");
      return existing._id;
    }
    const jobId = await ctx.db.insert("jobs", { owner, ...args });
    const componentRunId = await trigger.trigger(ctx, "process-text", { text: args.text }, {
      idempotencyKey: `process-text:${owner}:${args.requestId}`,
    });
    await ctx.db.patch(jobId, { componentRunId });
    return jobId;
  },
});

export const status = query({
  args: { jobId: v.id("jobs") },
  returns: v.union(vRun, v.null()),
  handler: async (ctx, { jobId }) => {
    const user = await ctx.auth.getUserIdentity();
    const job = await ctx.db.get(jobId);
    if (!user || !job || job.owner !== user.tokenIdentifier) return null;
    return job.componentRunId ? trigger.getRun(ctx, job.componentRunId) : null;
  },
});
```

Preserve the same request ID when retrying an unconfirmed submission. Namespace
component idempotency keys by tenant/owner, task, and logical request. They dedupe
across the entire component instance, not just a task, and do not compare payloads.
An application mutation rollback also rolls back the component enqueue/scheduling.
Do not replace this with a direct SDK trigger from an action if atomicity is required.
Use type-only task imports when adding task payload inference; do not bundle task
implementations, Sharp, or provider clients into the Convex mutation runtime.

There are three distinct identifiers:

- Application `jobId`: accept this from the browser and enforce ownership.
- Component `run.id`: returned by `trigger.trigger`; pass it to `getRun`, `refresh`, and `resume`.
- Remote `run.runId`: available after submission; subscribe to this with Trigger Realtime.

For React, use an application query such as `useQuery(api.jobs.status, { jobId })`.
Only persist/display results verified by Convex. `getRun` omits stored credentials
and request payloads, but its output, errors, and metadata can still contain private data.
Do not expose `listRuns` as a global client-visible feed; use indexed owned jobs and
bounded lookups instead.

## Apply completion to application state

When an application record must change on completion, extend its schema with the
task-specific status/result fields, then add an internal mutation with
`args: { run: vRun }` and `returns: v.null()`. Find its job through the
`by_componentRunId` index using `run.id`, validate the task's output, and update it.
Configure the client with `onComplete: internal.jobs.complete`; keep the explicit
`Trigger` type annotation to avoid circular inference through the generated API.

Keep the callback short and transactional. It runs with the component's terminal
update; throwing rolls both back and schedules a retry. Do network I/O in separate
actions, not in the callback mutation. A callback is optional for reactive reads.
Treat omitted output and expiring output URLs explicitly rather than assuming every
completed run has an inline result.

## Combine Realtime progress with authoritative Convex state

Install `@trigger.dev/react-hooks` in a React frontend and `@trigger.dev/sdk` in the
server that mints tokens. These are separate from the component-only polling setup.

Only use the following wrapper if the installed component exposes `refresh()`:

```typescript
// Add to convex/jobs.ts
export const refresh = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const user = await ctx.auth.getUserIdentity();
    const job = await ctx.db.get(jobId);
    if (!user || !job || job.owner !== user.tokenIdentifier) throw new Error("Unauthorized");
    if (job.componentRunId) await trigger.refresh(ctx, job.componentRunId);
    return null;
  },
});
```

1. Authenticate a server-side token request and verify the application job's owner.
   Derive its remote run ID on the server; never grant access to a caller-chosen run.
2. Mint a short-lived `auth.createPublicToken` scoped to `read: { runs: [runId] }`.
   Use an SDK-capable server runtime, such as a Convex Node action, and scoped
   `auth.withAuth` configuration rather than mutating shared global credentials.
   The SDK spells its API host option `baseURL`, unlike the component's `baseUrl`.
   Match the key/host environment, bound expiry to the application's access lifetime,
   and return only the token, remote ID, expiry, and required public connection URL.
3. Subscribe with `useRealtimeRun` or `runs.subscribeToRun` only after the remote ID
   exists. Limit the browser to the selected owned run, renew credentials through
   the authorized endpoint, and clean up on job/session changes. Reject late token
   responses and metadata for a previous selection.
4. On completion, including an already-terminal snapshot after reconnecting, call
   the owned `refresh` mutation. Include failed, canceled, expired, and timed-out
   runs. Do not refresh on every metadata update or retry a failed effect in a loop.
5. Observe the Convex query for persisted status/results. A refresh returns `null`
   after scheduling; it does not wait for completion or return a new run snapshot.
   Keep scheduled polling/watchdog recovery enabled when the browser goes away.

Refresh hints are coalesced per run, with refresh-driven checks at least five seconds
after the previous status check. An in-flight hint queues a follow-up without
invalidating that observation. Pending submissions, paused synchronization, and
completed records are no-ops; refresh neither submits work nor resumes paused work.

**Token safety:** a run-read token also authorizes REST reads of its payload.
Realtime `skipColumns: ["payload", "output"]` reduces streamed data; it does not
restrict REST access. Remove worker keys, upload capabilities, and other credentials
from token-readable payloads, outputs, metadata, and errors before issuing browser
tokens. Do not mint tokens for legacy runs that still contain credentials; deploying
new code or changing column filters does not rewrite old remote payloads. Derive worker authorization server-side or use server-only signing instead.
Authorize private artifact delivery separately; a public run token is not a file
access policy. Keep browser run tokens in memory and never log credentials.

Persist the selected application job ID, draft inputs, and unconfirmed request ID
before sending a request. Restore owned active jobs from Convex after reload;
otherwise restore only explicit selections, not any old result with matching defaults.
Use actual task metadata for phase progress, explain disabled submission states,
and do not publish results solely because Realtime reports completion.

## Troubleshoot without duplicating work

| Symptom | Fix |
| --- | --- |
| Duplicate jobs after a lost response | Reuse the logical request ID and query the owned job before enqueueing again. |
| Wrong run or a null remote ID | Distinguish application/component/remote IDs; wait for confirmed submission before subscribing. |
| Browser refresh resolves but results lag | Observe Convex; refresh is asynchronous, coalesced, and rate-limited. |
| Component/validator types are incompatible | Check for duplicate Convex installations or peer contexts; align component/consumer dependencies rather than hiding mismatches with casts. |
| `refresh` is missing | Check installed declarations; upgrade deliberately or retain polling, not a fabricated API. |
| `syncStatus === "paused"` | Inspect `syncError`, repair credentials/callbacks, then authorize `resume(ctx, componentId)`. |
| Old work disappears after reload | Persist selection/inputs/request ID; recover owned active work instead of resetting to defaults. |
| Token leaks worker access | Remove credentials from all readable run fields; column filtering cannot repair this. |
| Data from another tenant appears | Authorize every query/mutation/token/artifact request; never trust arbitrary IDs or shared tags. |
| Successful remote work never commits | Check callback errors and output validation; retries roll back application completion too. |
| Large or missing results | Use storage references; inspect `outputOmitted`/`outputPresignedUrl` and refresh expired URLs server-side. |
| Run exists in a different environment | Align API host/key; resume does not migrate remote runs between environments. |

Polling normally backs off from about 15 to 60 seconds. Account for Convex executions
and Trigger API requests at scale; use Realtime for responsive UI, not rapid polling.
Payload plus trigger options must fit within 256 KiB, as must each inline output,
error, and metadata value. Component records are retained; paused requests retain
credentials and payloads for recovery, so plan application retention separately.
Remote submission uses a 24-hour idempotency TTL, but automatic submission retries
stop within one hour. After that window, reconcile remotely before creating new work;
do not claim unlimited exactly-once execution or blindly retry expensive tasks.

## Verify the integration

Check mutation rollback, duplicate request IDs, cross-owner denial, callback failures,
and reconnecting to an already-terminal run. Verify that leaving the page does not
prevent durable completion. If tokens are issued, test cross-run denial and inspect
the full REST-readable payload for credentials. Add focused integration coverage;
do not spend on real provider calls or deploy without the user's authorization.
