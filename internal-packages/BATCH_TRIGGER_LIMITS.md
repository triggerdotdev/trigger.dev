Let me analyze the potential issues with increasing batch size limits by examining the key components involved in batch processing:

[10 tools called]

Now I have a comprehensive picture. Let me compile a detailed analysis of the potential issues with increasing batch size limits:

## Analysis: Potential Issues with Larger Batch Sizes

### 1. **Client-Side Runtime (`sharedRuntimeManager.ts`)** - HIGH RISK ⚠️

**Current behavior in `waitForBatch`:**

```89:95:packages/core/src/v3/runtime/sharedRuntimeManager.ts
      const promises = Array.from({ length: params.runCount }, (_, index)   => {
        const resolverId = `${params.id}_${index}` as ResolverId;

        return new Promise<CompletedWaitpoint>((resolve, reject) => {
          this.resolversById.set(resolverId, resolve);
        });
      });
```

**Issues:**

- **Memory pressure**: Creates `runCount` promises and stores `runCount` resolver functions in memory simultaneously
- **For 10,000 runs**: 10,000 promises + 10,000 Map entries held in memory until ALL runs complete
- **Long-running batches**: If a batch takes hours (some runs might be delayed or waiting), all these objects stay in memory
- **V8 limit**: Each Promise has ~1-2KB overhead; 10,000 promises ≈ 10-20MB just for promises, plus resolver functions

**Recommendation**: Consider streaming/chunked approach or lazy resolver creation

---

### 2. **Database: `runIds` Array Column** - HIGH RISK ⚠️

```1540:1541:internal-packages/database/prisma/schema.prisma
  runIds       String[] @default([])
  runCount     Int      @default(0)
```

**Issues:**

- **Array growth**: PostgreSQL array columns have practical limits
- **For 10,000 runs**: Each run ID (cuid) is ~25 chars, so 10,000 × 25 = ~250KB per row
- **Index bloat**: Array columns don't index efficiently for containment queries
- **TOAST threshold**: PostgreSQL will TOAST large arrays (compress + out-of-line storage), impacting query performance

**Current code stores all IDs:**

```988:990:internal-packages/run-engine/src/engine/tests/batchTriggerAndWait.test.ts
            runIds: result.runIds,
```

---

### 3. **Execution Snapshot: `completedWaitpointOrder`** - HIGH RISK ⚠️

```922:922:internal-packages/database/prisma/schema.prisma
  completedWaitpointOrder String[]
```

This stores waitpoint IDs in order for batches. For a 10,000-run batch:

- **Storage**: ~250KB per snapshot
- **Processing overhead**: This array is iterated in `enhanceExecutionSnapshot`:

```45:49:internal-packages/run-engine/src/engine/systems/executionSnapshotSystem.ts
      for (let i = 0; i < snapshot.completedWaitpointOrder.length; i++) {
        if (snapshot.completedWaitpointOrder[i] === w.id) {
          indexes.push(i);
        }
      }
```

- **O(N²) complexity**: For each waitpoint, iterates entire array - with 10,000 items this is 100M operations

---

### 4. **Redis: BatchCompletionTracker** - MEDIUM RISK

**Keys per batch:**

- `batch:{batchId}:meta` - JSON with metadata
- `batch:{batchId}:runs` - LIST of run IDs
- `batch:{batchId}:failures` - LIST of failure JSON objects
- `batch:{batchId}:processed` - Counter
- `batch:{batchId}:processed_items` - SET of processed item indices

**For 10,000-run batch:**

- `runs` list: ~250KB (10,000 × 25-char IDs)
- `processed_items` set: ~100KB (10,000 integers as strings)
- **Memory**: Total ~400KB per active batch

**Issues:**

- **LRANGE performance**: `getSuccessfulRuns` does `LRANGE 0 -1` which is O(N)
- **Multiple concurrent large batches**: 100 batches × 10,000 runs × 400KB = 40GB Redis memory

---

