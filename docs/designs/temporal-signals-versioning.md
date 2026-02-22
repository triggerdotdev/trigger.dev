# Design: Temporal Signals & Task Versioning (API/SDK)

## Status: Draft / Proposal

## Problem

When a task definition changes between deploys, in-flight runs can encounter mismatches:

1. **Input streams** - A sender calls `.send()` with data shaped for the new schema, but the running task was deployed with the old schema and has different `.on()` / `.once()` handlers.
2. **Wait tokens** - A token created by version N is completed with data shaped for version N+1 (or vice versa), causing runtime deserialization failures or silent data loss.
3. **Trigger payloads** - A run was triggered against version N's schema, but by the time it executes the worker is running version N+1.

Today there is no mechanism for the platform to detect or prevent these mismatches. This design proposes **version-aware delivery** for input streams and wait tokens so that senders can target or adapt to the version a run is actually executing.

---

## Goals

- Expose the **version of the running task** to any code that sends data to it (input streams, wait token completion).
- Let senders **opt in** to version-aware delivery: either target a specific version or receive the version and branch on it.
- Remain **fully backwards-compatible** — existing code that ignores versioning continues to work unchanged.
- Keep the **SDK surface small** — no new top-level concepts; extend existing `streams.input` and `wait` APIs.

## Non-goals (for this document)

- Database schema changes (separate design).
- Automatic schema migration / coercion at the platform level.
- Breaking changes to any public API.

---

## Design

### 1. Version Metadata on Runs

Every task run already carries metadata about which deployment created it. We surface a **version identifier** (the deployment version string, e.g. `"20240815.1"`) in two places:

| Surface | How |
|---------|-----|
| **Run object returned by `.trigger()` / `.batchTrigger()`** | Add `version: string` to the returned handle |
| **`wait.retrieveToken()` / `wait.listTokens()`** | Add `runVersion?: string` to each token item — the version of the run that is waiting on this token |

This lets external callers discover what version a run is executing before they send it data.

### 2. Input Streams — Version-Aware `.send()`

#### Current API

```ts
const approval = streams.input<ApprovalData>({ id: "approval" });

// sender side
await approval.send(runId, { approved: true, reviewer: "alice" });
```

#### Proposed Addition

```ts
await approval.send(runId, data, {
  // New optional field:
  ifVersion?: string | ((version: string) => boolean);
});
```

**Semantics:**

| `ifVersion` value | Behavior |
|---|---|
| _omitted_ | Send unconditionally (current behavior, fully backwards-compatible) |
| `"20240815.1"` (string) | Send only if the run's task version matches exactly; otherwise reject with `VersionMismatchError` |
| `(v) => v >= "20240815.1"` (predicate) | Send only if predicate returns `true` for the run's version; otherwise reject with `VersionMismatchError` |

This keeps `.send()` simple for callers who don't care about versioning while giving precise control to those who do.

#### Alternative: Version-Returning `.send()`

Instead of (or in addition to) guarding, `.send()` could return metadata:

```ts
const result = await approval.send(runId, data);
// result.runVersion === "20240815.1"
```

This lets the caller inspect the version after the fact. Useful for logging/observability but doesn't prevent mismatched data from being delivered.

**Recommendation:** Support both — the return value always includes `runVersion`, and the optional `ifVersion` guard prevents delivery on mismatch.

### 3. Wait Tokens — Version-Aware `.completeToken()`

#### Current API

```ts
await wait.completeToken(tokenId, { status: "done" });
```

#### Proposed Addition

```ts
await wait.completeToken(tokenId, data, {
  // New optional field:
  ifVersion?: string | ((version: string) => boolean);
});
```

Same semantics as input streams above. The platform checks the version of the run that owns the waitpoint before delivering the completion.

Additionally, `wait.createToken()` response already includes a `url` for webhook-based completion. The webhook endpoint should accept an optional `X-Trigger-If-Version` header with the same guard semantics, returning `409 Conflict` on mismatch.

### 4. Extracting Version — `runs.retrieve()` Enhancement

To support the "check then act" pattern, `runs.retrieve()` should include the version:

```ts
const run = await runs.retrieve(runId);
// run.version === "20240815.1"
// run.taskIdentifier === "my-task"
```

This field already exists internally on the `TaskRun` model via the associated `BackgroundWorkerTask` → `BackgroundWorker` → `version`. We just need to surface it in the API response.

### 5. Version Inside the Running Task

Task code can already access `ctx.run` metadata. We add:

