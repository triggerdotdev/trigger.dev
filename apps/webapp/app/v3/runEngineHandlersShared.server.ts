/**
 * Pure, store-routing helpers extracted from runEngineHandlers.server.ts so they
 * are testable without constructing the engine (importing that module pulls in the
 * whole webapp service graph). The handlers wire the production defaults; tests
 * inject per-container stores/replicas, so these helpers never import db.server.
 */
import type { CompleteBatchResult } from "@internal/run-engine";
import type { RunStore } from "@internal/run-store";
import type { BatchTaskRunStatus, Prisma } from "@trigger.dev/database";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { logger } from "~/services/logger.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";

export type EventReadDeps = {
  store: RunStore;
  newReplica: PrismaReplicaClient;
  legacyReplica: PrismaReplicaClient;
  splitEnabled: boolean;
  // Pure boundary forwarded to read-through; production leaves it undefined
  // so the read-through layer uses its own wired default. Tests inject a fake.
  isPastRetention?: (runId: string) => boolean;
};

/**
 * Resolve a TaskRun for an event-bus enrichment read through the run-ops
 * read-through layer. The store stays the read mechanism (the
 * closures call `store.findRun(...)`); read-through only chooses which replica.
 * Returns null when not-found / past-retention. Passthrough in single-DB.
 */
export async function readRunForEvent<S extends Prisma.TaskRunSelect>(
  runId: string,
  environmentId: string,
  select: S,
  deps: EventReadDeps
): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null> {
  const result = await readThroughRun<Prisma.TaskRunGetPayload<{ select: S }>>({
    runId,
    environmentId,
    readNew: (client) => deps.store.findRun({ id: runId }, { select }, client),
    readLegacy: (replica) => deps.store.findRun({ id: runId }, { select }, replica),
    deps: {
      newClient: deps.newReplica,
      legacyReplica: deps.legacyReplica,
      splitEnabled: deps.splitEnabled,
      isPastRetention: deps.isPastRetention,
    },
  });

  return result.source === "not-found" || result.source === "past-retention" ? null : result.value;
}

/**
 * Reproduces the `findRunOrThrow` not-found-as-error semantics the 6 throwing
 * read sites rely on (a missing run throws, which their `tryCatch` turns into
 * the existing error-log + early-return — never a silent no-op).
 */
export async function readRunForEventOrThrow<S extends Prisma.TaskRunSelect>(
  runId: string,
  environmentId: string,
  select: S,
  deps: EventReadDeps
): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
  const run = await readRunForEvent(runId, environmentId, select, deps);
  if (!run) {
    throw new Error("Task run not found");
  }
  return run;
}

/**
 * Resolve which run-ops writer physically owns the `BatchTaskRun` row for
 * `batchId` by probing where the row lives, so the batch-completion txn commits
 * on a single run-ops DB. Length classification is INVALID here: a batch id may
 * be a ksuid (cut-over orgs) or a cuid (and cuid-shaped ids can be backfilled
 * onto NEW), so id-shape does not reliably indicate the row's actual residency.
 * The existence probe is the correct signal.
 */
export async function resolveBatchRunOpsWriter(
  batchId: string,
  deps: {
    newReplica: PrismaReplicaClient;
    newWriter: PrismaClient;
    legacyWriter: PrismaClient;
  }
): Promise<PrismaClient> {
  const onNew = await deps.newReplica.batchTaskRun.findFirst({
    where: { id: batchId },
    select: { id: true },
  });
  return onNew ? deps.newWriter : deps.legacyWriter;
}

/**
 * errorCode returned by the batch process-item callback when the trigger was
 * rejected because the environment's queue is at its maximum size. The
 * BatchQueue (via `skipRetries`) short-circuits retries for this code, and the
 * batch completion callback collapses per-item errors into a single aggregate
 * `BatchTaskRunError` row instead of writing one per item.
 */
export const QUEUE_SIZE_LIMIT_EXCEEDED_ERROR_CODE = "QUEUE_SIZE_LIMIT_EXCEEDED";

