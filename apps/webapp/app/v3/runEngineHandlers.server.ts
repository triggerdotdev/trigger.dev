import { $replica, prisma } from "~/db.server";
import {
  createExceptionPropertiesFromError,
  eventRepository,
  recordRunDebugLog,
} from "./eventRepository.server";
import { createJsonErrorObject, sanitizeError } from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";
import type { Attributes } from "@opentelemetry/api";
import { reportInvocationUsage } from "~/services/platform.v3.server";
import { roomFromFriendlyRunId, socketIo } from "./handleSocketIo.server";
import { engine } from "./runEngine.server";
import { PerformTaskRunAlertsService } from "./services/alerts/performTaskRunAlerts.server";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { findEnvironmentFromRun } from "~/models/runtimeEnvironment.server";
import { env } from "~/env.server";
import { getTaskEventStoreTableForRun } from "./taskEventStore.server";
import { MetadataTooLargeError } from "~/utils/packets";

export function registerRunEngineEventBusHandlers() {
  engine.eventBus.on("runSucceeded", async ({ time, run }) => {
    try {
      const completedEvent = await eventRepository.completeEvent(
        getTaskEventStoreTableForRun(run),
        run.spanId,
        run.createdAt,
        run.completedAt ?? undefined,
        {
          endTime: time,
          attributes: {
            isError: false,
            output:
              run.outputType === "application/store" || run.outputType === "text/plain"
                ? run.output
                : run.output
                ? (safeJsonParse(run.output) as Attributes)
                : undefined,
            outputType: run.outputType,
          },
        }
      );

      if (!completedEvent) {
        logger.error("[runSucceeded] Failed to complete event for unknown reason", {
          runId: run.id,
          spanId: run.spanId,
        });
        return;
      }
    } catch (error) {
      logger.error("[runSucceeded] Failed to complete event", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        spanId: run.spanId,
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
    try {
      const sanitizedError = sanitizeError(run.error);
      const exception = createExceptionPropertiesFromError(sanitizedError);

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
                exception,
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

      const inProgressEvents = await eventRepository.queryIncompleteEvents(
        eventStore,
        {
          runId: completedEvent?.runId,
        },
        run.createdAt,
        run.completedAt ?? undefined
      );

      await Promise.all(
        inProgressEvents.map((event) => {
          try {
            const completedEvent = eventRepository.completeEvent(
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
                      exception,
                    },
                  },
                ],
              }
            );

            if (!completedEvent) {
              logger.error("[runFailed] Failed to complete in-progress event for unknown reason", {
                runId: run.id,
                spanId: run.spanId,
                eventId: event.id,
              });
              return;
            }
          } catch (error) {
            logger.error("[runFailed] Failed to complete in-progress event", {
              error: error instanceof Error ? error.message : error,
              runId: run.id,
              spanId: run.spanId,
              eventId: event.id,
            });
          }
        })
      );
    } catch (error) {
      logger.error("[runFailed] Failed to complete event", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        spanId: run.spanId,
      });
    }
  });

  engine.eventBus.on("runAttemptFailed", async ({ time, run }) => {
    try {
      const sanitizedError = sanitizeError(run.error);
      const exception = createExceptionPropertiesFromError(sanitizedError);
      const eventStore = getTaskEventStoreTableForRun(run);

      const inProgressEvents = await eventRepository.queryIncompleteEvents(
        eventStore,
        {
          runId: RunId.toFriendlyId(run.id),
          spanId: {
            not: run.spanId,
          },
        },
        run.createdAt,
        run.completedAt ?? undefined
      );

      await Promise.all(
        inProgressEvents.map((event) => {
          return eventRepository.crashEvent({
            event: event,
            crashedAt: time,
            exception,
          });
        })
      );
    } catch (error) {
      logger.error("[runAttemptFailed] Failed to complete event", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        spanId: run.spanId,
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
        include: {
          project: {
            select: {
              externalRef: true,
            },
          },
          runtimeEnvironment: {
            select: {
              type: true,
              organizationId: true,
            },
          },
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
        projectRef: taskRun.project.externalRef,
        organizationId: taskRun.runtimeEnvironment.organizationId,
        environmentType: taskRun.runtimeEnvironment.type,
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