```ts
export const myTask = task({
  id: "my-task",
  run: async (payload, { ctx }) => {
    console.log(ctx.deployment.version); // "20240815.1"
  },
});
```

This lets `.on()` handlers inside a task know their own version (useful for logging or conditional logic):

```ts
approval.on((data) => {
  logger.info("Received approval", {
    taskVersion: ctx.deployment.version,
  });
});
```

### 6. `VersionMismatchError`

A new typed error for version guard failures:

```ts
import { VersionMismatchError } from "@trigger.dev/sdk";

try {
  await approval.send(runId, data, { ifVersion: "20240815.1" });
} catch (err) {
  if (err instanceof VersionMismatchError) {
    console.log(err.expectedVersion);  // "20240815.1"
    console.log(err.actualVersion);    // "20240816.3"
    console.log(err.runId);            // "run_abc123"
    // Decide: retry with adapted payload, skip, alert, etc.
  }
}
```

```ts
class VersionMismatchError extends Error {
  name = "VersionMismatchError";
  constructor(
    public readonly runId: string,
    public readonly expectedVersion: string,
    public readonly actualVersion: string,
  ) {
    super(
      `Version mismatch for run ${runId}: expected ${expectedVersion}, got ${actualVersion}`
    );
  }
}
```

---

## API Surface Summary

### New Fields on Existing Types

| Type | New Field | Description |
|------|-----------|-------------|
| `TriggerResult` (from `.trigger()`) | `version: string` | Deployment version of the triggered run |
| `RetrievedRun` (from `runs.retrieve()`) | `version: string` | Deployment version |
| `WaitpointRetrievedToken` | `runVersion?: string` | Version of the run waiting on this token |
| `TaskRunContext` (`ctx`) | `deployment.version: string` | Version of the current deployment |

### New Options on Existing Methods

| Method | New Option | Type |
|--------|-----------|------|
| `streams.input().send()` | `ifVersion` | `string \| ((version: string) => boolean)` |
| `wait.completeToken()` | `ifVersion` | `string \| ((version: string) => boolean)` |

### New Return Fields on Existing Methods

| Method | New Return Field | Type |
|--------|-----------------|------|
| `streams.input().send()` | `runVersion` | `string` |
| `wait.completeToken()` | `runVersion` | `string` |

### New Types

| Type | Location |
|------|----------|
| `VersionMismatchError` | `@trigger.dev/sdk` |

---

## Usage Examples

### Example 1: Guard Input Stream Delivery

```ts
import { streams, VersionMismatchError } from "@trigger.dev/sdk";

const chatInput = streams.input<{ message: string }>({ id: "chat" });

// Only deliver if the run is on the expected version
try {
  await chatInput.send(runId, { message: "hello" }, {
    ifVersion: deployedVersion,
  });
} catch (err) {
  if (err instanceof VersionMismatchError) {
    // Run is on a different version — handle gracefully
    console.warn(`Skipping: run is on ${err.actualVersion}`);
  }
}
```

### Example 2: Adaptive Token Completion

```ts
import { wait, runs } from "@trigger.dev/sdk";

// Check the run's version, send version-appropriate data
const run = await runs.retrieve(runId);

if (run.version >= "20240815.1") {
  await wait.completeToken(tokenId, { status: "done", metadata: { v2: true } });
} else {
  await wait.completeToken(tokenId, { status: "done" }); // legacy shape
}
```

### Example 3: Version Predicate

```ts
await approval.send(runId, data, {
  ifVersion: (v) => v.startsWith("2024"),
});
```

---

## Migration & Backwards Compatibility

- **All new fields are optional / additive** — no existing call signatures change.
- **`ifVersion` defaults to `undefined`** — omitting it preserves current unconditional behavior.
- **Return type changes are additive** — new fields on response objects don't break existing destructuring.
- **No new required configuration** — versioning is opt-in for senders.

---

## Open Questions

1. **Version format** — Should we use the deployment version string as-is (e.g. `"20240815.1"`), or introduce a monotonically increasing integer version? Strings are human-readable but harder to compare with `>=`. Integers are easy to compare but less meaningful.

2. **Predicate serialization** — The `ifVersion: (v) => boolean` form only works in SDK calls (can't be sent over HTTP). For the webhook/REST path, should we support a simple comparison DSL (e.g. `">=20240815.1"`) or only exact match strings?

3. **Batch operations** — For `batchTrigger()` where runs may land on different versions, should we return per-item version info?

4. **Event-driven alternative** — Instead of (or in addition to) guards, should we emit a `version.mismatch` event/hook that middleware can intercept?