export type BatchCompletionDeps = {
  splitEnabled: boolean;
  newReplica: PrismaReplicaClient;
  newWriter: PrismaClient;
  legacyWriter: PrismaClient;
  tryCompleteBatch: (batchId: string) => Promise<unknown>;
};

/**
 * Routes the batch-completion transaction (BatchTaskRun update + BatchTaskRunError
 * createMany — both run-ops tables) onto the run-ops writer that physically owns
 * the BatchTaskRun row for `batchId`, so the whole txn commits on a single DB. The
 * transaction body is unchanged from before the split; only the client changes.
 */
export async function handleBatchCompletion(
  result: CompleteBatchResult,
  deps: BatchCompletionDeps
) {
  const { batchId, runIds, successfulRunCount, failedRunCount, failures } = result;

  // Determine final status
  let status: BatchTaskRunStatus;
  if (failedRunCount > 0 && successfulRunCount === 0) {
    status = "ABORTED";
  } else if (failedRunCount > 0) {
    status = "PARTIAL_FAILED";
  } else {
    status = "PENDING"; // All runs created, waiting for completion
  }

  // Always probe residency — never special-case on splitEnabled (see commit msg).
  const runOpsWriter = await resolveBatchRunOpsWriter(batchId, {
    newReplica: deps.newReplica,
    newWriter: deps.newWriter,
    legacyWriter: deps.legacyWriter,
  });

  try {
    // Use a transaction to ensure atomicity of batch update and error record creation
    // skipDuplicates handles idempotency when callback is retried (relies on unique constraint)
    await runOpsWriter.$transaction(async (tx) => {
      // Update BatchTaskRun
      await tx.batchTaskRun.update({
        where: { id: batchId },
        data: {
          status,
          runIds,
          successfulRunCount,
          failedRunCount,
          completedAt: status === "ABORTED" ? new Date() : undefined,
          processingCompletedAt: new Date(),
        },
      });

      // Create error records if there were failures.
      //
      // Fast-path for queue-size-limit overload: when every failure is the
      // same QUEUE_SIZE_LIMIT_EXCEEDED error, collapse them into a single
      // aggregate row instead of writing one per item. This keeps the DB
      // write volume bounded to O(batches) instead of O(items) when a noisy
      // tenant fills their queue and all of their batches start bouncing.
      if (failures.length > 0) {
        const allQueueSizeLimit = failures.every(
          (f) => f.errorCode === QUEUE_SIZE_LIMIT_EXCEEDED_ERROR_CODE
        );

        if (allQueueSizeLimit) {
          const sample = failures[0]!;
          await tx.batchTaskRunError.createMany({
            data: [
              {
                batchTaskRunId: batchId,
                // Use the first item's index as a stable anchor for the
                // (batchTaskRunId, index) unique constraint so callback
                // retries remain idempotent.
                index: sample.index,
                taskIdentifier: sample.taskIdentifier,
                payload: sample.payload,
                options: sample.options as Prisma.InputJsonValue | undefined,
                error: `${sample.error} (${failures.length} items in this batch failed with the same error)`,
                errorCode: sample.errorCode,
              },
            ],
            skipDuplicates: true,
          });
        } else {
          await tx.batchTaskRunError.createMany({
            data: failures.map((failure) => ({
              batchTaskRunId: batchId,
              index: failure.index,
              taskIdentifier: failure.taskIdentifier,
              payload: failure.payload,
              options: failure.options as Prisma.InputJsonValue | undefined,
              error: failure.error,
              errorCode: failure.errorCode,
            })),
            skipDuplicates: true,
          });
        }
      }
    });

    // Try to complete the batch (handles waitpoint completion if all runs are done)
    if (status !== "ABORTED") {
      await deps.tryCompleteBatch(batchId);
    }

    logger.info("Batch completion handled", {
      batchId,
      status,
      successfulRunCount,
      failedRunCount,
    });
  } catch (error) {
    logger.error("Failed to handle batch completion", {
      batchId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Re-throw to preserve Redis data for retry (BatchQueue expects errors to propagate)
    throw error;
  }
}
