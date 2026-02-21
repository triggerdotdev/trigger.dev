# Graceful handling of oversized batch items

## Prerequisites

This plan builds on top of PR #2980 which provides:
- `TriggerFailedTaskService` at `apps/webapp/app/runEngine/services/triggerFailedTask.server.ts` - creates pre-failed TaskRuns with proper trace events, waitpoint connections, and parent run associations
- `engine.createFailedTaskRun()` on RunEngine - creates a SYSTEM_FAILURE run with associated waitpoints
- Retry support in `processItemCallback` with `attempt` and `isFinalAttempt` params
- The callback already uses `TriggerFailedTaskService` for items that fail after retries

## Problem

When the NDJSON parser in `createNdjsonParserStream` detects an oversized line, it throws inside the TransformStream's `transform()` method. This aborts the request body stream (due to `pipeThrough` coupling), causing the client's `fetch()` to see `TypeError: fetch failed` instead of the server's 400 response. The SDK treats this as a connection error and retries with exponential backoff (~25s wasted).

## Goal

Instead of throwing, treat oversized items as per-item failures that flow through the existing batch failure pipeline. The batch seals normally, other items process fine, and the user sees a clear failure for the specific oversized item(s).

## Approach

The NDJSON parser emits an error marker object instead of throwing. `StreamBatchItemsService` detects these markers and enqueues the item to the FairQueue with error metadata in its options. The `processItemCallback` (already enhanced with `TriggerFailedTaskService` in PR #2980) detects the error metadata and creates a pre-failed run via `TriggerFailedTaskService`, which handles all the waitpoint/trace machinery.

## Changes

### 1. Byte-level key extractor for oversized lines

**`apps/webapp/app/runEngine/services/streamBatchItems.server.ts`** - new function

Add `extractIndexAndTask(bytes: Uint8Array): { index: number; task: string }` - a state machine that extracts top-level `"index"` and `"task"` values from raw bytes without decoding the full line.

How it works:
- Scan bytes tracking JSON nesting depth (count `{`/`[` vs `}`/`]`)
- At depth 1 (inside the top-level object), look for byte sequences matching `"index"` and `"task"` key patterns
- For `"index"`: after the `:`, parse the digit sequence as a number
- For `"task"`: after the `:`, find opening `"`, read bytes until closing `"`, decode just that slice
- Stop when both found, or after scanning 512 bytes (whichever comes first)
- Fallback: `index = -1`, `task = "unknown"` if not found

This avoids decoding/allocating the full 3MB line - only the first few hundred bytes are examined.

### 2. Modify `createNdjsonParserStream` to emit error markers

**`apps/webapp/app/runEngine/services/streamBatchItems.server.ts`**

Define a marker type:
```typescript
type OversizedItemMarker = {
  __batchItemError: "OVERSIZED";
  index: number;
  task: string;
  actualSize: number;
  maxSize: number;
};
```

**Case 1 - Complete line exceeds limit** (newline found, `newlineIndex > maxItemBytes`):
- Call `extractLine(newlineIndex)` to consume the line from the buffer
- Call `extractIndexAndTask(lineBytes)` on the extracted bytes
- `controller.enqueue(marker)` instead of throwing
- Increment `lineNumber` and continue

**Case 2 - Incomplete line exceeds limit** (no newline, `totalBytes > maxItemBytes`):
- Call `extractIndexAndTask(concatenateChunks())` on current buffer
- `controller.enqueue(marker)`
- Clear the buffer (`chunks = []; totalBytes = 0`)
- Return from transform (don't throw)

**Case 3 - Flush with oversized remaining** (`totalBytes > maxItemBytes` in flush):
- Same as case 2 but in `flush()`.

### 3. Handle markers in `StreamBatchItemsService`

**`apps/webapp/app/runEngine/services/streamBatchItems.server.ts`** - in the `for await` loop

Before the existing `BatchItemNDJSONSchema.safeParse(rawItem)`, check for the marker:

```typescript
if (rawItem && typeof rawItem === "object" && (rawItem as any).__batchItemError === "OVERSIZED") {
  const marker = rawItem as OversizedItemMarker;
  const itemIndex = marker.index >= 0 ? marker.index : lastIndex + 1;

  const errorMessage = `Batch item payload is too large (${(marker.actualSize / 1024).toFixed(1)} KB). Maximum allowed size is ${(marker.maxSize / 1024).toFixed(1)} KB. Reduce the payload size or offload large data to external storage.`;

  // Enqueue the item normally but with error metadata in options.
  // The processItemCallback will detect __error and use TriggerFailedTaskService
  // to create a pre-failed run with proper waitpoint connections.
  const batchItem: BatchItem = {
    task: marker.task,
    payload: "{}",
    payloadType: "application/json",
    options: {
      __error: errorMessage,
      __errorCode: "PAYLOAD_TOO_LARGE",
    },
  };

  const result = await this._engine.enqueueBatchItem(
    batchId, environment.id, itemIndex, batchItem
  );

  if (result.enqueued) {
    itemsAccepted++;
  } else {
    itemsDeduplicated++;
  }
  lastIndex = itemIndex;
  continue;
}
```

### 4. Handle `__error` items in `processItemCallback`

**`apps/webapp/app/v3/runEngineHandlers.server.ts`** - in the `setupBatchQueueCallbacks` function

In the `processItemCallback`, before the `TriggerTaskService.call()`, check for `__error` in `item.options`:

```typescript
const itemError = item.options?.__error as string | undefined;
if (itemError) {
  const errorCode = (item.options?.__errorCode as string) ?? "ITEM_ERROR";

  // Use TriggerFailedTaskService to create a pre-failed run.
  // This creates a proper TaskRun with waitpoint connections so the
  // parent's batchTriggerAndWait resolves correctly for this item.
  const failedRunId = await triggerFailedTaskService.call({
    taskId: item.task,
    environment,
    payload: item.payload ?? "{}",
    payloadType: item.payloadType,
    errorMessage: itemError,
    errorCode: errorCode as TaskRunErrorCodes,
    parentRunId: meta.parentRunId,
    resumeParentOnCompletion: meta.resumeParentOnCompletion,
    batch: { id: batchId, index: itemIndex },
    traceContext: meta.traceContext as Record<string, unknown> | undefined,
    spanParentAsLink: meta.spanParentAsLink,
  });

  if (failedRunId) {
    span.setAttribute("batch.result.pre_failed", true);
    span.setAttribute("batch.result.run_id", failedRunId);
    span.end();
    return { success: true as const, runId: failedRunId };
  }

  // Fallback if TriggerFailedTaskService fails
  span.end();
  return { success: false as const, error: itemError, errorCode };
}
```

Note: this returns `{ success: true, runId }` because the pre-failed run IS a real run. The BatchQueue records it as a success (run was created). The run itself is already in SYSTEM_FAILURE status, so the batch completion flow handles it correctly.

If `environment` is null (environment not found), fall through to the existing environment-not-found handling which already uses `triggerFailedTaskService.callWithoutTraceEvents()` on `isFinalAttempt`.

### 5. Handle undefined/null payload in BatchQueue serialization

**`internal-packages/run-engine/src/batch-queue/index.ts`** - in `#handleMessage`

Both payload serialization blocks (in the `success: false` branch and the `catch` block) do:
```typescript
const str = typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
innerSpan?.setAttribute("batch.payloadSize", str.length);
```

`JSON.stringify(undefined)` returns `undefined`, causing `str.length` to crash. Fix both:
```typescript
const str =
  item.payload === undefined || item.payload === null
    ? "{}"
    : typeof item.payload === "string"
      ? item.payload
      : JSON.stringify(item.payload);
```

### 6. Remove stale error handling in route

**`apps/webapp/app/routes/api.v3.batches.$batchId.items.ts`**

The `error.message.includes("exceeds maximum size")` branch is no longer reachable since oversized items don't throw. Remove that condition, keep the `"Invalid JSON"` check.

### 7. Remove `BatchItemTooLargeError` and SDK pre-validation

**`packages/core/src/v3/apiClient/errors.ts`** - remove `BatchItemTooLargeError` class

**`packages/core/src/v3/apiClient/index.ts`**:
- Remove `BatchItemTooLargeError` import
- Remove `instanceof BatchItemTooLargeError` check in the retry catch block
- Remove `MAX_BATCH_ITEM_BYTES` constant
- Remove size validation from `createNdjsonStream` (revert `encodeAndValidate` to simple encode)

**`packages/trigger-sdk/src/v3/shared.ts`** - remove `BatchItemTooLargeError` import and handling in `buildBatchErrorMessage`

**`packages/trigger-sdk/src/v3/index.ts`** - remove `BatchItemTooLargeError` re-export

### 8. Update tests

**`apps/webapp/test/engine/streamBatchItems.test.ts`**:
- Update "should reject lines exceeding maxItemBytes" to assert `OversizedItemMarker` emission instead of throw
- Update "should reject unbounded accumulation without newlines" similarly
- Update the emoji byte-size test to assert marker instead of throw

### 9. Update reference project test task

**`references/hello-world/src/trigger/batches.ts`**:
- Remove `BatchItemTooLargeError` import
- Update `batchSealFailureOversizedPayload` task to test the new behavior:
  - Send 2 items: one normal, one oversized (~3.2MB)
  - Assert `batchTriggerAndWait` returns (doesn't throw)
  - Assert `results.runs[0].ok === true` (normal item succeeded)
  - Assert `results.runs[1].ok === false` (oversized item failed)
  - Assert error message contains "too large"

## Data flow

```
NDJSON bytes arrive
  |
createNdjsonParserStream
  |-- Line <= limit --> parse JSON --> enqueue object
  `-- Line > limit  --> extractIndexAndTask(bytes) --> enqueue OversizedItemMarker
  |
StreamBatchItemsService for-await loop
  |-- OversizedItemMarker --> engine.enqueueBatchItem() with __error in options
  `-- Normal item         --> validate --> engine.enqueueBatchItem()
  |
FairQueue consumer (#handleMessage)
  |-- __error in options --> processItemCallback detects it
  |     --> TriggerFailedTaskService.call()
  |     --> Creates pre-failed TaskRun with SYSTEM_FAILURE status
  |     --> Proper waitpoint + TaskRunWaitpoint connections created
  |     --> Returns { success: true, runId: failedRunFriendlyId }
  `-- Normal item --> TriggerTaskService.call() --> creates normal run
  |
Batch sealing: enqueuedCount === runCount (all items go through enqueueBatchItem)
Batch completion: all items have runs (real or pre-failed), waitpoints resolve normally
Parent run: batchTriggerAndWait resolves with per-item results
```

## Why this works

The key insight is that `TriggerFailedTaskService` (from PR #2980) creates a real `TaskRun` in `SYSTEM_FAILURE` status. This means:
1. A RUN waitpoint is created and connected to the parent via `TaskRunWaitpoint` with correct `batchId`/`batchIndex`
2. The run is immediately completed, which completes the waitpoint
3. The SDK's `waitForBatch` resolver for that index fires with the error result
4. The batch completion flow counts this as a processed item (it's a real run)
5. No special-casing needed in the batch completion callback

## Verification

1. Rebuild `@trigger.dev/core`, `@trigger.dev/sdk`, `@internal/run-engine`
2. Restart webapp + trigger dev
3. Trigger `batch-seal-failure-oversized` task - should complete in ~2-3s with:
   - Normal item: `ok: true`
   - Oversized item: `ok: false` with "too large" error
4. Run NDJSON parser tests: updated tests assert marker emission instead of throws
5. Run `pnpm run build --filter @internal/run-engine --filter @trigger.dev/core --filter @trigger.dev/sdk`
