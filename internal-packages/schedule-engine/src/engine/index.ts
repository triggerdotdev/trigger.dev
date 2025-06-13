import { getMeter, Meter, startSpan, Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { PrismaClient } from "@trigger.dev/database";
import { Worker } from "@trigger.dev/redis-worker";
import { calculateDistributedExecutionTime } from "./distributedScheduling.js";
import { calculateNextScheduledTimestamp, nextScheduledTimestamps } from "./scheduleCalculation.js";
import {
  RegisterScheduleInstanceParams,
  ScheduleEngineOptions,
  TriggerScheduleParams,
} from "./types.js";
import { scheduleWorkerCatalog } from "./workerCatalog.js";
import { tryCatch } from "@trigger.dev/core/utils";

export class ScheduleEngine {
  private worker: Worker<typeof scheduleWorkerCatalog>;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;
  private distributionWindowSeconds: number;

  prisma: PrismaClient;

  constructor(private readonly options: ScheduleEngineOptions) {
    this.logger =
      options.logger ?? new Logger("ScheduleEngine", (this.options.logLevel ?? "info") as any);
    this.prisma = options.prisma;
    this.distributionWindowSeconds = options.distributionWindow?.seconds ?? 30;

    this.worker = new Worker({
      name: "schedule-engine-worker",
      redisOptions: {
        ...options.redis,
        keyPrefix: `${options.redis.keyPrefix ?? ""}schedule:`,
      },
      catalog: scheduleWorkerCatalog,
      concurrency: {
        limit: options.worker.concurrency,
      },
      pollIntervalMs: options.worker.pollIntervalMs,
      shutdownTimeoutMs: options.worker.shutdownTimeoutMs,
      logger: new Logger("ScheduleEngineWorker", "debug"),
      jobs: {
        "schedule.triggerScheduledTask": async ({ payload }) => {
          await this.triggerScheduledTask({
            instanceId: payload.instanceId,
            finalAttempt: false, // TODO: implement retry logic
            exactScheduleTime: payload.exactScheduleTime,
          });
        },
      },
    });

    if (!options.worker.disabled) {
      this.worker.start();
    }

    this.tracer = options.tracer ?? (startSpan as any).tracer;
    this.meter = options.meter ?? getMeter("schedule-engine");
  }

  /**
   * Registers the next scheduled instance for a schedule
   */
  async registerNextTaskScheduleInstance(params: RegisterScheduleInstanceParams) {
    return startSpan(this.tracer, "registerNextTaskScheduleInstance", async (span) => {
      span.setAttribute("instanceId", params.instanceId);

      const instance = await this.prisma.taskScheduleInstance.findFirst({
        where: {
          id: params.instanceId,
        },
        include: {
          taskSchedule: true,
          environment: true,
        },
      });

      if (!instance) {
        return;
      }

      span.setAttribute("task_schedule_id", instance.taskSchedule.id);
      span.setAttribute("task_schedule_instance_id", instance.id);
      span.setAttribute(
        "task_schedule_generator_expression",
        instance.taskSchedule.generatorExpression
      );
      span.setAttribute(
        "last_scheduled_timestamp",
        instance.lastScheduledTimestamp?.toISOString() ?? new Date().toISOString()
      );

      const nextScheduledTimestamp = calculateNextScheduledTimestamp(
        instance.taskSchedule.generatorExpression,
        instance.taskSchedule.timezone,
        instance.lastScheduledTimestamp ?? new Date()
      );

      await this.prisma.taskScheduleInstance.update({
        where: {
          id: params.instanceId,
        },
        data: {
          nextScheduledTimestamp,
        },
      });

      // Enqueue the scheduled task
      await this.enqueueScheduledTask(params.instanceId, nextScheduledTimestamp);
    });
  }

  /**
   * Triggers a scheduled task (called by the Redis worker)
   */
  async triggerScheduledTask(params: TriggerScheduleParams) {
    return startSpan(this.tracer, "triggerScheduledTask", async (span) => {
      span.setAttribute("instanceId", params.instanceId);
      span.setAttribute("finalAttempt", params.finalAttempt);

      const instance = await this.prisma.taskScheduleInstance.findFirst({
        where: {
          id: params.instanceId,
        },
        include: {
          taskSchedule: true,
          environment: {
            include: {
              project: true,
              organization: true,
            },
          },
        },
      });

      if (!instance) {
        this.logger.debug("Schedule instance not found", {
          instanceId: params.instanceId,
        });
        return;
      }

      // Check if organization/project/environment is still valid
      if (instance.environment.organization.deletedAt) {
        this.logger.debug("Organization is deleted, skipping schedule", {
          instanceId: params.instanceId,
          scheduleId: instance.taskSchedule.friendlyId,
          organizationId: instance.environment.organization.id,
        });
        return;
      }

      if (instance.environment.project.deletedAt) {
        this.logger.debug("Project is deleted, skipping schedule", {
          instanceId: params.instanceId,
          scheduleId: instance.taskSchedule.friendlyId,
          projectId: instance.environment.project.id,
        });
        return;
      }

      if (instance.environment.archivedAt) {
        this.logger.debug("Environment is archived, skipping schedule", {
          instanceId: params.instanceId,
          scheduleId: instance.taskSchedule.friendlyId,
          environmentId: instance.environment.id,
        });
        return;
      }

      let shouldTrigger = true;

      if (!instance.active || !instance.taskSchedule.active) {
        this.logger.debug("Schedule is inactive", {
          instanceId: params.instanceId,
          instanceActive: instance.active,
          scheduleActive: instance.taskSchedule.active,
        });
        shouldTrigger = false;
      }

      if (!instance.nextScheduledTimestamp) {
        this.logger.debug("No next scheduled timestamp", {
          instanceId: params.instanceId,
        });
        shouldTrigger = false;
      }

      // For development environments, check if there's an active session
      if (instance.environment.type === "DEVELOPMENT") {
        const [devConnectedError, isConnected] = await tryCatch(
          this.options.isDevEnvironmentConnectedHandler(instance.environment.id)
        );

        if (devConnectedError) {
          this.logger.error("Error checking if development environment is connected", {
            instanceId: params.instanceId,
            error: devConnectedError,
          });
          shouldTrigger = false;
        } else if (!isConnected) {
          this.logger.debug("Development environment is disconnected", {
            instanceId: params.instanceId,
          });
          shouldTrigger = false;
        }
      }

      if (shouldTrigger) {
        const scheduleTimestamp =
          params.exactScheduleTime ?? instance.nextScheduledTimestamp ?? new Date();

        const payload = {
          scheduleId: instance.taskSchedule.friendlyId,
          type: instance.taskSchedule.type as "DECLARATIVE" | "IMPERATIVE",
          timestamp: scheduleTimestamp,
          lastTimestamp: instance.lastScheduledTimestamp ?? undefined,
          externalId: instance.taskSchedule.externalId ?? undefined,
          timezone: instance.taskSchedule.timezone,
          upcoming: nextScheduledTimestamps(
            instance.taskSchedule.generatorExpression,
            instance.taskSchedule.timezone,
            scheduleTimestamp,
            10
          ),
        };

        this.logger.debug("Triggering scheduled task", {
          instanceId: params.instanceId,
          taskIdentifier: instance.taskSchedule.taskIdentifier,
          scheduleTimestamp: scheduleTimestamp?.toISOString(),
        });

        // Rewritten try/catch to use tryCatch utility
        const [triggerError, result] = await tryCatch(
          this.options.onTriggerScheduledTask({
            taskIdentifier: instance.taskSchedule.taskIdentifier,
            environment: instance.environment,
            payload,
            scheduleInstanceId: instance.id,
            scheduleId: instance.taskSchedule.id,
            exactScheduleTime: params.exactScheduleTime,
          })
        );

        if (triggerError) {
          this.logger.error("Error calling trigger callback", {
            instanceId: params.instanceId,
            taskIdentifier: instance.taskSchedule.taskIdentifier,
            error: triggerError instanceof Error ? triggerError.message : String(triggerError),
          });
        } else if (result) {
          if (result.success) {
            // Update the last run triggered timestamp
            await this.prisma.taskSchedule.update({
              where: {
                id: instance.taskSchedule.id,
              },
              data: {
                lastRunTriggeredAt: new Date(),
              },
            });

            this.logger.debug("Successfully triggered scheduled task", {
              instanceId: params.instanceId,
              taskIdentifier: instance.taskSchedule.taskIdentifier,
            });
          } else {
            this.logger.error("Failed to trigger scheduled task", {
              instanceId: params.instanceId,
              taskIdentifier: instance.taskSchedule.taskIdentifier,
              error: result.error,
            });
          }
        }
      } else {
        this.logger.debug("Skipping task trigger due to conditions", {
          instanceId: params.instanceId,
        });
      }

      // Always update the last scheduled timestamp and register next run
      await this.prisma.taskScheduleInstance.update({
        where: {
          id: params.instanceId,
        },
        data: {
          lastScheduledTimestamp: instance.nextScheduledTimestamp,
        },
      });

      // Register the next run
      // Rewritten try/catch to use tryCatch utility
      const [nextRunError] = await tryCatch(
        this.registerNextTaskScheduleInstance({ instanceId: params.instanceId })
      );
      if (nextRunError) {
        this.logger.error("Failed to schedule next run after execution", {
          instanceId: params.instanceId,
          error: nextRunError instanceof Error ? nextRunError.message : String(nextRunError),
        });

        if (!params.finalAttempt) {
          throw nextRunError;
        }
      }
    });
  }

  /**
   * Enqueues a scheduled task with distributed execution timing
   */
  private async enqueueScheduledTask(instanceId: string, exactScheduleTime: Date) {
    const distributedExecutionTime = calculateDistributedExecutionTime(
      exactScheduleTime,
      this.distributionWindowSeconds
    );

    this.logger.debug("Enqueuing scheduled task with distributed execution", {
      instanceId,
      exactScheduleTime: exactScheduleTime.toISOString(),
      distributedExecutionTime: distributedExecutionTime.toISOString(),
      distributionOffsetMs: exactScheduleTime.getTime() - distributedExecutionTime.getTime(),
    });

    await this.worker.enqueue({
      id: `scheduled-task-instance:${instanceId}`,
      job: "schedule.triggerScheduledTask",
      payload: {
        instanceId,
        exactScheduleTime,
      },
      availableAt: distributedExecutionTime,
    });
  }

  async quit() {
    await this.worker.stop();
  }
}
