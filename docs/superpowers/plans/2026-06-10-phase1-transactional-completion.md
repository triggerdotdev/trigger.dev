# Phase 1: Transactional Run Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Halve the Run Engine's Postgres commit count on the run-completion and run-continuation paths by wrapping their currently-separate single-row writes into single transactions, making each state transition atomic.

**Architecture:** Production Performance Insights shows ~60% of DB load during AAS storms is `IO:XactSync` (Aurora commit sync) caused by the engine committing a separate tiny transaction per write. Two hot paths each issue 2 write-commits that can be 1: `attemptSucceeded` (TaskRun update+snapshot, then waitpoint completion) and `continueRunIfUnblocked` (snapshot insert, then TaskRunWaitpoint delete). We wrap each pair in one `$transaction` using the exact idiom already used by `startRunAttempt` (`runAttemptSystem.ts:397`). Redis operations and eventBus emissions MUST stay outside/after the transaction — a side effect firing before COMMIT would act on state that can roll back. `completeWaitpoint` is therefore split into a tx-able mutation phase and a post-commit side-effect phase.

**Tech Stack:** TypeScript, Prisma 6 interactive transactions (`$transaction` helper from `@trigger.dev/database`), vitest + `@internal/testcontainers` (real Postgres + Redis — never mock, per repo CLAUDE.md).

**Out of scope (follow-up PRs):** the failure path (`attemptFailed` / `#permanentlyFailRun`), the cancellation path (`cancelRun`), and cross-run write coalescing (Phase 2). One change at a time.

**Verification baseline:** the run-engine test suite must be green before starting. All commands below run from `internal-packages/run-engine/` unless stated otherwise.

---

## File Structure

- Modify: `internal-packages/run-engine/src/engine/systems/waitpointSystem.ts`
  - Split `completeWaitpoint` (lines 70–174) into `completeWaitpointMutation` (PG-only, tx-able) + `scheduleWaitpointContinuations` (post-commit Redis/event side effects), with `completeWaitpoint` preserved as the composition of both (7 existing callers unchanged).
  - Wrap the `EXECUTING_WITH_WAITPOINTS` case of `continueRunIfUnblocked` (lines ~795–912) in one transaction.
- Modify: `internal-packages/run-engine/src/engine/systems/runAttemptSystem.ts`
  - Wrap `attemptSucceeded`'s TaskRun update + waitpoint completion (lines ~741–817) in one transaction.
- Create: `internal-packages/run-engine/src/engine/tests/atomicCompletion.test.ts`
  - Commit-count regression tests (via `txid_current()` deltas) + rollback-atomicity test (via a held row lock — real DB fault injection, no mocks).
- Create: `.server-changes/transactional-run-completion.md`

---

### Task 1: Confirm baseline is green

**Files:** none modified.

- [ ] **Step 1: Build dependencies and run the affected test files**

```bash
cd /path/to/repo
pnpm run build --filter @internal/run-engine
cd internal-packages/run-engine
pnpm run test ./src/engine/tests/triggerAndWait.test.ts --run
pnpm run test ./src/engine/tests/waitpoints.test.ts --run
pnpm run test ./src/engine/tests/trigger.test.ts --run
```

Expected: PASS. If anything fails here, STOP — the baseline is broken and must be reported before any changes.

---

### Task 2: Split `completeWaitpoint` into mutation + side-effect phases

**Files:**
- Modify: `internal-packages/run-engine/src/engine/systems/waitpointSystem.ts:70-174`

This is a behavior-preserving refactor. Existing tests are the safety net; no new test is written first.

- [ ] **Step 1: Add the result type and split the method**

In `waitpointSystem.ts`, immediately above `export class WaitpointSystem` (line 42), add:

```ts
export type CompletedWaitpointMutationResult = {
  waitpoint: Waitpoint;
  affectedTaskRuns: {
    taskRunId: string;
    spanIdToComplete: string | null;
    createdAt: Date;
  }[];
};
```

