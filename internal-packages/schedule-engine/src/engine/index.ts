import {
  Counter,
  getMeter,
  getTracer,
  Histogram,
  Meter,
  startSpan,
  Tracer,
} from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { PrismaClient } from "@trigger.dev/database";
import { Worker, type JobHandlerParams } from "@trigger.dev/redis-worker";
import { calculateDistributedExecutionTime } from "./distributedScheduling.js";
import { calculateNextScheduledTimestamp, nextScheduledTimestamps } from "./scheduleCalculation.js";
import {
  RegisterScheduleInstanceParams,
  ScheduleEngineOptions,
  TriggerScheduledTaskCallback,
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

  // Metrics
  private scheduleRegistrationCounter: Counter;
  private scheduleExecutionCounter: Counter;
  private scheduleExecutionDuration: Histogram;
  private scheduleExecutionFailureCounter: Counter;
  private distributionOffsetHistogram: Histogram;
  private devEnvironmentCheckCounter: Counter;

  prisma: PrismaClient;

  private onTriggerScheduledTask: TriggerScheduledTaskCallback;

  constructor(private readonly options: ScheduleEngineOptions) {
    this.logger =
      options.logger ?? new Logger("ScheduleEngine", (this.options.logLevel ?? "info") as any);
    this.prisma = options.prisma;
    this.distributionWindowSeconds = options.distributionWindow?.seconds ?? 30;
    this.onTriggerScheduledTask = options.onTriggerScheduledTask;

    this.tracer = options.tracer ?? getTracer("schedule-engine");
    this.meter = options.meter ?? getMeter("schedule-engine");

    // Initialize metrics
    this.scheduleRegistrationCounter = this.meter.createCounter("schedule_registrations_total", {
      description: "Total number of schedule registrations",
    });

    this.scheduleExecutionCounter = this.meter.createCounter("schedule_executions_total", {
      description: "Total number of schedule executions",
    });

    this.scheduleExecutionDuration = this.meter.createHistogram("schedule_execution_duration_ms", {
      description: "Duration of schedule execution in milliseconds",
      unit: "ms",
    });

    this.scheduleExecutionFailureCounter = this.meter.createCounter(
      "schedule_execution_failures_total",
      {
        description: "Total number of schedule execution failures",
      }
    );

    this.distributionOffsetHistogram = this.meter.createHistogram(
      "schedule_distribution_offset_ms",
      {
        description: "Distribution offset from exact schedule time in milliseconds",
        unit: "ms",
      }
    );

    this.devEnvironmentCheckCounter = this.meter.createCounter("dev_environment_checks_total", {
      description: "Total number of development environment connectivity checks",
    });

    this.worker = new Worker({
      name: "schedule-engine-worker",
      redisOptions: {
        ...options.redis,
        keyPrefix: `${options.redis.keyPrefix ?? ""}schedule:`,
      },
      catalog: scheduleWorkerCatalog,
      concurrency: {
        limit: options.worker.concurrency,
        workers: options.worker.workers,
        tasksPerWorker: options.worker.tasksPerWorker,
      },
      pollIntervalMs: options.worker.pollIntervalMs,
      shutdownTimeoutMs: options.worker.shutdownTimeoutMs,
      logger: new Logger("ScheduleEngineWorker", (options.logLevel ?? "info") as any),
      jobs: {
        "schedule.triggerScheduledTask": this.#handleTriggerScheduledTaskJob.bind(this),
      },
    });

    if (!options.worker.disabled) {
      this.worker.start();
      this.logger.info("Schedule engine worker started", {
        concurrency: options.worker.concurrency,
        pollIntervalMs: options.worker.pollIntervalMs,
        distributionWindowSeconds: this.distributionWindowSeconds,
      });
    } else {
      this.logger.info("Schedule engine worker disabled");
    }
  }

  /**
   * Registers the next scheduled instance for a schedule
   */
  async registerNextTaskScheduleInstance(params: RegisterScheduleInstanceParams) {
    return startSpan(this.tracer, "registerNextTaskScheduleInstance", async (span) => {
      const startTime = Date.now();

      if (this.options.onRegisterScheduleInstance) {
        const [registerError] = await tryCatch(
          this.options.onRegisterScheduleInstance(params.instanceId)
        );

        if (registerError) {
          this.logger.error("Error calling the onRegisterScheduleInstance callback", {
            instanceId: params.instanceId,
            error: registerError,
          });
        }
      }

      span.setAttribute("instanceId", params.instanceId);

      this.logger.debug("Starting schedule registration", {
        instanceId: params.instanceId,
      });

      try {
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
          this.logger.warn("Schedule instance not found during registration", {
            instanceId: params.instanceId,
          });
          span.setAttribute("error", "instance_not_found");
          return;
        }

        span.setAttribute("task_schedule_id", instance.taskSchedule.id);
        span.setAttribute("task_schedule_instance_id", instance.id);
        span.setAttribute("task_identifier", instance.taskSchedule.taskIdentifier);
        span.setAttribute("environment_type", instance.environment.type);
        span.setAttribute("schedule_active", instance.active);
        span.setAttribute("task_schedule_active", instance.taskSchedule.active);
        span.setAttribute(
          "task_schedule_generator_expression",
          instance.taskSchedule.generatorExpression
        );

        const lastScheduledTimestamp = instance.lastScheduledTimestamp ?? new Date();
        span.setAttribute("last_scheduled_timestamp", lastScheduledTimestamp.toISOString());

        const nextScheduledTimestamp = calculateNextScheduledTimestamp(
          instance.taskSchedule.generatorExpression,
          instance.taskSchedule.timezone,
          lastScheduledTimestamp
        );

        span.setAttribute("next_scheduled_timestamp", nextScheduledTimestamp.toISOString());

        const schedulingDelayMs = nextScheduledTimestamp.getTime() - Date.now();
        span.setAttribute("scheduling_delay_ms", schedulingDelayMs);

        this.logger.info("Calculated next schedule timestamp", {
          instanceId: params.instanceId,
          taskIdentifier: instance.taskSchedule.taskIdentifier,
          nextScheduledTimestamp: nextScheduledTimestamp.toISOString(),
          schedulingDelayMs,
          generatorExpression: instance.taskSchedule.generatorExpression,
          timezone: instance.taskSchedule.timezone,
        });

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

        // Record metrics
        this.scheduleRegistrationCounter.add(1, {
          environment_type: instance.environment.type,
          schedule_type: instance.taskSchedule.type,
        });

        const duration = Date.now() - startTime;
        this.logger.debug("Schedule registration completed", {
          instanceId: params.instanceId,
          durationMs: duration,
        });

        span.setAttribute("success", true);
        span.setAttribute("duration_ms", duration);
      } catch (error) {
        const duration = Date.now() - startTime;
        this.logger.error("Failed to register schedule instance", {
          instanceId: params.instanceId,
          durationMs: duration,
          error: error instanceof Error ? error.message : String(error),
        });

        span.setAttribute("error", true);
        span.setAttribute("error_message", error instanceof Error ? error.message : String(error));
        span.setAttribute("duration_ms", duration);

        throw error;
      }
    });
  }

  async #handleTriggerScheduledTaskJob({
    payload,
  }: JobHandlerParams<typeof scheduleWorkerCatalog, "schedule.triggerScheduledTask">) {
    await this.triggerScheduledTask({
      instanceId: payload.instanceId,
      finalAttempt: false, // TODO: implement retry logic
      exactScheduleTime: payload.exactScheduleTime,
    });
  }

  /**
   * Triggers a scheduled task (called by the Redis worker)
   */
  async triggerScheduledTask(params: TriggerScheduleParams) {
    return startSpan(this.tracer, "triggerScheduledTask", async (span) => {
      const startTime = Date.now();

      span.setAttribute("instanceId", params.instanceId);
      span.setAttribute("finalAttempt", params.finalAttempt);
      if (params.exactScheduleTime) {
        span.setAttribute("exactScheduleTime", params.exactScheduleTime.toISOString());
      }

      this.logger.debug("Starting scheduled task trigger", {
        instanceId: params.instanceId,
        finalAttempt: params.finalAttempt,
        exactScheduleTime: params.exactScheduleTime?.toISOString(),
      });

      let taskIdentifier: string | undefined;
      let environmentType: string | undefined;
      let scheduleType: string | undefined;

      try {
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
                orgMember: true,
              },
            },
          },
        });

        if (!instance) {
          this.logger.debug("Schedule instance not found", {
            instanceId: params.instanceId,
          });
          span.setAttribute("error", "instance_not_found");
          return;
        }

        taskIdentifier = instance.taskSchedule.taskIdentifier;
        environmentType = instance.environment.type;
        scheduleType = instance.taskSchedule.type;

        span.setAttribute("task_identifier", taskIdentifier);
        span.setAttribute("environment_type", environmentType);
        span.setAttribute("schedule_type", scheduleType);
        span.setAttribute("organization_id", instance.environment.organization.id);
        span.setAttribute("project_id", instance.environment.project.id);
        span.setAttribute("environment_id", instance.environment.id);

        // Check if organization/project/environment is still valid
        if (instance.environment.organization.deletedAt) {
          this.logger.debug("Organization is deleted, skipping schedule", {
            instanceId: params.instanceId,
            scheduleId: instance.taskSchedule.friendlyId,
            organizationId: instance.environment.organization.id,
          });
          span.setAttribute("skip_reason", "organization_deleted");
          return;
        }

        if (instance.environment.project.deletedAt) {
          this.logger.debug("Project is deleted, skipping schedule", {
            instanceId: params.instanceId,
            scheduleId: instance.taskSchedule.friendlyId,
            projectId: instance.environment.project.id,
          });
          span.setAttribute("skip_reason", "project_deleted");
          return;
        }

        if (instance.environment.archivedAt) {
          this.logger.debug("Environment is archived, skipping schedule", {
            instanceId: params.instanceId,
            scheduleId: instance.taskSchedule.friendlyId,
            environmentId: instance.environment.id,
          });
          span.setAttribute("skip_reason", "environment_archived");
          return;
        }

        let shouldTrigger = true;
        let skipReason: string | undefined;

        if (!instance.active || !instance.taskSchedule.active) {
          this.logger.debug("Schedule is inactive", {
            instanceId: params.instanceId,
            instanceActive: instance.active,
            scheduleActive: instance.taskSchedule.active,
          });
          shouldTrigger = false;
          skipReason = "schedule_inactive";
        }

        if (!instance.nextScheduledTimestamp) {
          this.logger.debug("No next scheduled timestamp", {
            instanceId: params.instanceId,
          });
          shouldTrigger = false;
          skipReason = "no_next_timestamp";
        }

        // For development environments, check if there's an active session
        if (instance.environment.type === "DEVELOPMENT") {
          this.devEnvironmentCheckCounter.add(1, {
            environment_id: instance.environment.id,
          });

          const [devConnectedError, isConnected] = await tryCatch(
            this.options.isDevEnvironmentConnectedHandler(instance.environment.id)
          );

          if (devConnectedError) {
            this.logger.error("Error checking if development environment is connected", {
              instanceId: params.instanceId,
              environmentId: instance.environment.id,
              error: devConnectedError,
            });
            span.setAttribute("dev_connection_check_error", true);
            shouldTrigger = false;
            skipReason = "dev_connection_check_failed";
          } else if (!isConnected) {
            this.logger.debug("Development environment is disconnected", {
              instanceId: params.instanceId,
              environmentId: instance.environment.id,
            });
            span.setAttribute("dev_connected", false);
            shouldTrigger = false;
            skipReason = "dev_disconnected";
          } else {
            span.setAttribute("dev_connected", true);
          }
        }

        span.setAttribute("should_trigger", shouldTrigger);
        if (skipReason) {
          span.setAttribute("skip_reason", skipReason);
        }

        // Calculate the schedule timestamp that will be used (regardless of whether we trigger or not)
        const scheduleTimestamp =
          params.exactScheduleTime ?? instance.nextScheduledTimestamp ?? new Date();

        if (shouldTrigger) {
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

          // Calculate execution timing metrics
          const actualExecutionTime = new Date();
          const schedulingAccuracyMs = actualExecutionTime.getTime() - scheduleTimestamp.getTime();

          span.setAttribute("scheduling_accuracy_ms", schedulingAccuracyMs);
          span.setAttribute("actual_execution_time", actualExecutionTime.toISOString());

          this.logger.info("Triggering scheduled task", {
            instanceId: params.instanceId,
            taskIdentifier: instance.taskSchedule.taskIdentifier,
            scheduleTimestamp: scheduleTimestamp.toISOString(),
            actualExecutionTime: actualExecutionTime.toISOString(),
            schedulingAccuracyMs,
            lastTimestamp: instance.lastScheduledTimestamp?.toISOString(),
          });

          const triggerStartTime = Date.now();

          // Rewritten try/catch to use tryCatch utility
          const [triggerError, result] = await tryCatch(
            this.onTriggerScheduledTask({
              taskIdentifier: instance.taskSchedule.taskIdentifier,
              environment: instance.environment,
              payload,
              scheduleInstanceId: instance.id,
              scheduleId: instance.taskSchedule.id,
              exactScheduleTime: scheduleTimestamp,
            })
          );

          const triggerDuration = Date.now() - triggerStartTime;

          this.scheduleExecutionDuration.record(triggerDuration, {
            environment_type: environmentType,
            schedule_type: scheduleType,
          });

          if (triggerError) {
            this.logger.error("Error calling trigger callback", {
              instanceId: params.instanceId,
              taskIdentifier: instance.taskSchedule.taskIdentifier,
              durationMs: triggerDuration,
              error: triggerError instanceof Error ? triggerError.message : String(triggerError),
            });

            this.scheduleExecutionFailureCounter.add(1, {
              environment_type: environmentType,
              schedule_type: scheduleType,
              error_type: "callback_error",
            });

            span.setAttribute("trigger_error", true);
            span.setAttribute(
              "trigger_error_message",
              triggerError instanceof Error ? triggerError.message : String(triggerError)
            );
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

              this.logger.info("Successfully triggered scheduled task", {
                instanceId: params.instanceId,
                taskIdentifier: instance.taskSchedule.taskIdentifier,
                durationMs: triggerDuration,
              });

              this.scheduleExecutionCounter.add(1, {
                environment_type: environmentType,
                schedule_type: scheduleType,
                status: "success",
              });

              span.setAttribute("trigger_success", true);
            } else {
              this.logger.error("Failed to trigger scheduled task", {
                instanceId: params.instanceId,
                taskIdentifier: instance.taskSchedule.taskIdentifier,
                durationMs: triggerDuration,
                error: result.error,
              });

              this.scheduleExecutionFailureCounter.add(1, {
                environment_type: environmentType,
                schedule_type: scheduleType,
                error_type: "task_failure",
              });

              span.setAttribute("trigger_success", false);
              if (result.error) {
                span.setAttribute("trigger_error_message", result.error);
              }
            }
          }

          span.setAttribute("trigger_duration_ms", triggerDuration);
        } else {
          this.logger.debug("Skipping task trigger due to conditions", {
            instanceId: params.instanceId,
            reason: skipReason,
          });

          this.scheduleExecutionCounter.add(1, {
            environment_type: environmentType ?? "unknown",
            schedule_type: scheduleType ?? "unknown",
            status: "skipped",
          });
        }

        // Always update the last scheduled timestamp and register next run
        await this.prisma.taskScheduleInstance.update({
          where: {
            id: params.instanceId,
          },
          data: {
            lastScheduledTimestamp: scheduleTimestamp,
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

          span.setAttribute("next_run_registration_error", true);
          span.setAttribute(
            "next_run_error_message",
            nextRunError instanceof Error ? nextRunError.message : String(nextRunError)
          );

          if (!params.finalAttempt) {
            throw nextRunError;
          }
        } else {
          span.setAttribute("next_run_registered", true);
        }

        const totalDuration = Date.now() - startTime;
        this.logger.debug("Scheduled task trigger completed", {
          instanceId: params.instanceId,
          totalDurationMs: totalDuration,
        });

        span.setAttribute("total_duration_ms", totalDuration);
        span.setAttribute("success", true);
      } catch (error) {
        const totalDuration = Date.now() - startTime;
        this.logger.error("Failed to trigger scheduled task", {
          instanceId: params.instanceId,
          totalDurationMs: totalDuration,
          error: error instanceof Error ? error.message : String(error),
        });

        this.scheduleExecutionFailureCounter.add(1, {
          environment_type: environmentType ?? "unknown",
          schedule_type: scheduleType ?? "unknown",
          error_type: "system_error",
        });

        span.setAttribute("error", true);
        span.setAttribute("error_message", error instanceof Error ? error.message : String(error));
        span.setAttribute("total_duration_ms", totalDuration);

        throw error;
      }
    });
  }

  /**
   * Enqueues a scheduled task with distributed execution timing
   */
  private async enqueueScheduledTask(instanceId: string, exactScheduleTime: Date) {
    return startSpan(this.tracer, "enqueueScheduledTask", async (span) => {
      span.setAttribute("instanceId", instanceId);
      span.setAttribute("exactScheduleTime", exactScheduleTime.toISOString());

      const distributedExecutionTime = calculateDistributedExecutionTime(
        exactScheduleTime,
        this.distributionWindowSeconds,
        instanceId
      );

      const distributionOffsetMs = exactScheduleTime.getTime() - distributedExecutionTime.getTime();

      span.setAttribute("distributedExecutionTime", distributedExecutionTime.toISOString());
      span.setAttribute("distributionOffsetMs", distributionOffsetMs);
      span.setAttribute("distributionWindowSeconds", this.distributionWindowSeconds);

      this.distributionOffsetHistogram.record(distributionOffsetMs, {
        distribution_window_seconds: this.distributionWindowSeconds.toString(),
      });

      this.logger.debug("Enqueuing scheduled task with distributed execution", {
        instanceId,
        exactScheduleTime: exactScheduleTime.toISOString(),
        distributedExecutionTime: distributedExecutionTime.toISOString(),
        distributionOffsetMs,
        distributionWindowSeconds: this.distributionWindowSeconds,
      });

      try {
        await this.worker.enqueue({
          id: `scheduled-task-instance:${instanceId}`,
          job: "schedule.triggerScheduledTask",
          payload: {
            instanceId,
            exactScheduleTime,
          },
          availableAt: distributedExecutionTime,
        });

        span.setAttribute("enqueue_success", true);

        this.logger.debug("Successfully enqueued scheduled task", {
          instanceId,
          jobId: `scheduled-task-instance:${instanceId}`,
        });
      } catch (error) {
        this.logger.error("Failed to enqueue scheduled task", {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });

        span.setAttribute("enqueue_error", true);
        span.setAttribute(
          "enqueue_error_message",
          error instanceof Error ? error.message : String(error)
        );

        throw error;
      }
    });
  }

  public recoverSchedulesInEnvironment(projectId: string, environmentId: string) {
    return startSpan(this.tracer, "recoverSchedulesInEnvironment", async (span) => {
      this.logger.info("Recovering schedules in environment", {
        environmentId,
        projectId,
      });

      span.setAttribute("environmentId", environmentId);

      const schedules = await this.prisma.taskSchedule.findMany({
        where: {
          projectId,
          instances: {
            some: {
              environmentId,
            },
          },
        },
        select: {
          id: true,
          generatorExpression: true,
          instances: {
            select: {
              id: true,
              environmentId: true,
              lastScheduledTimestamp: true,
              nextScheduledTimestamp: true,
            },
          },
        },
      });

      const instancesWithSchedule = schedules
        .map((schedule) => ({
          schedule,
          instance: schedule.instances.find((instance) => instance.environmentId === environmentId),
        }))
        .filter((instance) => instance.instance) as Array<{
        schedule: Omit<(typeof schedules)[number], "instances">;
        instance: NonNullable<(typeof schedules)[number]["instances"][number]>;
      }>;

      if (instancesWithSchedule.length === 0) {
        this.logger.info("No instances found for environment", {
          environmentId,
          projectId,
        });

        return {
          recovered: [],
          skipped: [],
        };
      }

      const results = {
        recovered: [],
        skipped: [],
      } as { recovered: string[]; skipped: string[] };

      for (const { instance, schedule } of instancesWithSchedule) {
        this.logger.info("Recovering schedule", {
          schedule,
          instance,
        });

        const [recoverError, result] = await tryCatch(
          this.#recoverTaskScheduleInstance({ instance, schedule })
        );

        if (recoverError) {
          this.logger.error("Error recovering schedule", {
            error: recoverError instanceof Error ? recoverError.message : String(recoverError),
          });

          span.setAttribute("recover_error", true);
          span.setAttribute(
            "recover_error_message",
            recoverError instanceof Error ? recoverError.message : String(recoverError)
          );
        } else {
          span.setAttribute("recover_success", true);

          if (result === "recovered") {
            results.recovered.push(instance.id);
          } else {
            results.skipped.push(instance.id);
          }
        }
      }

      return results;
    });
  }

  async #recoverTaskScheduleInstance({
    instance,
    schedule,
  }: {
    instance: {
      id: string;
      environmentId: string;
      lastScheduledTimestamp: Date | null;
      nextScheduledTimestamp: Date | null;
    };
    schedule: { id: string; generatorExpression: string };
  }) {
    // inspect the schedule worker to see if there is a job for this instance
    const job = await this.worker.getJob(`scheduled-task-instance:${instance.id}`);

    if (job) {
      this.logger.info("Job already exists for instance", {
        instanceId: instance.id,
        job,
        schedule,
      });

      return "skipped";
    }

    this.logger.info("No job found for instance, registering next run", {
      instanceId: instance.id,
      schedule,
    });

    // If the job does not exist, register the next run
    await this.registerNextTaskScheduleInstance({ instanceId: instance.id });

    return "recovered";
  }

  async getJob(id: string) {
    return this.worker.getJob(id);
  }

  async quit() {
    this.logger.info("Shutting down schedule engine");

    try {
      await this.worker.stop();
      this.logger.info("Schedule engine worker stopped successfully");
    } catch (error) {
      this.logger.error("Error stopping schedule engine worker", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
