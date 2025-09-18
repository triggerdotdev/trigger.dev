import { tryCatch } from "@trigger.dev/core/utils";
import { createJsonErrorObject, sanitizeError } from "@trigger.dev/core/v3";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findEnvironmentFromRun } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { reportInvocationUsage } from "~/services/platform.v3.server";
import { MetadataTooLargeError } from "~/utils/packets";
import {
  createExceptionPropertiesFromError,
  eventRepository,
  recordRunDebugLog,
} from "./eventRepository.server";
import { roomFromFriendlyRunId, socketIo } from "./handleSocketIo.server";
import { engine } from "./runEngine.server";
import { PerformTaskRunAlertsService } from "./services/alerts/performTaskRunAlerts.server";
import { getTaskEventStoreTableForRun } from "./taskEventStore.server";

export function registerRunEngineEventBusHandlers() {
  engine.eventBus.on("runSucceeded", async ({ time, run }) => {
    const [taskRunError, taskRun] = await tryCatch(
      $replica.taskRun.findFirst({
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

    if (!taskRun) {
      logger.error("[runSucceeded] Task run not found", {
        runId: run.id,
      });
      return;
    }

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
      $replica.taskRun.findFirst({
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

    if (!taskRun) {
      logger.error("[runFailed] Task run not found", {
        runId: run.id,
      });
      return;
    }

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
      $replica.taskRun.findFirst({
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

    if (!taskRun) {
      logger.error("[runAttemptFailed] Task run not found", {
        runId: run.id,
      });
      return;
    }

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

  engine.eventBus.on("cachedRunCompleted", async ({ time, span, blockedRunId, hasError }) => {
    try {
      const blockedRun = await $replica.taskRun.findFirst({
        select: {
          taskEventStore: true,
        },
        where: {
          id: blockedRunId,
        },
      });

      if (!blockedRun) {
        logger.error("[cachedRunCompleted] Blocked run not found", {
          blockedRunId,
        });
        return;
      }

      const eventStore = getTaskEventStoreTableForRun(blockedRun);

      const completedEvent = await eventRepository.completeEvent(
        eventStore,
        span.id,
        span.createdAt,
        time,
        {
          endTime: time,
          attributes: {
            isError: hasError,
          },
        }
      );

      if (!completedEvent) {
        logger.error("[cachedRunCompleted] Failed to complete event for unknown reason", {
          span,
        });
        return;
      }
    } catch (error) {
      logger.error("[cachedRunCompleted] Failed to complete event for unknown reason", {
        error: error instanceof Error ? error.message : error,
        span,
      });
    }
  });

  engine.eventBus.on("runExpired", async ({ time, run }) => {
    try {
      const eventStore = getTaskEventStoreTableForRun(run);

      const completedEvent = await eventRepository.completeEvent(
        eventStore,
        run.spanId,
        run.createdAt,
        run.completedAt ?? undefined,
        {
          endTime: time,
          attributes: {
            isError: true,
          },
          events: [
            {
              name: "exception",
              time,
              properties: {
                exception: {
                  message: `Run expired because the TTL (${run.ttl}) was reached`,
                },
              },
            },
          ],
        }
      );

      if (!completedEvent) {
        logger.error("[runFailed] Failed to complete event for unknown reason", {
          runId: run.id,
          spanId: run.spanId,
        });
        return;
      }
    } catch (error) {
      logger.error("[runExpired] Failed to complete event", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        spanId: run.spanId,
      });
    }
  });

  engine.eventBus.on("runCancelled", async ({ time, run }) => {
    try {
      const taskRun = await $replica.taskRun.findFirst({
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
        },
      });

      if (!taskRun) {
        logger.error("[runCancelled] Task run not found", {
          runId: run.id,
        });
        return;
      }

      const error = createJsonErrorObject(run.error);

      await eventRepository.cancelRunEvent({
        reason: error.message,
        run: taskRun,
        cancelledAt: time,
      });
    } catch (error) {
      logger.error("[runCancelled] Failed to cancel event", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        spanId: run.spanId,
      });
    }
  });

  engine.eventBus.on("runRetryScheduled", async ({ time, run, environment, retryAt }) => {
    try {
      let retryMessage = `Retry #${run.attemptNumber} delay`;

      if (run.nextMachineAfterOOM) {
        retryMessage += ` after OOM`;
      }

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
          queueName: run.queue,
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
