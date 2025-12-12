import { CompleteBatchResult } from "@internal/run-engine";
import { SpanKind } from "@internal/tracing";
import { tryCatch } from "@trigger.dev/core/utils";
import { createJsonErrorObject, sanitizeError } from "@trigger.dev/core/v3";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { BatchTaskRunStatus, Prisma } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { findEnvironmentFromRun } from "~/models/runtimeEnvironment.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { reportInvocationUsage } from "~/services/platform.v3.server";
import { MetadataTooLargeError } from "~/utils/packets";
import { TriggerTaskService } from "~/v3/services/triggerTask.server";
import { tracer } from "~/v3/tracer.server";
import { createExceptionPropertiesFromError } from "./eventRepository/common.server";
import { recordRunDebugLog, resolveEventRepositoryForStore } from "./eventRepository/index.server";
import { roomFromFriendlyRunId, socketIo } from "./handleSocketIo.server";
import { engine } from "./runEngine.server";
import { PerformTaskRunAlertsService } from "./services/alerts/performTaskRunAlerts.server";

export function registerRunEngineEventBusHandlers() {
  engine.eventBus.on("runSucceeded", async ({ time, run }) => {
    const [taskRunError, taskRun] = await tryCatch(
      $replica.taskRun.findFirstOrThrow({
        where: {
          id: run.id,
        },
        select: {
          id: true,
          friendlyId: true,
          traceId: true,
          spanId: true,
          parentSpanId: true,
          createdAt: true,
          completedAt: true,
          taskIdentifier: true,
          projectId: true,
          runtimeEnvironmentId: true,
          environmentType: true,
          isTest: true,
          organizationId: true,
          taskEventStore: true,
        },
      })
    );

    if (taskRunError) {
      logger.error("[runSucceeded] Failed to find task run", {
        error: taskRunError,
        runId: run.id,
      });
      return;
    }

    const eventRepository = resolveEventRepositoryForStore(run.taskEventStore);

    const [completeSuccessfulRunEventError] = await tryCatch(
      eventRepository.completeSuccessfulRunEvent({
        run: taskRun,
        endTime: time,
      })
    );

    if (completeSuccessfulRunEventError) {
      logger.error("[runSucceeded] Failed to complete successful run event", {
        error: completeSuccessfulRunEventError,
        runId: run.id,
      });
    }
  });

  // Handle alerts
  engine.eventBus.on("runFailed", async ({ time, run }) => {
    try {
      await PerformTaskRunAlertsService.enqueue(run.id);
    } catch (error) {
      logger.error("[runFailed] Failed to enqueue alerts", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        spanId: run.spanId,
      });
    }
  });

  // Handle events
  engine.eventBus.on("runFailed", async ({ time, run }) => {
    const sanitizedError = sanitizeError(run.error);
    const exception = createExceptionPropertiesFromError(sanitizedError);

    const [taskRunError, taskRun] = await tryCatch(
      $replica.taskRun.findFirstOrThrow({
        where: {
          id: run.id,
        },
        select: {
          id: true,
          friendlyId: true,
          traceId: true,
          spanId: true,
          parentSpanId: true,
          createdAt: true,
          completedAt: true,
          taskIdentifier: true,
          projectId: true,
          runtimeEnvironmentId: true,
          environmentType: true,
          isTest: true,
          organizationId: true,
          taskEventStore: true,
        },
      })
    );

    if (taskRunError) {
      logger.error("[runFailed] Failed to find task run", {
        error: taskRunError,
        runId: run.id,
      });
      return;
    }

    const eventRepository = resolveEventRepositoryForStore(taskRun.taskEventStore);

    const [completeFailedRunEventError] = await tryCatch(
      eventRepository.completeFailedRunEvent({
        run: taskRun,
        endTime: time,
        exception,
      })
    );

    if (completeFailedRunEventError) {
      logger.error("[runFailed] Failed to complete failed run event", {
        error: completeFailedRunEventError,
        runId: run.id,
      });
    }
  });

  engine.eventBus.on("runAttemptFailed", async ({ time, run }) => {
    const sanitizedError = sanitizeError(run.error);
    const exception = createExceptionPropertiesFromError(sanitizedError);

    const [taskRunError, taskRun] = await tryCatch(
      $replica.taskRun.findFirstOrThrow({
        where: {
          id: run.id,
        },
        select: {
          id: true,
          friendlyId: true,
          traceId: true,
          spanId: true,
          parentSpanId: true,
          createdAt: true,
          completedAt: true,
          taskIdentifier: true,
          projectId: true,
          runtimeEnvironmentId: true,
          environmentType: true,
          isTest: true,
          organizationId: true,
          taskEventStore: true,
        },
      })
    );

    if (taskRunError) {
      logger.error("[runAttemptFailed] Failed to find task run", {
        error: taskRunError,
        runId: run.id,
      });
      return;
    }

    const eventRepository = resolveEventRepositoryForStore(taskRun.taskEventStore);

    const [createAttemptFailedRunEventError] = await tryCatch(
      eventRepository.createAttemptFailedRunEvent({
        run: taskRun,
        endTime: time,
        attemptNumber: run.attemptNumber,
        exception,
      })
    );

    if (createAttemptFailedRunEventError) {
      logger.error("[runAttemptFailed] Failed to create attempt failed run event", {
        error: createAttemptFailedRunEventError,
        runId: run.id,
      });
    }
  });

  engine.eventBus.on(
    "cachedRunCompleted",
    async ({ time, span, blockedRunId, hasError, cachedRunId }) => {
      const [parentSpanId, spanId] = span.id.split(":");

      if (!spanId || !parentSpanId) {
        logger.debug("[cachedRunCompleted] Invalid span id", {
          spanId,
          parentSpanId,
        });
        return;
      }

      const [cachedRunError, cachedRun] = await tryCatch(
        $replica.taskRun.findFirstOrThrow({
          where: {
            id: cachedRunId,
          },
          select: {
            id: true,
            friendlyId: true,
            traceId: true,
            spanId: true,
            parentSpanId: true,
            createdAt: true,
            completedAt: true,
            taskIdentifier: true,
            projectId: true,
            runtimeEnvironmentId: true,
            environmentType: true,
            isTest: true,
            organizationId: true,
          },
        })
      );

      if (cachedRunError) {
        logger.error("[cachedRunCompleted] Failed to find cached run", {
          error: cachedRunError,
          cachedRunId,
        });
        return;
      }

      const [blockedRunError, blockedRun] = await tryCatch(
        $replica.taskRun.findFirst({
          where: {
            id: blockedRunId,
          },
          select: {
            id: true,
            friendlyId: true,
            traceId: true,
            spanId: true,
            parentSpanId: true,
            createdAt: true,
            completedAt: true,
            taskIdentifier: true,
            projectId: true,
            runtimeEnvironmentId: true,
            environmentType: true,
            isTest: true,
            organizationId: true,
            taskEventStore: true,
          },
        })
      );

      if (blockedRunError) {
        logger.error("[cachedRunCompleted] Failed to find blocked run", {
          error: blockedRunError,
          blockedRunId,
        });
      }

      if (!blockedRun) {
        logger.error("[cachedRunCompleted] Blocked run not found", {
          blockedRunId,
        });
        return;
      }

      const eventRepository = resolveEventRepositoryForStore(blockedRun.taskEventStore);

      const [completeCachedRunEventError] = await tryCatch(
        eventRepository.completeCachedRunEvent({
          run: cachedRun,
          blockedRun,
          spanId,
          parentSpanId,
          spanCreatedAt: span.createdAt,
          isError: hasError,
          endTime: time,
        })
      );

      if (completeCachedRunEventError) {
        logger.error("[cachedRunCompleted] Failed to complete cached run event", {
          error: completeCachedRunEventError,
          cachedRunId,
        });
      }
    }
  );

  engine.eventBus.on("runExpired", async ({ time, run }) => {
    if (!run.ttl) {
      return;
    }

    const [taskRunError, taskRun] = await tryCatch(
      $replica.taskRun.findFirstOrThrow({
        where: {
          id: run.id,
        },
        select: {
          id: true,
          friendlyId: true,
          traceId: true,
          spanId: true,
          parentSpanId: true,
          createdAt: true,
          completedAt: true,
          taskIdentifier: true,
          projectId: true,
          runtimeEnvironmentId: true,
          environmentType: true,
          isTest: true,
          organizationId: true,
          taskEventStore: true,
        },
      })
    );

    if (taskRunError) {
      logger.error("[runExpired] Failed to find task run", {
        error: taskRunError,
        runId: run.id,
      });
      return;
    }

    const eventRepository = resolveEventRepositoryForStore(taskRun.taskEventStore);

    const [completeExpiredRunEventError] = await tryCatch(
      eventRepository.completeExpiredRunEvent({
        run: taskRun,
        endTime: time,
        ttl: run.ttl,
      })
    );

    if (completeExpiredRunEventError) {
      logger.error("[runExpired] Failed to complete expired run event", {
        error: completeExpiredRunEventError,
        runId: run.id,
      });
    }
  });

  engine.eventBus.on("runCancelled", async ({ time, run }) => {
    const [taskRunError, taskRun] = await tryCatch(
      $replica.taskRun.findFirstOrThrow({
        where: {
          id: run.id,
        },
        select: {
          id: true,
          friendlyId: true,
          traceId: true,
          spanId: true,
          parentSpanId: true,
          createdAt: true,
          completedAt: true,
          taskIdentifier: true,
          projectId: true,
          runtimeEnvironmentId: true,
          environmentType: true,
          isTest: true,
          organizationId: true,
          taskEventStore: true,
        },
      })
    );

    if (taskRunError) {
      logger.error("[runCancelled] Task run not found", {
        error: taskRunError,
        runId: run.id,
      });
      return;
    }

    const eventRepository = resolveEventRepositoryForStore(taskRun.taskEventStore);

    const error = createJsonErrorObject(run.error);

    const [cancelRunEventError] = await tryCatch(
      eventRepository.cancelRunEvent({
        reason: error.message,
        run: taskRun,
        cancelledAt: time,
      })
    );

    if (cancelRunEventError) {
      logger.error("[runCancelled] Failed to cancel run event", {
        error: cancelRunEventError,
        runId: run.id,
      });
    }
  });

  engine.eventBus.on("runRetryScheduled", async ({ time, run, environment, retryAt }) => {
    try {
      if (retryAt && time && time >= retryAt) {
        return;
      }

      let retryMessage = `Retry ${
        typeof run.attemptNumber === "number" ? `#${run.attemptNumber - 1}` : ""
      } delay`;

      if (run.nextMachineAfterOOM) {
        retryMessage += ` after OOM`;
      }

      const eventRepository = resolveEventRepositoryForStore(run.taskEventStore);

      await eventRepository.recordEvent(retryMessage, {
        startTime: BigInt(time.getTime() * 1000000),
        taskSlug: run.taskIdentifier,
        environment,
        attributes: {
          properties: {
            retryAt: retryAt.toISOString(),
            nextMachine: run.nextMachineAfterOOM,
          },
          runId: run.friendlyId,
          style: {
            icon: "schedule-attempt",
          },
        },
        context: run.traceContext as Record<string, string | undefined>,
        endTime: retryAt,
      });
    } catch (error) {
      logger.error("[runRetryScheduled] Failed to record retry event", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        spanId: run.spanId,
      });
    }
  });

  engine.eventBus.on("runAttemptStarted", async ({ time, run, organization }) => {
    try {
      if (run.attemptNumber === 1 && run.baseCostInCents > 0) {
        await reportInvocationUsage(organization.id, run.baseCostInCents, { runId: run.id });
      }
    } catch (error) {
      logger.error("[runAttemptStarted] Failed to report invocation usage", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        orgId: organization.id,
      });
    }
  });

  engine.eventBus.on("runMetadataUpdated", async ({ time, run }) => {
    const env = await findEnvironmentFromRun(run.id);

    if (!env) {
      logger.error("[runMetadataUpdated] Failed to find environment", { runId: run.id });
      return;
    }

    try {
      await updateMetadataService.call(run.id, run.metadata, env);
    } catch (e) {
      if (e instanceof MetadataTooLargeError) {
        logger.warn("[runMetadataUpdated] Failed to update metadata, too large", {
          taskRun: run.id,
          error:
            e instanceof Error
              ? {
                  name: e.name,
                  message: e.message,
                  stack: e.stack,
                }
              : e,
        });
      } else {
        logger.error("[runMetadataUpdated] Failed to update metadata", {
          taskRun: run.id,
          error:
            e instanceof Error
              ? {
                  name: e.name,
                  message: e.message,
                  stack: e.stack,
                }
              : e,
        });
      }
    }
  });

  engine.eventBus.on("executionSnapshotCreated", async ({ time, run, snapshot }) => {
    const eventResult = await recordRunDebugLog(
      run.id,
      `[engine] ${snapshot.executionStatus} - ${snapshot.description}`,
      {
        attributes: {
          properties: {
            snapshotId: snapshot.id,
            snapshotDescription: snapshot.description,
            snapshotStatus: snapshot.executionStatus,
            workerId: snapshot.workerId ?? undefined,
            runnerId: snapshot.runnerId ?? undefined,
          },
        },
        startTime: time,
      }
    );

    if (!eventResult.success) {
      logger.error("[executionSnapshotCreated] Failed to record event", {
        runId: run.id,
        snapshot,
        error: eventResult.error,
      });
    }
  });

  engine.eventBus.on("workerNotification", async ({ time, run, snapshot }) => {
    logger.debug("[workerNotification] Notifying worker", { time, runId: run.id, snapshot });

    // Notify the worker
    try {
      const runFriendlyId = RunId.toFriendlyId(run.id);
      const room = roomFromFriendlyRunId(runFriendlyId);

      //send the notification to connected workers
      socketIo.workerNamespace
        .to(room)
        .emit("run:notify", { version: "1", run: { friendlyId: runFriendlyId } });

      //send the notification to connected dev workers
      socketIo.devWorkerNamespace
        .to(room)
        .emit("run:notify", { version: "1", run: { friendlyId: runFriendlyId } });

      if (!env.RUN_ENGINE_DEBUG_WORKER_NOTIFICATIONS) {
        return;
      }

      // Record notification event
      const eventResult = await recordRunDebugLog(
        run.id,
        // don't prefix this with [engine] - "run:notify" is the correct prefix
        `run:notify platform -> supervisor: ${snapshot.executionStatus}`,
        {
          attributes: {
            properties: {
              snapshotId: snapshot.id,
              snapshotStatus: snapshot.executionStatus,
            },
          },
          startTime: time,
        }
      );

      if (!eventResult.success) {
        logger.error("[workerNotification] Failed to record event", {
          runId: run.id,
          snapshot,
          error: eventResult.error,
        });
      }
    } catch (error) {
      logger.error("[workerNotification] Failed to notify worker", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        snapshot,
      });

      // Record notification event
      const eventResult = await recordRunDebugLog(
        run.id,
        // don't prefix this with [engine] - "run:notify" is the correct prefix
        `run:notify ERROR platform -> supervisor: ${snapshot.executionStatus}`,
        {
          attributes: {
            properties: {
              snapshotId: snapshot.id,
              snapshotStatus: snapshot.executionStatus,
              error: error instanceof Error ? error.message : String(error),
            },
          },
          startTime: time,
        }
      );

      if (!eventResult.success) {
        logger.error("[workerNotification] Failed to record event", {
          runId: run.id,
          snapshot,
          error: eventResult.error,
        });
      }
    }
  });

  engine.eventBus.on("incomingCheckpointDiscarded", async ({ time, run, snapshot, checkpoint }) => {
    const eventResult = await recordRunDebugLog(
      run.id,
      `[engine] Checkpoint discarded: ${checkpoint.discardReason}`,
      {
        attributes: {
          properties: {
            snapshotId: snapshot.id,
            ...checkpoint.metadata,
          },
        },
        startTime: time,
      }
    );

    if (!eventResult.success) {
      logger.error("[incomingCheckpointDiscarded] Failed to record event", {
        runId: run.id,
        snapshot,
        error: eventResult.error,
      });
    }
  });
}

/**
 * Set up the BatchQueue processing callbacks.
 * These handle creating runs from batch items and completing batches.
 *
 * Payload handling:
 * - If payloadType is "application/store", the payload is an R2 path (already offloaded)
 * - DefaultPayloadProcessor in TriggerTaskService will pass it through without re-offloading
 * - The run engine will download from R2 when the task executes
 */
export function setupBatchQueueCallbacks() {
  // Item processing callback - creates a run for each batch item
  engine.setBatchProcessItemCallback(async ({ batchId, friendlyId, itemIndex, item, meta }) => {
    return tracer.startActiveSpan(
      "batch.processItem",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "batch.id": friendlyId,
          "batch.item_index": itemIndex,
          "batch.task": item.task,
          "batch.environment_id": meta.environmentId,
          "batch.parent_run_id": meta.parentRunId ?? "",
        },
      },
      async (span) => {
        try {
          const triggerTaskService = new TriggerTaskService();

          // Normalize payload - for application/store (R2 paths), this passes through as-is
          const payload = normalizePayload(item.payload, item.payloadType);

          const result = await triggerTaskService.call(
            item.task,
            {
              id: meta.environmentId,
              type: meta.environmentType,
              organizationId: meta.organizationId,
              projectId: meta.projectId,
              organization: { id: meta.organizationId },
              project: { id: meta.projectId },
            } as AuthenticatedEnvironment,
            {
              payload,
              options: {
                ...(item.options as Record<string, unknown>),
                payloadType: item.payloadType,
                parentRunId: meta.parentRunId,
                resumeParentOnCompletion: meta.resumeParentOnCompletion,
                parentBatch: batchId,
              },
            },
            {
              triggerVersion: meta.triggerVersion,
              traceContext: meta.traceContext as Record<string, unknown> | undefined,
              spanParentAsLink: meta.spanParentAsLink,
              batchId,
              batchIndex: itemIndex,
              skipChecks: true, // Already validated at batch level
              realtimeStreamsVersion: meta.realtimeStreamsVersion,
            },
            "V2"
          );

          if (result) {
            span.setAttribute("batch.result.run_id", result.run.friendlyId);
            span.end();
            return { success: true as const, runId: result.run.friendlyId };
          } else {
            span.setAttribute("batch.result.error", "TriggerTaskService returned undefined");
            span.end();
            return {
              success: false as const,
              error: "TriggerTaskService returned undefined",
              errorCode: "TRIGGER_FAILED",
            };
          }
        } catch (error) {
          span.setAttribute(
            "batch.result.error",
            error instanceof Error ? error.message : String(error)
          );
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.end();
          return {
            success: false as const,
            error: error instanceof Error ? error.message : String(error),
            errorCode: "TRIGGER_ERROR",
          };
        }
      }
    );
  });

  // Batch completion callback - updates Postgres with results
  engine.setBatchCompletionCallback(async (result: CompleteBatchResult) => {
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

    try {
      // Update BatchTaskRun
      await prisma.batchTaskRun.update({
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

      // Create error records if there were failures
      if (failures.length > 0) {
        for (const failure of failures) {
          await prisma.batchTaskRunError.create({
            data: {
              batchTaskRunId: batchId,
              index: failure.index,
              taskIdentifier: failure.taskIdentifier,
              payload: failure.payload,
              options: failure.options as Prisma.InputJsonValue | undefined,
              error: failure.error,
              errorCode: failure.errorCode,
            },
          });
        }
      }

      // Try to complete the batch (handles waitpoint completion if all runs are done)
      if (status !== "ABORTED") {
        await engine.tryCompleteBatch({ batchId });
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
    }
  });

  logger.info("BatchQueue callbacks configured");
}

/**
 * Normalize the payload from BatchQueue.
 *
 * Handles different payload types:
 * - "application/store": Already offloaded to R2, payload is the path - pass through as-is
 * - "application/json": May be a pre-serialized JSON string - parse to avoid double-stringification
 * - Other types: Pass through as-is
 *
 * @param payload - The raw payload from the batch item
 * @param payloadType - The payload type (e.g., "application/json", "application/store")
 */
function normalizePayload(payload: unknown, payloadType?: string): unknown {
  // For non-JSON payloads (including application/store for R2-offloaded payloads),
  // return as-is - no normalization needed
  if (payloadType !== "application/json" && payloadType !== undefined) {
    return payload;
  }

  // For JSON payloads, if payload is a string, try to parse it
  // This handles pre-serialized JSON from the SDK
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      // If it's not valid JSON, return as-is
      return payload;
    }
  }

  return payload;
}