(`Waitpoint` is already imported in this file — it's the current return type of `completeWaitpoint`.)

Replace the entire `completeWaitpoint` method (lines 70–174, from the `/** This completes a waitpoint...` comment through the closing `}` after `return waitpoint;`) with these three methods:

```ts
  /** This completes a waitpoint and updates all entries so the run isn't blocked,
   * if they're no longer blocked. This doesn't suffer from race conditions. */
  async completeWaitpoint({
    id,
    output,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
  }): Promise<Waitpoint> {
    const result = await this.completeWaitpointMutation({ id, output });
    await this.scheduleWaitpointContinuations({ ...result, output });
    return result.waitpoint;
  }

  /** Marks the waitpoint COMPLETED and returns the runs it was blocking.
   * Pure Postgres mutation — safe to run inside a transaction via `tx`.
   * Callers passing `tx` MUST call scheduleWaitpointContinuations() with the
   * result AFTER the surrounding transaction commits, otherwise blocked runs
   * are never continued. */
  async completeWaitpointMutation({
    id,
    output,
    tx,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
    tx?: PrismaClientOrTransaction;
  }): Promise<CompletedWaitpointMutationResult> {
    const prisma = tx ?? this.$.prisma;

    // 1. Complete the Waitpoint (if not completed)
    const [updateError, updateResult] = await tryCatch(
      prisma.waitpoint.updateMany({
        where: { id, status: "PENDING" },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: output?.value,
          outputType: output?.type,
          outputIsError: output?.isError,
        },
      })
    );

    if (updateError) {
      this.$.logger.error("completeWaitpoint: error updating waitpoint:", { updateError });
      throw updateError;
    }

    if (updateResult.count === 0) {
      this.$.logger.info(
        "completeWaitpoint: attempted to complete a waitpoint that is not PENDING",
        { waitpointId: id }
      );
    }

    const waitpoint = await prisma.waitpoint.findFirst({
      where: { id },
    });

    if (!waitpoint) {
      this.$.logger.error("completeWaitpoint: waitpoint not found", { waitpointId: id });
      throw new Error("Waitpoint not found");
    }

    if (waitpoint.status !== "COMPLETED") {
      this.$.logger.error(`completeWaitpoint: waitpoint is not completed`, {
        waitpointId: id,
      });
      throw new Error("Waitpoint not completed");
    }

    // 2. Find the TaskRuns blocked by this waitpoint
    const affectedTaskRuns = await prisma.taskRunWaitpoint.findMany({
      where: { waitpointId: id },
      select: { taskRunId: true, spanIdToComplete: true, createdAt: true },
    });

    if (affectedTaskRuns.length === 0) {
      this.$.logger.debug(`completeWaitpoint: no TaskRunWaitpoints found for waitpoint`, {
        waitpointId: id,
      });
    }

    return { waitpoint, affectedTaskRuns };
  }

  /** Post-commit side effects of completing a waitpoint: schedules continuation of
   * the blocked runs and emits events. Must be called AFTER the mutation committed —
   * never from inside a transaction. */
  async scheduleWaitpointContinuations({
    waitpoint,
    affectedTaskRuns,
    output,
  }: CompletedWaitpointMutationResult & {
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
  }): Promise<void> {
    // 3. Schedule trying to continue the runs
    for (const run of affectedTaskRuns) {
      const jobId = `continueRunIfUnblocked:${run.taskRunId}`;
      //50ms in the future
      const availableAt = new Date(Date.now() + 50);

      this.$.logger.debug(`completeWaitpoint: enqueueing continueRunIfUnblocked`, {
        waitpointId: waitpoint.id,
        runId: run.taskRunId,
        jobId,
        availableAt,
      });

      await this.$.worker.enqueue({
        //this will debounce the call
        id: jobId,
        job: "continueRunIfUnblocked",
        payload: { runId: run.taskRunId },
        availableAt,
      });

      // emit an event to complete associated cached runs
      if (run.spanIdToComplete) {
        this.$.eventBus.emit("cachedRunCompleted", {
          time: new Date(),
          span: {
            id: run.spanIdToComplete,
            createdAt: run.createdAt,
          },
          blockedRunId: run.taskRunId,
          hasError: output?.isError ?? false,
          cachedRunId: waitpoint.completedByTaskRunId ?? undefined,
        });
      }
    }
  }
```

Note the one intentional difference from the original: the debug log inside the loop uses `waitpointId: waitpoint.id` instead of the old closure variable `id`. Everything else is a verbatim move.

- [ ] **Step 2: Typecheck**

```bash
cd internal-packages/run-engine && pnpm run typecheck
```

Expected: PASS. (`PrismaClientOrTransaction` and `tryCatch` are already imported in this file.)

- [ ] **Step 3: Run the waitpoint-related tests to confirm no behavior change**

```bash
pnpm run test ./src/engine/tests/waitpoints.test.ts --run
pnpm run test ./src/engine/tests/triggerAndWait.test.ts --run
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add internal-packages/run-engine/src/engine/systems/waitpointSystem.ts
git commit -m "refactor(run-engine): split completeWaitpoint into tx-able mutation and post-commit side effects"
```

---

### Task 3: Write the failing tests for transactional completion

**Files:**
- Create: `internal-packages/run-engine/src/engine/tests/atomicCompletion.test.ts`

Both tests use the parent + `triggerAndWait` child setup (only child runs created with `resumeParentOnCompletion: true` get an `associatedWaitpoint`, so only they exercise the two-commit completion path).

- [ ] **Step 1: Write the test file**

```ts
import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { setTimeout } from "timers/promises";
import { PrismaClient } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngine(prisma: PrismaClient, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

/** Number of xid-consuming (i.e. write) transactions is the delta between two
 * txid_current() calls, minus 1 for the second call itself. Read-only
 * transactions never allocate an xid, so they don't count. */
async function currentTxid(prisma: PrismaClient): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ txid: bigint }[]>`SELECT txid_current() AS txid`;
  return BigInt(rows[0].txid);
}

/** Drives a parent run + triggerAndWait child up to the point where the child
 * is EXECUTING and the parent is blocked on the child's associated waitpoint. */
async function setupBlockedParentWithExecutingChild(
  engine: RunEngine,
  prisma: PrismaClient,
  authenticatedEnvironment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>
) {
  const parentTask = "parent-task";
  const childTask = "child-task";

  await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

  const parentRun = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_p1234",
      environment: authenticatedEnvironment,
      taskIdentifier: parentTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      queue: `task/${parentTask}`,
      isTest: false,
      tags: [],
      workerQueue: "main",
    },
    prisma
  );

  await setTimeout(500);
  const dequeuedParent = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeuedParent.length).toBe(1);

  await engine.startRunAttempt({
    runId: parentRun.id,
    snapshotId: dequeuedParent[0].snapshot.id,
  });

  const childRun = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_c1234",
      environment: authenticatedEnvironment,
      taskIdentifier: childTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      queue: `task/${childTask}`,
      isTest: false,
      tags: [],
      resumeParentOnCompletion: true,
      parentTaskRunId: parentRun.id,
      workerQueue: "main",
    },
    prisma
  );

  await setTimeout(500);
  const dequeuedChild = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeuedChild.length).toBe(1);

  const childAttempt = await engine.startRunAttempt({
    runId: childRun.id,
    snapshotId: dequeuedChild[0].snapshot.id,
  });

  const childWithWaitpoint = await prisma.taskRun.findFirstOrThrow({
    where: { id: childRun.id },
    include: { associatedWaitpoint: true },
  });
  assertNonNullable(childWithWaitpoint.associatedWaitpoint);

  return {
    parentRun,
    childRun,
    childAttempt,
    waitpointId: childWithWaitpoint.associatedWaitpoint.id,
  };
}

describe("RunEngine atomic completion", () => {
  containerTest(
    "attemptSucceeded with an associated waitpoint is a single write transaction",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { childRun, childAttempt } = await setupBlockedParentWithExecutingChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        const before = await currentTxid(prisma);

        const result = await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttempt.snapshot.id,
          completion: {
            ok: true,
            id: childRun.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        const after = await currentTxid(prisma);

        expect(result.attemptStatus).toBe("RUN_FINISHED");

        // TaskRun update (+ nested snapshot) and waitpoint completion
        // must share one commit.
        const writeTransactions = Number(after - before) - 1;
        expect(writeTransactions).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "continueRunIfUnblocked is a single write transaction",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { parentRun, childRun, childAttempt } = await setupBlockedParentWithExecutingChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttempt.snapshot.id,
          completion: {
            ok: true,
            id: childRun.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        const before = await currentTxid(prisma);

        // The continueRunIfUnblocked job is debounced by 50ms; poll until the
        // parent has been continued (EXECUTING_WITH_WAITPOINTS -> EXECUTING).
        let continued = false;
        for (let i = 0; i < 50; i++) {
          await setTimeout(100);
          const parentData = await engine.getRunExecutionData({ runId: parentRun.id });
          if (parentData?.snapshot.executionStatus === "EXECUTING") {
            continued = true;
            break;
          }
        }
        expect(continued).toBe(true);

        const after = await currentTxid(prisma);

        // Snapshot insert and TaskRunWaitpoint delete must share one commit.
        const writeTransactions = Number(after - before) - 1;
        expect(writeTransactions).toBe(1);

        const remainingBlockers = await prisma.taskRunWaitpoint.findMany({
          where: { taskRunId: parentRun.id },
        });
        expect(remainingBlockers.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a failed completion rolls back the whole transition",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { childRun, childAttempt, waitpointId } = await setupBlockedParentWithExecutingChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        // Real fault injection, no mocks: hold a row lock on the child's
        // associated waitpoint so the waitpoint completion inside
        // attemptSucceeded blocks past the transaction timeout (5s default)
        // and the whole transaction aborts.
        const lockHolder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Waitpoint" WHERE "id" = ${waitpointId} FOR UPDATE`;
            await setTimeout(8_000);
          },
          { timeout: 20_000, maxWait: 5_000 }
        );
        await setTimeout(300); // let the lock land

        let completionError: unknown;
        try {
          await engine.completeRunAttempt({
            runId: childRun.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              ok: true,
              id: childRun.id,
              output: `{"foo":"bar"}`,
              outputType: "application/json",
            },
          });
        } catch (error) {
          completionError = error;
        }

        await lockHolder;

        // The completion must have failed while the lock was held...
        expect(completionError).toBeDefined();

        // ...and NOTHING from the transition may have been committed:
        // run still EXECUTING, waitpoint still PENDING, no FINISHED snapshot.
        const childAfter = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
        });
        expect(childAfter.status).toBe("EXECUTING");

        const waitpointAfter = await prisma.waitpoint.findFirstOrThrow({
          where: { id: waitpointId },
        });
        expect(waitpointAfter.status).toBe("PENDING");

        const finishedSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: childRun.id, executionStatus: "FINISHED" },
        });
        expect(finishedSnapshots.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
```

Note: `setupBackgroundWorker` accepts `string | string[]` for the task identifier (`setup.ts:87`), so the array call above is correct.

- [ ] **Step 2: Run the new tests to verify they FAIL for the right reasons**

```bash
pnpm run test ./src/engine/tests/atomicCompletion.test.ts --run
```

Expected: all three FAIL:
- Test 1: `writeTransactions` is 2 (TaskRun update commit + waitpoint updateMany commit), expected 1.
- Test 2: `writeTransactions` is 2 (snapshot insert commit + TaskRunWaitpoint delete commit), expected 1.
- Test 3: `completionError` is undefined (today the standalone `updateMany` has no transaction timeout — it just waits 8s for the lock and then succeeds) AND `childAfter.status` is `COMPLETED_SUCCESSFULLY` (the TaskRun update committed before the waitpoint write — the torn state this change eliminates).

If a test fails for a different reason (setup error, wrong call shape), fix the test until the failures are exactly these.

- [ ] **Step 3: Commit the failing tests**

```bash
git add internal-packages/run-engine/src/engine/tests/atomicCompletion.test.ts
git commit -m "test(run-engine): add failing tests for atomic single-commit run completion"
```

---

### Task 4: Wrap `attemptSucceeded` in a single transaction

**Files:**
- Modify: `internal-packages/run-engine/src/engine/systems/runAttemptSystem.ts:741-817`

- [ ] **Step 1: Replace the separate update + completeWaitpoint with one $transaction**

In `attemptSucceeded`, replace the block from `const run = await prisma.taskRun.update({` (line 741) through the end of the `if (run.associatedWaitpoint) { ... }` block (line 817) with:

```ts
          const completedOutput = completion.output
            ? { value: completion.output, type: completion.outputType, isError: false }
            : undefined;

          const txResult = await $transaction(
            prisma,
            async (tx) => {
              const run = await tx.taskRun.update({
                where: { id: runId },
                data: {
                  status: "COMPLETED_SUCCESSFULLY",
                  completedAt,
                  output: completion.output,
                  outputType: completion.outputType,
                  usageDurationMs: updatedUsage.usageDurationMs,
                  costInCents: updatedUsage.costInCents,
                  executionSnapshots: {
                    create: {
                      executionStatus: "FINISHED",
                      description: "Task completed successfully",
                      runStatus: "COMPLETED_SUCCESSFULLY",
                      attemptNumber: latestSnapshot.attemptNumber,
                      environmentId: latestSnapshot.environmentId,
                      environmentType: latestSnapshot.environmentType,
                      projectId: latestSnapshot.projectId,
                      organizationId: latestSnapshot.organizationId,
                      workerId,
                      runnerId,
                    },
                  },
                },
                select: {
                  id: true,
                  friendlyId: true,
                  status: true,
                  attemptNumber: true,
                  spanId: true,
                  updatedAt: true,
                  associatedWaitpoint: {
                    select: {
                      id: true,
                    },
                  },
                  project: {
                    select: {
                      organizationId: true,
                    },
                  },
                  batchId: true,
                  createdAt: true,
                  completedAt: true,
                  taskEventStore: true,
                  parentTaskRunId: true,
                  usageDurationMs: true,
                  costInCents: true,
                  runtimeEnvironmentId: true,
                  projectId: true,
                },
              });

              // Complete the waitpoint if it exists (runs without waiting parents
              // have no waitpoint). Side effects (continuation jobs, events) are
              // scheduled after this transaction commits.
              const completedWaitpoint = run.associatedWaitpoint
                ? await this.waitpointSystem.completeWaitpointMutation({
                    id: run.associatedWaitpoint.id,
                    output: completedOutput,
                    tx,
                  })
                : undefined;

              return { run, completedWaitpoint };
            },
            (error) => {
              this.$.logger.error("RunEngine.attemptSucceeded(): prisma.$transaction error", {
                code: error.code,
                meta: error.meta,
                stack: error.stack,
                message: error.message,
                name: error.name,
              });
              throw new ServiceValidationError(
                "Failed to complete task run and associated waitpoint",
                500
              );
            }
          );

          if (!txResult) {
            throw new ServiceValidationError("Failed to complete task run attempt", 500);
          }

          const { run, completedWaitpoint } = txResult;

          const newSnapshot = await getLatestExecutionSnapshot(prisma, runId);

          await this.$.runQueue.acknowledgeMessage(run.project.organizationId, runId);

          // We need to manually emit this as we created the final snapshot as part of the task run update
          this.$.eventBus.emit("executionSnapshotCreated", {
            time: newSnapshot.createdAt,
            run: {
              id: newSnapshot.runId,
            },
            snapshot: {
              ...newSnapshot,
              completedWaitpointIds: newSnapshot.completedWaitpoints.map((wp) => wp.id),
            },
          });

          // Post-commit side effects of the waitpoint completion
          if (completedWaitpoint) {
            await this.waitpointSystem.scheduleWaitpointContinuations({
              ...completedWaitpoint,
              output: completedOutput,
            });
          }
```

The subsequent `this.$.eventBus.emit("runSucceeded", ...)`, `await this.#finalizeRun(run);`, and the `return { attemptStatus: "RUN_FINISHED", snapshot: newSnapshot, run };` (lines 819–852) stay exactly as they are.

Two things removed relative to the old code, deliberately:
- The old `await this.$.runQueue.acknowledgeMessage(...)` / `executionSnapshotCreated` emit that sat *between* the update and the waitpoint completion now run after the transaction (same relative order to each other).
- The old direct `completeWaitpoint` call is replaced by mutation-inside-tx + side-effects-after-tx.

`$transaction` is already imported in this file (line 38). `ServiceValidationError` is already imported (line 44).

- [ ] **Step 2: Typecheck**

```bash
cd internal-packages/run-engine && pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the new tests — completion tests must now pass**

```bash
pnpm run test ./src/engine/tests/atomicCompletion.test.ts --run
```

Expected: Test 1 ("single write transaction") PASS. Test 3 ("rolls back the whole transition") PASS. Test 2 ("continueRunIfUnblocked") still FAILS (that's Task 5).

- [ ] **Step 4: Run the existing lifecycle tests**

```bash
pnpm run test ./src/engine/tests/trigger.test.ts --run
pnpm run test ./src/engine/tests/triggerAndWait.test.ts --run
pnpm run test ./src/engine/tests/waitpoints.test.ts --run
pnpm run test ./src/engine/tests/batchTriggerAndWait.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal-packages/run-engine/src/engine/systems/runAttemptSystem.ts
git commit -m "feat(run-engine): complete run and waitpoint in a single transaction"
```

---

### Task 5: Wrap `continueRunIfUnblocked`'s unblock in a single transaction

**Files:**
- Modify: `internal-packages/run-engine/src/engine/systems/waitpointSystem.ts` (the `EXECUTING_WITH_WAITPOINTS` case, lines ~795–837, and imports)

- [ ] **Step 1: Add `$transaction` to the imports**

In the import block from `"@trigger.dev/database"` at the top of `waitpointSystem.ts`, add `$transaction`:

```ts
import {
  $transaction,
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  Waitpoint,
} from "@trigger.dev/database";
```

(Keep whatever names are already in that import — just add `$transaction` to them.)

- [ ] **Step 2: Replace the `EXECUTING_WITH_WAITPOINTS` case**

Replace the entire `case "EXECUTING_WITH_WAITPOINTS": { ... break; }` block with:

```ts
        case "EXECUTING_WITH_WAITPOINTS": {
          const newSnapshot = await $transaction(
            this.$.prisma,
            async (tx) => {
              const createdSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
                tx,
                {
                  run: {
                    id: runId,
                    status: snapshot.runStatus,
                    attemptNumber: snapshot.attemptNumber,
                  },
                  snapshot: {
                    executionStatus: "EXECUTING",
                    description: "Run was continued, whilst still executing.",
                  },
                  previousSnapshotId: snapshot.id,
                  environmentId: snapshot.environmentId,
                  environmentType: snapshot.environmentType,
                  projectId: snapshot.projectId,
                  organizationId: snapshot.organizationId,
                  batchId: snapshot.batchId ?? undefined,
                  completedWaitpoints: blockingWaitpoints.map((b) => ({
                    id: b.waitpoint.id,
                    index: b.batchIndex ?? undefined,
                  })),
                }
              );

              // Remove the blocking waitpoints in the same transaction, so the
              // new snapshot and the unblock are atomic.
              if (blockingWaitpoints.length > 0) {
                await tx.taskRunWaitpoint.deleteMany({
                  where: {
                    taskRunId: runId,
                    id: { in: blockingWaitpoints.map((b) => b.id) },
                  },
                });
              }

              return createdSnapshot;
            },
            (error) => {
              this.$.logger.error("continueRunIfUnblocked: prisma.$transaction error", {
                code: error.code,
                meta: error.meta,
                message: error.message,
                runId,
              });
            }
          );

          if (!newSnapshot) {
            throw new Error(`continueRunIfUnblocked: failed to unblock run: ${runId}`);
          }

          this.$.logger.debug(
            `continueRunIfUnblocked: run was still executing, sending notification`,
            {
              runId,
              snapshot,
              newSnapshot,
            }
          );

          await sendNotificationToWorker({
            runId,
            snapshot: newSnapshot,
            eventBus: this.$.eventBus,
          });

          this.$.logger.debug(`continueRunIfUnblocked: removed blocking waitpoints`, {
            runId,
            blockingWaitpoints,
          });

          return {
            status: "unblocked",
            waitpoints: blockingWaitpoints.map((w) => w.waitpoint),
          };
        }
```

This case now returns directly instead of `break`ing, so the post-switch `if (blockingWaitpoints.length > 0) { deleteMany ... }` block (lines ~893–906) no longer runs for it — that block now only serves the `SUSPENDED` case, which is deliberately left unchanged in this PR (its `enqueueRun` performs Redis work internally and must not be pulled into a Postgres transaction).

Note the ordering improvement: the worker notification now fires after the unblock is durable, instead of before the waitpoint rows were deleted.

- [ ] **Step 3: Typecheck**

```bash
cd internal-packages/run-engine && pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the new tests — all three must now pass**

```bash
pnpm run test ./src/engine/tests/atomicCompletion.test.ts --run
```

Expected: PASS (all 3).

- [ ] **Step 5: Run the waitpoint/continuation-heavy existing tests**

```bash
pnpm run test ./src/engine/tests/triggerAndWait.test.ts --run
pnpm run test ./src/engine/tests/waitpoints.test.ts --run
pnpm run test ./src/engine/tests/waitpointRace.test.ts --run
pnpm run test ./src/engine/tests/batchTriggerAndWait.test.ts --run
pnpm run test ./src/engine/tests/lazyWaitpoint.test.ts --run
pnpm run test ./src/engine/tests/checkpoints.test.ts --run
```

Expected: PASS. (`checkpoints.test.ts` exercises the SUSPENDED path — it must be unaffected.)

- [ ] **Step 6: Commit**

```bash
git add internal-packages/run-engine/src/engine/systems/waitpointSystem.ts
git commit -m "feat(run-engine): unblock continued runs in a single transaction"
```

---

### Task 6: Full suite, server-changes file, final verification

**Files:**
- Create: `.server-changes/transactional-run-completion.md`

- [ ] **Step 1: Run the full run-engine test suite**

```bash
cd internal-packages/run-engine && pnpm run test --run
```

Expected: PASS. This takes a while (testcontainers). If any test fails, STOP and investigate using the systematic-debugging skill — do not paper over it.

- [ ] **Step 2: Typecheck the webapp (consumes the run-engine package)**

```bash
cd /path/to/repo && pnpm run typecheck --filter webapp
```

Expected: PASS (the public method `completeWaitpoint` kept its exact signature, so no webapp changes should be needed).

- [ ] **Step 3: Add the server-changes file**

This PR touches only an internal package consumed by the server — no public package changes, so a `.server-changes/` file (not a changeset) is required. Create `.server-changes/transactional-run-completion.md`:

```markdown
---
area: webapp
type: improvement
---

Reduce database load during traffic spikes by completing runs and resuming waiting runs in single atomic transactions
```

- [ ] **Step 4: Commit**

```bash
git add .server-changes/transactional-run-completion.md
git commit -m "chore: add server-changes entry for transactional run completion"
```

- [ ] **Step 5: Verify the diff is clean and report**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Expected: 4 commits, changes confined to `waitpointSystem.ts`, `runAttemptSystem.ts`, `atomicCompletion.test.ts`, the `.server-changes/` file, and this plan document.

---

## Risks the implementer must watch for

1. **Never move a Redis call or eventBus emit inside a `$transaction` callback.** That is the single forbidden move in this entire plan — it would publish state that can still roll back, recreating (in miniature) the async-commit hazard this approach exists to avoid.
2. **Transaction timeout:** the new transactions contain 2–4 statements and use Prisma's 5s default. If `atomicCompletion` tests show P2028 timeouts under normal (unlocked) conditions, something is holding the tx open — find it, don't raise the timeout.
3. **Flaky txid counts:** if the commit-count tests are intermittently off-by-one, another engine subsystem is writing concurrently. Identify it via `pg_stat_activity` in the test rather than loosening the assertion to `<=`.
4. **Prisma `$queryRaw` bigint mapping:** `txid_current()` comes back as `bigint` — if the helper's `BigInt(rows[0].txid)` throws on the returned type, log the raw row and adjust the cast; do not switch to a different counting mechanism.

## Expected production impact (for the PR description)

Engine-side write commits drop ~2× on the completion path and ~2× on the continuation path (the two hottest sequences after trigger/dequeue). Based on production Performance Insights (2026-06-10): cluster commit rate ~21–31k/sec with `IO:XactSync` at ~59% of spike DB load; this change should cut total commit rate by roughly a quarter at baseline and compress top-of-hour AAS spikes. Bonus: completion and continuation become atomic — a crash can no longer leave a finished run with a still-blocked parent.
