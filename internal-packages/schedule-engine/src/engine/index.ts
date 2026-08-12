import type { Counter, Histogram, Meter, Tracer } from "@internal/tracing";
import { getMeter, getTracer, startSpan } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import type { PrismaClient } from "@trigger.dev/database";
import { Worker, type JobHandlerParams } from "@trigger.dev/redis-worker";
import { calculateDistributedExecutionTime } from "./distributedScheduling.js";
import {
  calculateNextSchedulableOccurrence,
  nextScheduledTimestamps,
  previousScheduledTimestamp,
} from "./scheduleCalculation.js";
import type {
  RegisterScheduleInstanceParams,
  ScheduleEngineOptions,
  TriggerScheduledTaskCallback,
  TriggerScheduleParams,
} from "./types.js";
import {
  calculateSchedulePhase,
  SCHEDULE_PHASE_DENOMINATOR,
  type NormalizedScheduleWindow,
} from "./scheduleTiming.js";
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
  private scheduleWindowCappedCounter: Counter;
  private schedulePhasePersistedCounter: Counter;
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
        description: "Distribution offset from effective schedule time in milliseconds",
        unit: "ms",
      }
    );

    this.scheduleWindowCappedCounter = this.meter.createCounter("schedule_windows_capped_total", {
      description: "Total number of absolute schedule windows capped at the next nominal interval",
    });

    this.schedulePhasePersistedCounter = this.meter.createCounter(
      "schedule_phase_persisted_total",
      {
        description: "Total number of schedule phases persisted during registration",
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

        const scheduleWindow = normalizedScheduleWindow(instance.taskSchedule);
        const schedulePhase =
          instance.schedulePhase ??
          calculateSchedulePhase({
            secret: this.options.schedulePhaseSecret,
            environmentId: instance.environmentId,
            deduplicationKey: instance.taskSchedule.deduplicationKey,
          });

        const cronSpreadActive = this.#isCronSpreadActive(schedulePhase);

        let persisted = false;
        if (cronSpreadActive && instance.schedulePhase === null) {
          await this.prisma.taskScheduleInstance.updateMany({
            where: {
              id: instance.id,
              schedulePhase: null,
            },
            data: {
              schedulePhase,
            },
          });
          persisted = true;
          this.schedulePhasePersistedCounter.add(1, {
            environment_type: instance.environment.type,
            schedule_type: instance.taskSchedule.type,
          });
        }

        span.setAttribute(
          "schedule_phase_source",
          instance.schedulePhase !== null ? "db" : persisted ? "persisted" : "ephemeral"
        );
        span.setAttribute("schedule_phase", schedulePhase);

        const registrationTime = new Date();
        const fromTimestamp = params.fromTimestamp ?? registrationTime;
        span.setAttribute("from_timestamp", fromTimestamp.toISOString());

        const {
          nominalAt,
          candidateEffectiveAt,
          effectiveAt,
          effectiveRangeMs,
          windowMs,
          offsetMs: candidateDelayMs,
          intervalMs,
          windowWasCappedToInterval,
          skippedExpiredOccurrences,
        } = calculateNextSchedulableOccurrence({
          schedule: instance.taskSchedule.generatorExpression,
          timezone: instance.taskSchedule.timezone,
          afterNominal: fromTimestamp,
          now: registrationTime,
          schedulePhase,
          window: scheduleWindow,
          cronSpreadEnabled: cronSpreadActive,
        });
        const appliedDelayMs = effectiveAt.getTime() - nominalAt.getTime();

        span.setAttribute("cron_spread_fraction", this.options.cronSpreadFraction);
        span.setAttribute("cron_spread_active", cronSpreadActive);
        span.setAttribute("schedule_window_type", scheduleWindow?.type ?? "none");
        span.setAttribute("next_scheduled_timestamp", nominalAt.toISOString());
        span.setAttribute("candidate_effective_schedule_time", candidateEffectiveAt.toISOString());
        span.setAttribute("effective_schedule_time", effectiveAt.toISOString());
        span.setAttribute("candidate_delay_ms", candidateDelayMs);
        span.setAttribute("applied_delay_ms", appliedDelayMs);
        span.setAttribute("schedule_window_ms", windowMs);
        span.setAttribute("effective_range_ms", effectiveRangeMs);
        span.setAttribute("schedule_window_was_capped_to_interval", windowWasCappedToInterval);
        span.setAttribute("schedule_expired_occurrences_skipped", skippedExpiredOccurrences);

        if (skippedExpiredOccurrences) {
          span.addEvent("schedule_expired_occurrences_skipped", {
            from_nominal_time: fromTimestamp.toISOString(),
            selected_nominal_time: nominalAt.toISOString(),
          });
        }

        if (windowWasCappedToInterval) {
          span.addEvent("schedule_window_capped_to_interval", {
            requested_window_ms: windowMs,
            nominal_interval_ms: intervalMs,
          });
          this.scheduleWindowCappedCounter.add(1, {
            environment_type: instance.environment.type,
            schedule_type: instance.taskSchedule.type,
          });
        }

        const schedulingDelayMs = effectiveAt.getTime() - registrationTime.getTime();
        span.setAttribute("scheduling_delay_ms", schedulingDelayMs);

        this.logger.debug("Calculated next schedule timestamps", {
          instanceId: params.instanceId,
          taskIdentifier: instance.taskSchedule.taskIdentifier,
          nominalAt: nominalAt.toISOString(),
          candidateEffectiveAt: candidateEffectiveAt.toISOString(),
          effectiveAt: effectiveAt.toISOString(),
          cronSpreadActive,
          scheduleWindowType: scheduleWindow?.type ?? "none",
          candidateDelayMs,
          appliedDelayMs,
          effectiveRangeMs,
          windowWasCappedToInterval,
          skippedExpiredOccurrences,
          schedulingDelayMs,
          generatorExpression: instance.taskSchedule.generatorExpression,
          timezone: instance.taskSchedule.timezone,
        });

        // Determine the lastScheduleTime to embed in the next worker job's
        // payload. If the caller passed it explicitly (the after-fire path
        // does this with the just-fired timestamp, the after-skip path
        // carries the existing value forward), use that. Otherwise — every
        // external caller (deploy sync, schedule upsert, recovery) — derive
        // from the cron expression's previous slot.
        //
        // Without this fallback, every deploy / cron edit would clobber the
        // existing in-flight job's lastScheduleTime with `undefined`, and
        // the next fire would surface a frozen DB-column value to the
        // customer (since this PR stops writing that column). Pure cron
        // math, no DB read on top of the existing instance load — the
        // recovery loop already pays the cost of loading the instance.
        let lastScheduleTime = params.lastScheduleTime;
        if (lastScheduleTime === undefined) {
          try {
            const cronPrev = previousScheduledTimestamp(
              instance.taskSchedule.generatorExpression,
              instance.taskSchedule.timezone
            );
            // Guarded against the cron's previous slot predating the
            // instance itself — for a brand-new schedule, the slot is from
            // before the schedule existed, so `undefined` is the honest
            // answer (preserves the `if (!payload.lastTimestamp)` first-run
            // sentinel customers rely on).
            if (cronPrev.getTime() > instance.createdAt.getTime()) {
              lastScheduleTime = cronPrev;
            }
          } catch {
            // Malformed cron — leave undefined.
          }
        }

        await this.enqueueScheduledTask({
          instanceId: params.instanceId,
          exactScheduleTime: nominalAt,
          effectiveScheduleTime: effectiveAt,
          lastScheduleTime,
          preserveExistingJob: params.preserveExistingJob,
        });

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
      effectiveScheduleTime: payload.effectiveScheduleTime,
      lastScheduleTime: payload.lastScheduleTime,
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
      const exactScheduleTime = params.exactScheduleTime ?? new Date();
      const effectiveScheduleTime = params.effectiveScheduleTime ?? exactScheduleTime;

      span.setAttribute("exactScheduleTime", exactScheduleTime.toISOString());
      span.setAttribute("effectiveScheduleTime", effectiveScheduleTime.toISOString());

      this.logger.debug("Starting scheduled task trigger", {
        instanceId: params.instanceId,
        finalAttempt: params.finalAttempt,
        exactScheduleTime: exactScheduleTime.toISOString(),
        effectiveScheduleTime: effectiveScheduleTime.toISOString(),
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

        if (shouldTrigger) {
          // payload.lastTimestamp is the actual previous fire time. Sources, in
          // order:
          //   1. params.lastScheduleTime — populated by the engine when this
          //      job was enqueued. Always present for jobs enqueued post-deploy.
          //   2. instance.lastScheduledTimestamp — backward-compat fallback for
          //      in-flight Redis jobs enqueued by older engines that didn't
          //      include lastScheduleTime in the payload. Once those drain
          //      this fallback never triggers and we can drop the column.
          //   3. undefined — first-ever fire (no previous fire to point at).
          const lastTimestamp =
            params.lastScheduleTime ?? instance.lastScheduledTimestamp ?? undefined;
          const actualExecutionTime = new Date();
          const scheduleWindow = normalizedScheduleWindow(instance.taskSchedule);
          const schedulePhase =
            instance.schedulePhase ??
            calculateSchedulePhase({
              secret: this.options.schedulePhaseSecret,
              environmentId: instance.environmentId,
              deduplicationKey: instance.taskSchedule.deduplicationKey,
            });
          const cronSpreadActive = this.#isCronSpreadActive(schedulePhase);
          span.setAttribute("cron_spread_active", cronSpreadActive);
          const nextOccurrence = calculateNextSchedulableOccurrence({
            schedule: instance.taskSchedule.generatorExpression,
            timezone: instance.taskSchedule.timezone,
            afterNominal: exactScheduleTime,
            now: actualExecutionTime,
            schedulePhase,
            window: scheduleWindow,
            cronSpreadEnabled: cronSpreadActive,
          });
          const upcoming = [
            nextOccurrence.nominalAt,
            ...nextScheduledTimestamps(
              instance.taskSchedule.generatorExpression,
              instance.taskSchedule.timezone,
              nextOccurrence.nominalAt,
              9
            ),
          ];

          const payload = {
            scheduleId: instance.taskSchedule.friendlyId,
            type: instance.taskSchedule.type as "DECLARATIVE" | "IMPERATIVE",
            timestamp: exactScheduleTime,
            lastTimestamp,
            externalId: instance.taskSchedule.externalId ?? undefined,
            timezone: instance.taskSchedule.timezone,
            upcoming,
          };

          // Calculate execution timing metrics
          const schedulingAccuracyMs = actualExecutionTime.getTime() - exactScheduleTime.getTime();

          span.setAttribute("scheduling_accuracy_ms", schedulingAccuracyMs);
          span.setAttribute("actual_execution_time", actualExecutionTime.toISOString());

          this.logger.debug("Triggering scheduled task", {
            instanceId: params.instanceId,
            taskIdentifier: instance.taskSchedule.taskIdentifier,
            exactScheduleTime: exactScheduleTime.toISOString(),
            effectiveScheduleTime: effectiveScheduleTime.toISOString(),
            actualExecutionTime: actualExecutionTime.toISOString(),
            schedulingAccuracyMs,
            lastTimestamp: lastTimestamp?.toISOString(),
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
              exactScheduleTime,
              effectiveScheduleTime,
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
              this.logger.debug("Successfully triggered scheduled task", {
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
              // QUEUE_LIMIT and OUT_OF_ENTITLEMENTS are expected,
              // non-actionable outcomes (the environment is at its queue limit,
              // or the org is out of entitlements). Log them as warnings so they
              // aren't reported as errors, while still recording the metric.
              const isExpectedFailure =
                result.errorType === "QUEUE_LIMIT" || result.errorType === "OUT_OF_ENTITLEMENTS";

              if (isExpectedFailure) {
                this.logger.warn("Scheduled task trigger skipped", {
                  instanceId: params.instanceId,
                  taskIdentifier: instance.taskSchedule.taskIdentifier,
                  durationMs: triggerDuration,
                  errorType: result.errorType,
                  error: result.error,
                });
              } else {
                this.logger.error("Failed to trigger scheduled task", {
                  instanceId: params.instanceId,
                  taskIdentifier: instance.taskSchedule.taskIdentifier,
                  durationMs: triggerDuration,
                  error: result.error,
                });
              }

              const failureErrorType =
                result.errorType === "QUEUE_LIMIT"
                  ? "queue_limit"
                  : result.errorType === "OUT_OF_ENTITLEMENTS"
                    ? "out_of_entitlements"
                    : "task_failure";

              this.scheduleExecutionFailureCounter.add(1, {
                environment_type: environmentType,
                schedule_type: scheduleType,
                error_type: failureErrorType,
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

        // Register the next run. `fromTimestamp` anchors nominal chaining;
        // registration preserves an upcoming effective occurrence and skips
        // expired intermediate ticks after downtime.
        // `lastScheduleTime` is the actual previous fire time the next job
        // will report as `payload.lastTimestamp` — only advance it when we
        // actually triggered, otherwise carry forward the existing value so
        // a long pause/disconnect doesn't quietly overwrite the real
        // last-fire timestamp with a series of skipped slots.
        const carriedLastScheduleTime = shouldTrigger
          ? exactScheduleTime
          : (params.lastScheduleTime ?? instance.lastScheduledTimestamp ?? undefined);

        const [nextRunError] = await tryCatch(
          this.registerNextTaskScheduleInstance({
            instanceId: params.instanceId,
            fromTimestamp: exactScheduleTime,
            lastScheduleTime: carriedLastScheduleTime,
          })
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
   * Per-schedule rollout gate for cron spread. The schedule's deterministic
   * phase doubles as a stable sampling key: raising the fraction is strictly
   * additive (a schedule never leaves the rollout once included), and 0/1 map
   * to fully off/on.
   */
  #isCronSpreadActive(schedulePhase: number): boolean {
    return schedulePhase < this.options.cronSpreadFraction * SCHEDULE_PHASE_DENOMINATOR;
  }

  /**
   * Enqueues a scheduled task with distributed execution timing
   */
  private async enqueueScheduledTask({
    instanceId,
    exactScheduleTime,
    effectiveScheduleTime,
    lastScheduleTime,
    preserveExistingJob = false,
  }: {
    instanceId: string;
    exactScheduleTime: Date;
    effectiveScheduleTime: Date;
    lastScheduleTime?: Date;
    preserveExistingJob?: boolean;
  }) {
    return startSpan(this.tracer, "enqueueScheduledTask", async (span) => {
      span.setAttribute("instanceId", instanceId);
      span.setAttribute("exactScheduleTime", exactScheduleTime.toISOString());
      span.setAttribute("effectiveScheduleTime", effectiveScheduleTime.toISOString());
      span.setAttribute("preserveExistingJob", preserveExistingJob);
      if (lastScheduleTime) {
        span.setAttribute("lastScheduleTime", lastScheduleTime.toISOString());
      }

      const distributedExecutionTime = calculateDistributedExecutionTime(
        effectiveScheduleTime,
        this.distributionWindowSeconds,
        instanceId
      );

      const distributionOffsetMs =
        effectiveScheduleTime.getTime() - distributedExecutionTime.getTime();

      span.setAttribute("distributedExecutionTime", distributedExecutionTime.toISOString());
      span.setAttribute("distributionOffsetMs", distributionOffsetMs);
      span.setAttribute("distributionWindowSeconds", this.distributionWindowSeconds);

      this.distributionOffsetHistogram.record(distributionOffsetMs, {
        distribution_window_seconds: this.distributionWindowSeconds.toString(),
      });

      this.logger.debug("Enqueuing scheduled task with distributed execution", {
        instanceId,
        exactScheduleTime: exactScheduleTime.toISOString(),
        effectiveScheduleTime: effectiveScheduleTime.toISOString(),
        distributedExecutionTime: distributedExecutionTime.toISOString(),
        distributionOffsetMs,
        distributionWindowSeconds: this.distributionWindowSeconds,
        preserveExistingJob,
      });

      try {
        const job = {
          id: `scheduled-task-instance:${instanceId}`,
          job: "schedule.triggerScheduledTask" as const,
          payload: {
            instanceId,
            exactScheduleTime,
            effectiveScheduleTime,
            lastScheduleTime,
          },
          availableAt: distributedExecutionTime,
        };
        let enqueued = true;
        if (preserveExistingJob) {
          enqueued = await this.worker.enqueueOnce(job);
        } else {
          await this.worker.enqueue(job);
        }

        span.setAttribute("enqueue_success", true);
        span.setAttribute("existing_job_preserved", !enqueued);

        this.logger.debug(
          enqueued ? "Successfully enqueued scheduled task" : "Preserved existing scheduled task",
          {
            instanceId,
            jobId: job.id,
          }
        );
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
          timezone: true,
          instances: {
            select: {
              id: true,
              environmentId: true,
              createdAt: true,
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
        this.logger.debug("Recovering schedule", {
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
      createdAt: Date;
    };
    schedule: { id: string; generatorExpression: string; timezone: string | null };
  }) {
    // inspect the schedule worker to see if there is a job for this instance
    const job = await this.worker.getJob(`scheduled-task-instance:${instance.id}`);

    if (job) {
      this.logger.debug("Job already exists for instance", {
        instanceId: instance.id,
        job,
        schedule,
      });

      return "skipped";
    }

    this.logger.debug("No job found for instance, registering next run", {
      instanceId: instance.id,
      schedule,
    });

    // No `lastScheduleTime` passed — `registerNextTaskScheduleInstance`
    // will derive it from the cron's previous slot (with a createdAt
    // guard) so the post-recovery fire reports an accurate
    // `payload.lastTimestamp`.
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

function normalizedScheduleWindow({
  windowDurationSeconds,
  windowPercentage,
}: {
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
}): NormalizedScheduleWindow | undefined {
  if (windowPercentage !== null) {
    return { type: "percentage", percentage: windowPercentage };
  }

  if (windowDurationSeconds !== null) {
    return { type: "duration", durationSeconds: windowDurationSeconds };
  }

  return undefined;
}