### 5. **Waitpoint System: Blocking Operations** - MEDIUM RISK

**Current behavior in `blockRunWithWaitpoint`:**

```401:429:internal-packages/run-engine/src/engine/systems/waitpointSystem.ts
        const insert = await prisma.$queryRaw<{ pending_count: BigInt }[]>`
        WITH inserted AS (
          INSERT INTO "TaskRunWaitpoint" ("id", "taskRunId", "waitpointId", "projectId", "createdAt", "updatedAt", "spanIdToComplete", "batchId", "batchIndex")
          SELECT
            gen_random_uuid(),
            ${runId},
            w.id,
            ${projectId},
            NOW(),
            NOW(),
            ${spanIdToComplete ?? null},
            ${batch?.id ?? null},
            ${batch?.index ?? null}
          FROM "Waitpoint" w
          WHERE w.id IN (${Prisma.join($waitpoints)})
          ON CONFLICT DO NOTHING
          RETURNING "waitpointId"
        ),
```

**Issues:**

- For `batchTriggerAndWait` with 10,000 runs, creates 10,000 `Waitpoint` records
- Creates 10,000 `TaskRunWaitpoint` junction records
- Each run completing triggers a query to check/update waitpoints

---

### 6. **Batch Completion Logic** - MEDIUM RISK

**Current approach in `#tryCompleteBatch`:**

```90:99:internal-packages/run-engine/src/engine/systems/batchSystem.ts
      const runs = await this.$.prisma.taskRun.findMany({
        select: {
          id: true,
          status: true,
        },
        where: {
          batchId,
          runtimeEnvironmentId: batch.runtimeEnvironmentId,
        },
      });
```

**For 10,000 runs:**

- Fetches all 10,000 records to check completion
- Called every time `scheduleCompleteBatch` is invoked (debounced to 200ms)
- If batch takes hours, this query runs many times

---

### 7. **FairQueue Enqueue Operation** - LOW-MEDIUM RISK

The current implementation enqueues items one at a time:

```131:145:internal-packages/run-engine/src/batch-queue/index.ts
    const messages = options.items.map((item, index) => ({
      id: `${options.batchId}:${index}`,
      data: {
        batchId: options.batchId,
        friendlyId: options.friendlyId,
        itemIndex: index,
        item,
      },
    }));
```

**For 10,000 runs:**

- Creates 10,000 message objects in memory at once
- Redis pipeline of 10,000 commands

---

### 8. **Logical Replication (ElectricSQL + ClickHouse)** - HIGH RISK ⚠️

You mentioned this is already a problem. With larger batches:

- 10,000 `TaskRun` INSERTs in rapid succession
- Each triggers replication events
- WAL (Write-Ahead Log) can grow rapidly
- Replication lag increases

---

## Recommendations

### Immediate (Before increasing limits):

1. **Client-side runtime**: Implement lazy resolver creation - only create resolvers as runs complete, using a queue or callback pattern

2. **Remove `runIds` array**: Since v2 batches, runs have `batchId` foreign key - we can always query `TaskRun WHERE batchId = ?`. No need to store array.

3. **Optimize `completedWaitpointOrder`**: Store as a Map-like structure or pre-sorted, avoid O(N²) lookup

4. **Chunk the `findMany` in `#tryCompleteBatch`**: Use cursor-based pagination or count-based approach instead of fetching all runs

### Short-term:

5. **Redis memory limits**: Add TTL to batch Redis keys; implement configurable memory limits per batch

6. **Rate limit run creation**: The DRR scheduler helps, but consider a hard rate limit per batch to prevent replication storms

7. **Streaming batch completion**: Instead of waiting for all runs, allow partial results callback for very large batches

### Architecture changes to consider:

8. **Separate batch runs table**: For very large batches, consider a denormalized `BatchRun` junction table optimized for batch queries

9. **Batch checkpointing**: For batches > 1,000 runs, checkpoint progress to allow recovery without reprocessing

Would you like me to start implementing any of these recommendations?
