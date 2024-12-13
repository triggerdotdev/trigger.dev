import { prisma } from "~/db.server";
import { createExceptionPropertiesFromError, eventRepository } from "./eventRepository.server";
import { createJsonErrorObject, sanitizeError } from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";
import type { Attributes } from "@opentelemetry/api";
import { reportInvocationUsage } from "~/services/platform.v3.server";
import { socketIo } from "./handleSocketIo.server";
import { engine } from "./runEngine.server";
import { PerformTaskRunAlertsService } from "./services/alerts/performTaskRunAlerts.server";

export function registerRunEngineEventBusHandlers() {
  engine.eventBus.on("runSucceeded", async ({ time, run }) => {
    try {
      const completedEvent = await eventRepository.completeEvent(run.spanId, {
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
      });

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
      await PerformTaskRunAlertsService.enqueue(run.id, prisma);
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

      const completedEvent = await eventRepository.completeEvent(run.spanId, {
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
      });

      if (!completedEvent) {
        logger.error("[runFailed] Failed to complete event for unknown reason", {
          runId: run.id,
          spanId: run.spanId,
        });
        return;
      }

      const inProgressEvents = await eventRepository.queryIncompleteEvents({
        runId: completedEvent?.runId,
      });

      await Promise.all(
        inProgressEvents.map((event) => {
          try {
            const completedEvent = eventRepository.completeEvent(event.spanId, {
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
            });

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

  engine.eventBus.on("runExpired", async ({ time, run }) => {
    try {
      const completedEvent = await eventRepository.completeEvent(run.spanId, {
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
      });

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
      const inProgressEvents = await eventRepository.queryIncompleteEvents({
        runId: run.friendlyId,
      });

      await Promise.all(
        inProgressEvents.map((event) => {
          const error = createJsonErrorObject(run.error);
          return eventRepository.cancelEvent(event, time, error.message);
        })
      );
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
      await eventRepository.recordEvent(`Retry #${run.attemptNumber} delay`, {
        taskSlug: run.taskIdentifier,
        environment,
        attributes: {
          properties: {
            retryAt: retryAt.toISOString(),
          },
          runId: run.friendlyId,
          style: {
            icon: "schedule-attempt",
          },
          queueName: run.queue,
        },
        context: run.traceContext as Record<string, string | undefined>,
        spanIdSeed: `retry-${run.attemptNumber + 1}`,
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

  engine.eventBus.on("runRetryScheduled", async ({ time, run, organization }) => {
    try {
      if (run.attemptNumber === 1 && run.baseCostInCents > 0) {
        await reportInvocationUsage(organization.id, run.baseCostInCents, { runId: run.id });
      }
    } catch (error) {
      logger.error("[runRetryScheduled] Failed to report invocation usage", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
        orgId: organization.id,
      });
    }
  });

  engine.eventBus.on("executionSnapshotCreated", async ({ time, run, snapshot }) => {
    try {
      const foundRun = await prisma.taskRun.findUnique({
        where: {
          id: run.id,
        },
        include: {
          runtimeEnvironment: {
            include: {
              project: true,
              organization: true,
            },
          },
        },
      });

      if (!foundRun) {
        logger.error("Failed to find run", { runId: run.id });
        return;
      }

      await eventRepository.recordEvent(
        `[ExecutionSnapshot] ${snapshot.executionStatus} - ${snapshot.description}`,
        {
          environment: foundRun.runtimeEnvironment,
          taskSlug: foundRun.taskIdentifier,
          context: foundRun.traceContext as Record<string, string | undefined>,
          attributes: {
            runId: foundRun.friendlyId,
            isDebug: true,
            properties: {
              snapshotId: snapshot.id,
              snapshotDescription: snapshot.description,
              snapshotStatus: snapshot.executionStatus,
            },
          },
          duration: 0,
        }
      );
    } catch (error) {
      logger.error("[executionSnapshotCreated] Failed to record event", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
      });
    }
  });

  engine.eventBus.on("workerNotification", async ({ time, run }) => {
    logger.debug("[workerNotification] Notifying worker", { time, runId: run.id });

    try {
      // TODO: re-enable this
      // socketIo.workerNamespace.to(`run:${run.id}`).emit("run:notify", { version: "1", run });
    } catch (error) {
      logger.error("[workerNotification] Failed to notify worker", {
        error: error instanceof Error ? error.message : error,
        runId: run.id,
      });
    }
  });
}
