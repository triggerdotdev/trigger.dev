import {
  Context,
  ROOT_CONTEXT,
  Span,
  SpanKind,
  SpanOptions,
  SpanStatusCode,
  context,
  trace,
} from "@opentelemetry/api";
import {
  AckCallbackResult,
  MachinePreset,
  V3ProdTaskRunExecution,
  V3ProdTaskRunExecutionPayload,
  TaskRunError,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionLazyAttemptPayload,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  parsePacket,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import {
  BackgroundWorker,
  BackgroundWorkerTask,
  Prisma,
  TaskRunStatus,
} from "@trigger.dev/database";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { findQueueInEnvironment, sanitizeQueueName } from "~/models/taskQueue.server";
import { generateJWTTokenForEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { marqs } from "~/v3/marqs/index.server";
import {
  RuntimeEnvironmentForEnvRepo,
  RuntimeEnvironmentForEnvRepoPayload,
  resolveVariablesForEnvironment,
} from "../environmentVariables/environmentVariablesRepository.server";
import { EnvironmentVariable } from "../environmentVariables/repository";
import { FailedTaskRunService } from "../failedTaskRun.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { socketIo } from "../handleSocketIo.server";
import { machinePresetFromConfig, machinePresetFromRun } from "../machinePresets.server";
import {
  findCurrentWorkerDeployment,
  getWorkerDeploymentFromWorker,
  getWorkerDeploymentFromWorkerTask,
} from "../models/workerDeployment.server";
import { CrashTaskRunService } from "../services/crashTaskRun.server";
import { CreateTaskRunAttemptService } from "../services/createTaskRunAttempt.server";
import { RestoreCheckpointService } from "../services/restoreCheckpoint.server";
import {
  FINAL_ATTEMPT_STATUSES,
  FINAL_RUN_STATUSES,
  isFinalAttemptStatus,
  isFinalRunStatus,
} from "../taskStatus";
import { tracer } from "../tracer.server";
import { getMaxDuration } from "../utils/maxDuration";
import { MessagePayload } from "./types";

const WithTraceContext = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

export const SharedQueueExecuteMessageBody = WithTraceContext.extend({
  type: z.literal("EXECUTE"),
  taskIdentifier: z.string(),
  checkpointEventId: z.string().optional(),
  retryCheckpointsDisabled: z.boolean().optional(),
});

export type SharedQueueExecuteMessageBody = z.infer<typeof SharedQueueExecuteMessageBody>;

export const SharedQueueResumeMessageBody = WithTraceContext.extend({
  type: z.literal("RESUME"),
  completedAttemptIds: z.string().array(),
  resumableAttemptId: z.string(),
  checkpointEventId: z.string().optional(),
});

export type SharedQueueResumeMessageBody = z.infer<typeof SharedQueueResumeMessageBody>;

export const SharedQueueResumeAfterDurationMessageBody = WithTraceContext.extend({
  type: z.literal("RESUME_AFTER_DURATION"),
  resumableAttemptId: z.string(),
  checkpointEventId: z.string(),
});

export type SharedQueueResumeAfterDurationMessageBody = z.infer<
  typeof SharedQueueResumeAfterDurationMessageBody
>;

export const SharedQueueFailMessageBody = WithTraceContext.extend({
  type: z.literal("FAIL"),
  reason: z.string(),
});

export type SharedQueueFailMessageBody = z.infer<typeof SharedQueueFailMessageBody>;

export const SharedQueueMessageBody = z.discriminatedUnion("type", [
  SharedQueueExecuteMessageBody,
  SharedQueueResumeMessageBody,
  SharedQueueResumeAfterDurationMessageBody,
  SharedQueueFailMessageBody,
]);

export type SharedQueueMessageBody = z.infer<typeof SharedQueueMessageBody>;

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type SharedQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
  nextTickInterval?: number;
  interval?: number;
};

type HandleMessageAction = "ack_and_do_more_work" | "nack" | "nack_and_do_more_work" | "noop";

type DoWorkInternalResult = {
  reason: string;
  outcome: "execution" | "retry_with_nack" | "fail_with_ack" | "noop";
  attrs?: Record<string, string | number | boolean | undefined>;
  error?: Error | string;
  interval?: number;
  action?: HandleMessageAction;
};

type HandleMessageResult = {
  action: HandleMessageAction;
  interval?: number;
  retryInMs?: number;
  reason?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  error?: Error | string;
};

export class SharedQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _deprecatedWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _options: Required<SharedQueueConsumerOptions>;
  private _perTraceCountdown: number | undefined;
  private _traceStartedAt: Date | undefined;
  private _currentSpanContext: Context | undefined;
  private _reasonStats: Record<string, number> = {};
  private _actionStats: Record<string, number> = {};
  private _outcomeStats: Record<string, number> = {};
  private _currentSpan: Span | undefined;
  private _endSpanInNextIteration = false;
  private _tasks = sharedQueueTasks;
  private _id: string;
  private _connectedAt: Date;
  private _iterationsCount = 0;
  private _totalIterationsCount = 0;
  private _runningDurationInMs = 0;
  private _currentMessage: MessagePayload | undefined;
  private _currentMessageData: SharedQueueMessageBody | undefined;

  constructor(
    private _providerSender: ZodMessageSender<typeof serverWebsocketMessages>,
    options: SharedQueueConsumerOptions = {}
  ) {
    this._options = {
      maximumItemsPerTrace: options.maximumItemsPerTrace ?? 500,
      traceTimeoutSeconds: options.traceTimeoutSeconds ?? 10,
      nextTickInterval: options.nextTickInterval ?? 1000, // 1 second
      interval: options.interval ?? 100, // 100ms
    };

    this._id = generateFriendlyId("shared-queue", 6);
    this._connectedAt = new Date();
  }

  // This method is called when a background worker is deprecated and will no longer be used unless a run is locked to it
  public async deprecateBackgroundWorker(id: string) {
    const backgroundWorker = this._backgroundWorkers.get(id);

    if (!backgroundWorker) {
      return;
    }

    this._deprecatedWorkers.set(id, backgroundWorker);
    this._backgroundWorkers.delete(id);
  }

  public async registerBackgroundWorker(id: string, envId?: string) {
    if (!envId) {
      logger.error("Environment ID is required for background worker registration", {
        backgroundWorkerId: id,
      });
      return;
    }

    const backgroundWorker = await prisma.backgroundWorker.findFirst({
      where: {
        friendlyId: id,
        runtimeEnvironmentId: envId,
      },
      include: {
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      return;
    }

    this._backgroundWorkers.set(backgroundWorker.id, backgroundWorker);

    logger.debug("Registered background worker", { backgroundWorker: backgroundWorker.id });

    // Start reading from the queue if we haven't already
    this.#enable();
  }

  public async start() {
    this.#enable();
  }

  public async stop(reason: string = "Provider disconnected") {
    if (!this._enabled) {
      return;
    }

    logger.debug("Stopping shared queue consumer");
    this._enabled = false;

    if (this._currentSpan) {
      this._currentSpan.end();
    }
  }

  #enable() {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    this._perTraceCountdown = this._options.maximumItemsPerTrace;
    this._traceStartedAt = new Date();
    this._reasonStats = {};
    this._actionStats = {};
    this._outcomeStats = {};

    this.#doWork().finally(() => {});
  }

  #endCurrentSpan() {
    if (this._currentSpan) {
      for (const [reason, count] of Object.entries(this._reasonStats)) {
        this._currentSpan.setAttribute(`reasons_${reason}`, count);
      }

      for (const [action, count] of Object.entries(this._actionStats)) {
        this._currentSpan.setAttribute(`actions_${action}`, count);
      }

      for (const [outcome, count] of Object.entries(this._outcomeStats)) {
        this._currentSpan.setAttribute(`outcomes_${outcome}`, count);
      }

      this._currentSpan.end();
    }
  }

  async #doWork() {
    if (!this._enabled) {
      this.#endCurrentSpan();
      return;
    }

    // Check if the trace has expired
    if (
      this._perTraceCountdown === 0 ||
      Date.now() - this._traceStartedAt!.getTime() > this._options.traceTimeoutSeconds * 1000 ||
      this._currentSpanContext === undefined ||
      this._endSpanInNextIteration
    ) {
      this.#endCurrentSpan();

      const traceDurationInMs = this._traceStartedAt
        ? Date.now() - this._traceStartedAt.getTime()
        : undefined;
      const iterationsPerSecond = traceDurationInMs
        ? this._iterationsCount / (traceDurationInMs / 1000)
        : undefined;

      // Create a new trace
      this._currentSpan = tracer.startSpan(
        "SharedQueueConsumer.doWork()",
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            id: this._id,
            iterations: this._iterationsCount,
            total_iterations: this._totalIterationsCount,
            options_maximumItemsPerTrace: this._options.maximumItemsPerTrace,
            options_nextTickInterval: this._options.nextTickInterval,
            options_interval: this._options.interval,
            connected_at: this._connectedAt.toISOString(),
            consumer_age_in_seconds: (Date.now() - this._connectedAt.getTime()) / 1000,
            do_work_internal_per_second: this._iterationsCount / (this._runningDurationInMs / 1000),
            running_duration_ms: this._runningDurationInMs,
            trace_timeout_in_seconds: this._options.traceTimeoutSeconds,
            trace_duration_ms: traceDurationInMs,
            iterations_per_second: iterationsPerSecond,
            iterations_per_minute: iterationsPerSecond ? iterationsPerSecond * 60 : undefined,
          },
        },
        ROOT_CONTEXT
      );

      logger.debug("SharedQueueConsumer starting new trace", {
        reasonStats: this._reasonStats,
        actionStats: this._actionStats,
        outcomeStats: this._outcomeStats,
        iterationCount: this._iterationsCount,
        consumerId: this._id,
      });

      // Get the span trace context
      this._currentSpanContext = trace.setSpan(ROOT_CONTEXT, this._currentSpan);

      this._perTraceCountdown = this._options.maximumItemsPerTrace;
      this._traceStartedAt = new Date();
      this._reasonStats = {};
      this._actionStats = {};
      this._outcomeStats = {};
      this._iterationsCount = 0;
      this._runningDurationInMs = 0;
      this._endSpanInNextIteration = false;
    }

    return context.with(this._currentSpanContext ?? ROOT_CONTEXT, async () => {
      await tracer.startActiveSpan("doWorkInternal()", async (span) => {
        let nextInterval = this._options.interval;

        span.setAttributes({
          id: this._id,
          total_iterations: this._totalIterationsCount,
          iterations: this._iterationsCount,
        });

        const startAt = performance.now();

        try {
          const result = await this.#doWorkInternal();

          if (result.reason !== "no_message_dequeued") {
            logger.debug("SharedQueueConsumer doWorkInternal result", { result });
          }

          this._reasonStats[result.reason] = (this._reasonStats[result.reason] ?? 0) + 1;
          this._outcomeStats[result.outcome] = (this._outcomeStats[result.outcome] ?? 0) + 1;

          if (result.action) {
            this._actionStats[result.action] = (this._actionStats[result.action] ?? 0) + 1;
          }

          span.setAttribute("reason", result.reason);

          if (result.attrs) {
            for (const [key, value] of Object.entries(result.attrs)) {
              if (value) {
                span.setAttribute(key, value);
              }
            }
          }

          if (result.error) {
            span.recordException(result.error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            this._currentSpan?.recordException(result.error);
            this._currentSpan?.setStatus({ code: SpanStatusCode.ERROR });
            this._endSpanInNextIteration = true;
          }

          if (typeof result.interval === "number") {
            nextInterval = Math.max(result.interval, 0); // Cannot be negative
          }

          span.setAttribute("nextInterval", nextInterval);
        } catch (error) {
          if (error instanceof Error) {
            this._currentSpan?.recordException(error);
          } else {
            this._currentSpan?.recordException(new Error(String(error)));
          }

          this._endSpanInNextIteration = true;
        } finally {
          this._runningDurationInMs = this._runningDurationInMs + (performance.now() - startAt);
          this._iterationsCount++;
          this._totalIterationsCount++;
          this._perTraceCountdown = this._perTraceCountdown! - 1;

          span.end();

          setTimeout(() => {
            this.#doWork().finally(() => {});
          }, nextInterval);
        }
      });
    });
  }

  async #doWorkInternal(): Promise<DoWorkInternalResult> {
    // Attempt to dequeue a message from the shared queue
    // If no message is available, reschedule the worker to run again in 1 second
    // If a message is available, find the BackgroundWorkerTask that matches the message's taskIdentifier
    // If no matching task is found, nack the message and reschedule the worker to run again in 1 second
    // If the matching task is found, create the task attempt and lock the task run, then send the task run to the client
    // Store the message as a processing message
    // If the websocket connection disconnects before the task run is completed, nack the message
    // When the task run completes, ack the message
    // Using a heartbeat mechanism, if the client keeps responding with a heartbeat, we'll keep the message processing and increase the visibility timeout.

    this._currentMessage = undefined;
    this._currentMessageData = undefined;

    const message = await marqs?.dequeueMessageInSharedQueue(this._id);

    if (!message) {
      return {
        reason: "no_message_dequeued",
        outcome: "noop",
        interval: this._options.nextTickInterval,
      };
    }

    const dequeuedAt = new Date();

    logger.log("dequeueMessageInSharedQueue()", { queueMessage: message });

    const messageBody = SharedQueueMessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
      });

      await this.#ack(message.messageId);

      return {
        reason: "failed_to_parse_message",
        outcome: "fail_with_ack",
        attrs: { message_id: message.messageId, message_version: message.version },
        error: messageBody.error,
      };
    }

    const hydrateAttributes = (attrs: Record<string, string | number | boolean | undefined>) => {
      return {
        ...attrs,
        message_id: message.messageId,
        message_version: message.version,
        run_id: message.messageId,
        message_type: messageBody.data.type,
      };
    };

    this._currentMessage = message;
    this._currentMessageData = messageBody.data;

    const messageResult = await this.#handleMessage(message, messageBody.data, dequeuedAt);

    switch (messageResult.action) {
      case "noop": {
        return {
          reason: messageResult.reason ?? "none_specified",
          outcome: "execution",
          attrs: hydrateAttributes(messageResult.attrs ?? {}),
          error: messageResult.error,
          interval: messageResult.interval,
          action: "noop",
        };
      }
      case "ack_and_do_more_work": {
        await this.#ack(message.messageId);

        return {
          reason: messageResult.reason ?? "none_specified",
          outcome: "fail_with_ack",
          attrs: hydrateAttributes(messageResult.attrs ?? {}),
          error: messageResult.error,
          interval: messageResult.interval,
          action: "ack_and_do_more_work",
        };
      }
      case "nack_and_do_more_work": {
        await this.#nack(message.messageId, messageResult.retryInMs);

        return {
          reason: messageResult.reason ?? "none_specified",
          outcome: "retry_with_nack",
          attrs: hydrateAttributes(messageResult.attrs ?? {}),
          error: messageResult.error,
          interval: messageResult.interval,
          action: "nack_and_do_more_work",
        };
      }
      case "nack": {
        await marqs?.nackMessage(message.messageId);

        return {
          reason: messageResult.reason ?? "none_specified",
          outcome: "retry_with_nack",
          attrs: hydrateAttributes(messageResult.attrs ?? {}),
          error: messageResult.error,
          action: "nack",
        };
      }
    }
  }

  async #handleMessage(
    message: MessagePayload,
    data: SharedQueueMessageBody,
    dequeuedAt: Date
  ): Promise<HandleMessageResult> {
    return await this.#startActiveSpan("handleMessage()", async (span) => {
      // TODO: For every ACK, decide what should be done with the existing run and attempts. Make sure to check the current statuses first.
      switch (data.type) {
        // MARK: EXECUTE
        case "EXECUTE": {
          return await this.#handleExecuteMessage(message, data, dequeuedAt);
        }
        // MARK: DEP RESUME
        // Resume after dependency completed with no remaining retries
        case "RESUME": {
          return await this.#handleResumeMessage(message, data, dequeuedAt);
        }
        // MARK: DURATION RESUME
        // Resume after duration-based wait
        case "RESUME_AFTER_DURATION": {
          return await this.#handleResumeAfterDurationMessage(message, data, dequeuedAt);
        }
        // MARK: FAIL
        // Fail for whatever reason, usually runs that have been resumed but stopped heartbeating
        case "FAIL": {
          return await this.#handleFailMessage(message, data, dequeuedAt);
        }
      }
    });
  }

  async #handleExecuteMessage(
    message: MessagePayload,
    data: SharedQueueExecuteMessageBody,
    dequeuedAt: Date
  ): Promise<HandleMessageResult> {
    const existingTaskRun = await prisma.taskRun.findFirst({
      where: {
        id: message.messageId,
      },
    });

    if (!existingTaskRun) {
      logger.error("No existing task run", {
        queueMessage: message.data,
        messageId: message.messageId,
      });

      // INFO: There used to be a race condition where tasks could be triggered, but execute messages could be dequeued before the run finished being created in the DB
      //       This should not be happening anymore. In case it does, consider reqeueuing here with a brief delay while limiting total retries.
      return { action: "ack_and_do_more_work", reason: "no_existing_task_run" };
    }

    const retryingFromCheckpoint = !!data.checkpointEventId;

    const EXECUTABLE_RUN_STATUSES = {
      fromCheckpoint: ["WAITING_TO_RESUME"] satisfies TaskRunStatus[],
      withoutCheckpoint: ["PENDING", "RETRYING_AFTER_FAILURE"] satisfies TaskRunStatus[],
    };

    if (
      (retryingFromCheckpoint &&
        !EXECUTABLE_RUN_STATUSES.fromCheckpoint.includes(existingTaskRun.status)) ||
      (!retryingFromCheckpoint &&
        !EXECUTABLE_RUN_STATUSES.withoutCheckpoint.includes(existingTaskRun.status))
    ) {
      logger.error("Task run has invalid status for execution. Going to ack", {
        queueMessage: message.data,
        messageId: message.messageId,
        taskRun: existingTaskRun.id,
        status: existingTaskRun.status,
        retryingFromCheckpoint,
      });

      return {
        action: "ack_and_do_more_work",
        reason: "invalid_run_status",
        attrs: { status: existingTaskRun.status, retryingFromCheckpoint },
      };
    }

    // Check if the task run is locked to a specific worker, if not, use the current worker deployment
    const deployment = await this.#startActiveSpan("findCurrentWorkerDeployment", async (span) => {
      return existingTaskRun.lockedById
        ? await getWorkerDeploymentFromWorkerTask(existingTaskRun.lockedById)
        : existingTaskRun.lockedToVersionId
        ? await getWorkerDeploymentFromWorker(existingTaskRun.lockedToVersionId)
        : await findCurrentWorkerDeployment({
            environmentId: existingTaskRun.runtimeEnvironmentId,
            type: "V1",
          });
    });

    const worker = deployment?.worker;

    if (!deployment || !worker) {
      logger.error("No matching deployment found for task run", {
        queueMessage: message.data,
        messageId: message.messageId,
      });

      await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

      return {
        action: "ack_and_do_more_work",
        reason: "no_matching_deployment",
        attrs: {
          run_id: existingTaskRun.id,
          locked_by_id: existingTaskRun.lockedById ?? undefined,
          locked_to_version_id: existingTaskRun.lockedToVersionId ?? undefined,
          environment_id: existingTaskRun.runtimeEnvironmentId,
        },
      };
    }

    const imageReference = deployment.imageReference;

    if (!imageReference) {
      logger.error("Deployment is missing an image reference", {
        queueMessage: message.data,
        messageId: message.messageId,
        deployment: deployment.id,
      });

      await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

      return {
        action: "ack_and_do_more_work",
        reason: "missing_image_reference",
        attrs: {
          deployment_id: deployment.id,
        },
      };
    }

    const backgroundTask = worker.tasks.find(
      (task) => task.slug === existingTaskRun.taskIdentifier
    );

    if (!backgroundTask) {
      const nonCurrentTask = await prisma.backgroundWorkerTask.findFirst({
        where: {
          slug: existingTaskRun.taskIdentifier,
          projectId: existingTaskRun.projectId,
          runtimeEnvironmentId: existingTaskRun.runtimeEnvironmentId,
        },
        include: {
          worker: {
            include: {
              deployment: {
                include: {},
              },
            },
          },
        },
      });

      if (nonCurrentTask) {
        logger.warn("Task for this run exists but is not part of the current deploy", {
          taskRun: existingTaskRun.id,
          taskIdentifier: existingTaskRun.taskIdentifier,
        });
      } else {
        logger.warn("Task for this run has never been deployed", {
          taskRun: existingTaskRun.id,
          taskIdentifier: existingTaskRun.taskIdentifier,
        });
      }

      await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

      // If this task is ever deployed, a new message will be enqueued after successful indexing
      return {
        action: "ack_and_do_more_work",
        reason: "task_not_deployed",
        attrs: {
          run_id: existingTaskRun.id,
          task_identifier: existingTaskRun.taskIdentifier,
        },
      };
    }

    const lockedAt = new Date();
    const machinePreset =
      existingTaskRun.machinePreset ??
      machinePresetFromConfig(backgroundTask.machineConfig ?? {}).name;
    const maxDurationInSeconds = getMaxDuration(
      existingTaskRun.maxDurationInSeconds,
      backgroundTask.maxDurationInSeconds
    );
    const startedAt = existingTaskRun.startedAt ?? dequeuedAt;
    const baseCostInCents = env.CENTS_PER_RUN;

    const lockedTaskRun = await prisma.taskRun.update({
      where: {
        id: message.messageId,
      },
      data: {
        lockedAt,
        lockedById: backgroundTask.id,
        lockedToVersionId: worker.id,
        taskVersion: worker.version,
        sdkVersion: worker.sdkVersion,
        cliVersion: worker.cliVersion,
        startedAt: startedAt,
        baseCostInCents: baseCostInCents,
        machinePreset: machinePreset,
        maxDurationInSeconds,
      },
      include: {
        runtimeEnvironment: true,
        attempts: {
          take: 1,
          orderBy: { number: "desc" },
        },
        tags: true,
        checkpoints: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
        },
        lockedBy: true,
      },
    });

    if (!lockedTaskRun) {
      logger.warn("Failed to lock task run", {
        taskRun: existingTaskRun.id,
        taskIdentifier: existingTaskRun.taskIdentifier,
        deployment: deployment.id,
        backgroundWorker: worker.id,
        messageId: message.messageId,
      });

      return {
        action: "ack_and_do_more_work",
        reason: "failed_to_lock_task_run",
        attrs: {
          run_id: existingTaskRun.id,
          task_identifier: existingTaskRun.taskIdentifier,
          deployment_id: deployment.id,
          background_worker_id: worker.id,
          message_id: message.messageId,
        },
      };
    }

    const queue = await findQueueInEnvironment(
      lockedTaskRun.queue,
      lockedTaskRun.runtimeEnvironmentId,
      lockedTaskRun.lockedById ?? undefined,
      backgroundTask
    );

    if (!queue) {
      logger.debug("SharedQueueConsumer queue not found, so acking message", {
        queueMessage: message,
        taskRunQueue: lockedTaskRun.queue,
        runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
      });

      return {
        action: "ack_and_do_more_work",
        reason: "queue_not_found",
        attrs: {
          queue_name: sanitizeQueueName(lockedTaskRun.queue),
          runtime_environment_id: lockedTaskRun.runtimeEnvironmentId,
        },
        interval: this._options.nextTickInterval,
      };
    }

    if (!this._enabled) {
      logger.debug("SharedQueueConsumer not enabled, so nacking message", {
        queueMessage: message,
      });

      return {
        action: "nack",
        reason: "not_enabled",
        attrs: {
          message_id: message.messageId,
        },
      };
    }

    const nextAttemptNumber = lockedTaskRun.attempts[0] ? lockedTaskRun.attempts[0].number + 1 : 1;

    const isRetry =
      nextAttemptNumber > 1 &&
      (lockedTaskRun.status === "WAITING_TO_RESUME" ||
        lockedTaskRun.status === "RETRYING_AFTER_FAILURE");

    try {
      if (data.checkpointEventId) {
        const restoreService = new RestoreCheckpointService();

        const checkpoint = await restoreService.call({
          eventId: data.checkpointEventId,
          isRetry,
        });

        if (!checkpoint) {
          logger.error("Failed to restore checkpoint", {
            queueMessage: message.data,
            messageId: message.messageId,
            runStatus: lockedTaskRun.status,
            isRetry,
          });

          return {
            action: "ack_and_do_more_work",
            reason: "failed_to_restore_checkpoint",
            attrs: {
              run_status: lockedTaskRun.status,
              is_retry: isRetry,
              checkpoint_event_id: data.checkpointEventId,
            },
          };
        }

        return {
          action: "noop",
          reason: "restored_checkpoint",
          attrs: {
            checkpoint_event_id: data.checkpointEventId,
          },
        };
      }

      if (!worker.supportsLazyAttempts) {
        try {
          const service = new CreateTaskRunAttemptService();
          await service.call({
            runId: lockedTaskRun.id,
            setToExecuting: false,
          });
        } catch (error) {
          logger.error("Failed to create task run attempt for outdated worker", {
            error,
            taskRun: lockedTaskRun.id,
          });

          const service = new CrashTaskRunService();
          await service.call(lockedTaskRun.id, {
            errorCode: TaskRunErrorCodes.OUTDATED_SDK_VERSION,
          });

          return {
            action: "ack_and_do_more_work",
            reason: "failed_to_create_attempt_for_outdated_worker",
            attrs: {
              message_id: message.messageId,
              run_id: lockedTaskRun.id,
            },
            error: error instanceof Error ? error : String(error),
          };
        }
      }

      if (isRetry && !data.retryCheckpointsDisabled) {
        socketIo.coordinatorNamespace.emit("READY_FOR_RETRY", {
          version: "v1",
          runId: lockedTaskRun.id,
        });

        // Retries for workers with disabled retry checkpoints will be handled just like normal attempts
        return {
          action: "noop",
          reason: "retry_checkpoints_disabled",
        };
      }

      const machine =
        machinePresetFromRun(lockedTaskRun) ??
        machinePresetFromConfig(lockedTaskRun.lockedBy?.machineConfig ?? {});

      return await this.#startActiveSpan("scheduleAttemptOnProvider", async (span) => {
        span.setAttributes({
          run_id: lockedTaskRun.id,
        });

        if (await this._providerSender.validateCanSendMessage()) {
          await this._providerSender.send("BACKGROUND_WORKER_MESSAGE", {
            backgroundWorkerId: worker.friendlyId,
            data: {
              type: "SCHEDULE_ATTEMPT",
              image: imageReference,
              version: deployment.version,
              machine,
              nextAttemptNumber,
              // identifiers
              id: "placeholder", // TODO: Remove this completely in a future release
              envId: lockedTaskRun.runtimeEnvironment.id,
              envType: lockedTaskRun.runtimeEnvironment.type,
              orgId: lockedTaskRun.runtimeEnvironment.organizationId,
              projectId: lockedTaskRun.runtimeEnvironment.projectId,
              runId: lockedTaskRun.id,
              dequeuedAt: dequeuedAt.getTime(),
            },
          });

          return {
            action: "noop",
            reason: "scheduled_attempt",
            attrs: {
              next_attempt_number: nextAttemptNumber,
            },
          };
        } else {
          return {
            action: "nack_and_do_more_work",
            reason: "provider_not_connected",
            attrs: {
              run_id: lockedTaskRun.id,
            },
            interval: this._options.nextTickInterval,
            retryInMs: 5_000,
          };
        }
      });
    } catch (e) {
      // We now need to unlock the task run and delete the task run attempt
      await prisma.$transaction([
        prisma.taskRun.update({
          where: {
            id: lockedTaskRun.id,
          },
          data: {
            lockedAt: null,
            lockedById: null,
            status: lockedTaskRun.status,
            startedAt: existingTaskRun.startedAt,
          },
        }),
      ]);

      logger.error("SharedQueueConsumer errored, so nacking message", {
        queueMessage: message,
        error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
      });

      return {
        action: "nack_and_do_more_work",
        reason: "failed_to_schedule_attempt",
        error: e instanceof Error ? e : String(e),
        interval: this._options.nextTickInterval,
        retryInMs: 5_000,
      };
    }
  }

  async #handleResumeMessage(
    message: MessagePayload,
    data: SharedQueueResumeMessageBody,
    dequeuedAt: Date
  ): Promise<HandleMessageResult> {
    if (data.checkpointEventId) {
      try {
        const restoreService = new RestoreCheckpointService();

        const checkpoint = await restoreService.call({
          eventId: data.checkpointEventId,
        });

        if (!checkpoint) {
          logger.error("Failed to restore checkpoint", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          return {
            action: "ack_and_do_more_work",
            reason: "failed_to_restore_checkpoint",
            attrs: {
              checkpoint_event_id: data.checkpointEventId,
            },
          };
        }

        return {
          action: "noop",
          reason: "restored_checkpoint",
          attrs: {
            checkpoint_event_id: data.checkpointEventId,
          },
        };
      } catch (e) {
        return {
          action: "nack_and_do_more_work",
          reason: "failed_to_restore_checkpoint",
          error: e instanceof Error ? e : String(e),
        };
      }
    }

    const resumableRun = await prisma.taskRun.findFirst({
      where: {
        id: message.messageId,
        status: {
          notIn: FINAL_RUN_STATUSES,
        },
      },
    });

    if (!resumableRun) {
      logger.error("Resumable run not found", {
        queueMessage: message.data,
        messageId: message.messageId,
      });

      return {
        action: "ack_and_do_more_work",
        reason: "run_not_found",
      };
    }

    if (resumableRun.status !== "EXECUTING") {
      logger.warn("Run is not executing, will try to resume anyway", {
        queueMessage: message.data,
        messageId: message.messageId,
        runStatus: resumableRun.status,
      });
    }

    const resumableAttempt = await prisma.taskRunAttempt.findFirst({
      where: {
        id: data.resumableAttemptId,
      },
      include: {
        checkpoints: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!resumableAttempt) {
      logger.error("Resumable attempt not found", {
        queueMessage: message.data,
        messageId: message.messageId,
      });

      return {
        action: "ack_and_do_more_work",
        reason: "resumable_attempt_not_found",
        attrs: {
          attempt_id: data.resumableAttemptId,
        },
      };
    }

    const queue = await findQueueInEnvironment(
      resumableRun.queue,
      resumableRun.runtimeEnvironmentId,
      resumableRun.lockedById ?? undefined
    );

    if (!queue) {
      logger.debug("SharedQueueConsumer queue not found, so nacking message", {
        queueName: sanitizeQueueName(resumableRun.queue),
        attempt: resumableAttempt,
      });

      return {
        action: "ack_and_do_more_work",
        reason: "queue_not_found",
        attrs: {
          queue_name: sanitizeQueueName(resumableRun.queue),
        },
        interval: this._options.nextTickInterval,
      };
    }

    if (!this._enabled) {
      return {
        action: "nack",
        reason: "not_enabled",
        attrs: {
          message_id: message.messageId,
        },
      };
    }

    try {
      const { completions, executions } = await this.#resolveCompletedAttemptsForResumeMessage(
        data.completedAttemptIds
      );

      const resumeMessage = {
        version: "v1" as const,
        runId: resumableAttempt.taskRunId,
        attemptId: resumableAttempt.id,
        attemptFriendlyId: resumableAttempt.friendlyId,
        completions,
        executions,
      };

      logger.debug("Broadcasting RESUME_AFTER_DEPENDENCY_WITH_ACK", {
        resumeMessage,
        message,
        resumableRun,
      });

      // The attempt should still be running so we can broadcast to all coordinators to resume immediately
      const responses = await this.#startActiveSpan(
        "emitResumeAfterDependencyWithAck",
        async (span) => {
          try {
            span.setAttribute("attempt_id", resumableAttempt.id);
            span.setAttribute(
              "timeout_in_ms",
              env.SHARED_QUEUE_CONSUMER_EMIT_RESUME_DEPENDENCY_TIMEOUT_MS
            );

            const responses = await socketIo.coordinatorNamespace
              .timeout(env.SHARED_QUEUE_CONSUMER_EMIT_RESUME_DEPENDENCY_TIMEOUT_MS)
              .emitWithAck("RESUME_AFTER_DEPENDENCY_WITH_ACK", resumeMessage);

            span.setAttribute("response_count", responses.length);

            const hasSuccess = responses.some((response) => response.success);

            span.setAttribute("has_success", hasSuccess);
            span.setAttribute("is_timeout", false);

            return responses;
          } catch (e) {
            if (e instanceof Error && "responses" in e && Array.isArray(e.responses)) {
              span.setAttribute("is_timeout", false);

              const responses = e.responses as AckCallbackResult[];

              span.setAttribute("response_count", responses.length);

              const hasSuccess = responses.some(
                (response) => "success" in response && response.success
              );

              span.setAttribute("has_success", hasSuccess);

              return responses;
            }

            throw e;
          }
        }
      );

      logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK received", {
        resumeMessage,
        responses,
        message,
      });

      if (responses.length === 0) {
        logger.error("RESUME_AFTER_DEPENDENCY_WITH_ACK no response", {
          resumeMessage,
          message,
        });

        return {
          action: "nack_and_do_more_work",
          reason: "resume_after_dependency_with_ack_no_response",
          attrs: {
            resume_message: "RESUME_AFTER_DEPENDENCY_WITH_ACK",
          },
          interval: this._options.nextTickInterval,
          retryInMs: 5_000,
        };
      }

      const hasSuccess = responses.some((response) => response.success);

      if (hasSuccess) {
        return {
          action: "noop",
          reason: "resume_after_dependency_with_ack_success",
        };
      }

      // No coordinator was able to resume the run
      logger.warn("RESUME_AFTER_DEPENDENCY_WITH_ACK failed", {
        resumeMessage,
        responses,
        message,
      });

      // Let's check if the run is frozen
      if (resumableRun.status === "WAITING_TO_RESUME") {
        logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK run is waiting to be restored", {
          queueMessage: message.data,
          messageId: message.messageId,
        });

        try {
          const restoreService = new RestoreCheckpointService();

          const checkpointEvent = await restoreService.getLastCheckpointEventIfUnrestored(
            resumableRun.id
          );

          if (checkpointEvent) {
            // The last checkpoint hasn't been restored yet, so restore it
            const checkpoint = await restoreService.call({
              eventId: checkpointEvent.id,
            });

            if (!checkpoint) {
              logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK failed to restore checkpoint", {
                queueMessage: message.data,
                messageId: message.messageId,
              });

              return {
                action: "ack_and_do_more_work",
                reason: "failed_to_restore_checkpoint",
                attrs: {
                  checkpoint_event_id: checkpointEvent.id,
                },
              };
            }

            logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK restored checkpoint", {
              queueMessage: message.data,
              messageId: message.messageId,
              checkpoint,
            });

            return {
              action: "noop",
              reason: "restored_checkpoint",
              attrs: {
                checkpoint_event_id: data.checkpointEventId,
              },
            };
          } else {
            logger.debug(
              "RESUME_AFTER_DEPENDENCY_WITH_ACK run is frozen without last checkpoint event",
              {
                queueMessage: message.data,
                messageId: message.messageId,
              }
            );

            return {
              action: "noop",
              reason: "resume_after_dependency_with_ack_frozen",
            };
          }
        } catch (e) {
          return {
            action: "nack_and_do_more_work",
            reason: "waiting_to_resume_threw",
            error: e instanceof Error ? e : String(e),
            interval: this._options.nextTickInterval,
            retryInMs: 5_000,
          };
        }
      }

      logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK retrying", {
        queueMessage: message.data,
        messageId: message.messageId,
      });

      return {
        action: "nack_and_do_more_work",
        reason: "resume_after_dependency_with_ack_retrying",
        attrs: {
          message_id: message.messageId,
        },
        interval: this._options.nextTickInterval,
        retryInMs: 5_000,
      };
    } catch (e) {
      if (e instanceof ResumePayloadAttemptsNotFoundError) {
        return {
          action: "ack_and_do_more_work",
          reason: "failed_to_get_resume_payloads_for_attempts",
          attrs: {
            attempt_ids: e.attemptIds.join(","),
          },
        };
      } else if (e instanceof ResumePayloadExecutionNotFoundError) {
        return {
          action: "ack_and_do_more_work",
          reason: "failed_to_get_resume_payloads_missing_execution",
          attrs: {
            attempt_id: e.attemptId,
          },
        };
      } else if (e instanceof ResumePayloadCompletionNotFoundError) {
        return {
          action: "ack_and_do_more_work",
          reason: "failed_to_get_resume_payloads_missing_completion",
          attrs: {
            attempt_id: e.attemptId,
          },
        };
      }

      logger.error("RESUME_AFTER_DEPENDENCY_WITH_ACK threw, nacking with delay", {
        message,
        error: e,
      });

      return {
        action: "nack_and_do_more_work",
        reason: "resume_after_dependency_with_ack_threw",
        error: e instanceof Error ? e : String(e),
        interval: this._options.nextTickInterval,
        retryInMs: 5_000,
      };
    }
  }

  async #handleResumeAfterDurationMessage(
    message: MessagePayload,
    data: SharedQueueResumeAfterDurationMessageBody,
    dequeuedAt: Date
  ): Promise<HandleMessageResult> {
    try {
      const restoreService = new RestoreCheckpointService();

      const checkpoint = await restoreService.call({
        eventId: data.checkpointEventId,
      });

      if (!checkpoint) {
        logger.error("Failed to restore checkpoint", {
          queueMessage: message.data,
          messageId: message.messageId,
        });

        return {
          action: "ack_and_do_more_work",
          reason: "failed_to_restore_checkpoint",
          attrs: {
            checkpoint_event_id: data.checkpointEventId,
          },
        };
      }

      return {
        action: "noop",
        reason: "restored_checkpoint",
        attrs: {
          checkpoint_event_id: data.checkpointEventId,
        },
      };
    } catch (e) {
      return {
        action: "nack_and_do_more_work",
        reason: "restoring_checkpoint_threw",
        error: e instanceof Error ? e : String(e),
      };
    }
  }

  async #handleFailMessage(
    message: MessagePayload,
    data: SharedQueueFailMessageBody,
    dequeuedAt: Date
  ): Promise<HandleMessageResult> {
    const existingTaskRun = await prisma.taskRun.findFirst({
      where: {
        id: message.messageId,
      },
    });

    if (!existingTaskRun) {
      logger.error("No existing task run to fail", {
        queueMessage: data,
        messageId: message.messageId,
      });

      return {
        action: "ack_and_do_more_work",
        reason: "no_existing_task_run",
      };
    }

    // TODO: Consider failing the attempt and retrying instead. This may not be a good idea, as dequeued FAIL messages tend to point towards critical, persistent errors.
    const service = new CrashTaskRunService();
    await service.call(existingTaskRun.id, {
      crashAttempts: true,
      reason: data.reason,
    });

    return {
      action: "ack_and_do_more_work",
      reason: "message_failed",
    };
  }

  async #ack(messageId: string) {
    await marqs?.acknowledgeMessage(messageId, "Acking and doing more work in SharedQueueConsumer");
  }

  async #nack(messageId: string, nackRetryInMs?: number) {
    const retryAt = nackRetryInMs ? Date.now() + nackRetryInMs : undefined;
    await marqs?.nackMessage(messageId, retryAt);
  }

  async #markRunAsWaitingForDeploy(runId: string) {
    logger.debug("Marking run as waiting for deploy", { runId });

    const run = await prisma.taskRun.update({
      where: {
        id: runId,
      },
      data: {
        status: "WAITING_FOR_DEPLOY",
      },
    });
  }

  async #resolveCompletedAttemptsForResumeMessage(
    completedAttemptIds: string[]
  ): Promise<{ completions: TaskRunExecutionResult[]; executions: TaskRunExecution[] }> {
    return await this.#startActiveSpan("resolveCompletedAttemptsForResumeMessage", async (span) => {
      span.setAttribute("completed_attempt_count", completedAttemptIds.length);

      // Chunk the completedAttemptIds into chunks of 10
      const chunkedCompletedAttemptIds = chunk(
        completedAttemptIds,
        env.SHARED_QUEUE_CONSUMER_RESOLVE_PAYLOADS_BATCH_SIZE
      );

      span.setAttribute("chunk_count", chunkedCompletedAttemptIds.length);
      span.setAttribute("chunk_size", env.SHARED_QUEUE_CONSUMER_RESOLVE_PAYLOADS_BATCH_SIZE);

      const allResumePayloads = await this.#startActiveSpan(
        "resolveAllResumePayloads",
        async (span) => {
          span.setAttribute("chunk_count", chunkedCompletedAttemptIds.length);
          span.setAttribute("chunk_size", env.SHARED_QUEUE_CONSUMER_RESOLVE_PAYLOADS_BATCH_SIZE);
          span.setAttribute("completed_attempt_count", completedAttemptIds.length);

          return await Promise.all(
            chunkedCompletedAttemptIds.map(async (attemptIds) => {
              const payloads = await this.#startActiveSpan("getResumePayloads", async (span) => {
                span.setAttribute("attempt_ids", attemptIds.join(","));
                span.setAttribute("attempt_count", attemptIds.length);

                const payloads = await this._tasks.getResumePayloads(attemptIds);

                span.setAttribute("payload_count", payloads.length);

                return payloads;
              });

              return {
                completions: payloads.map((payload) => payload.completion),
                executions: payloads.map((payload) => payload.execution),
              };
            })
          );
        }
      );

      return {
        completions: allResumePayloads.flatMap((payload) => payload.completions),
        executions: allResumePayloads.flatMap((payload) => payload.executions),
      };
    });
  }

  async #startActiveSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions
  ): Promise<T> {
    return await tracer.startActiveSpan(name, options ?? {}, async (span) => {
      if (this._currentMessage) {
        span.setAttribute("message_id", this._currentMessage.messageId);
        span.setAttribute("run_id", this._currentMessage.messageId);
        span.setAttribute("message_version", this._currentMessage.version);
      }

      if (this._currentMessageData) {
        span.setAttribute("message_type", this._currentMessageData.type);
      }

      try {
        return await fn(span);
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
        } else {
          span.recordException(String(error));
        }

        span.setStatus({ code: SpanStatusCode.ERROR });

        throw error;
      } finally {
        span.end();
      }
    });
  }
}

class ResumePayloadAttemptsNotFoundError extends Error {
  constructor(public readonly attemptIds: string[]) {
    super(`Resume payload attempts not found for attempts ${attemptIds.join(", ")}`);
  }
}

class ResumePayloadExecutionNotFoundError extends Error {
  constructor(public readonly attemptId: string) {
    super(`Resume payload execution not found for attempt ${attemptId}`);
  }
}

class ResumePayloadCompletionNotFoundError extends Error {
  constructor(public readonly attemptId: string) {
    super(`Resume payload completion not found for attempt ${attemptId}`);
  }
}

function chunk<T>(arr: T[], chunkSize: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / chunkSize) }, (_, i) =>
    arr.slice(i * chunkSize, i * chunkSize + chunkSize)
  );
}

export const AttemptForCompletionGetPayload = {
  select: {
    status: true,
    output: true,
    outputType: true,
    error: true,
    taskRun: {
      select: {
        taskIdentifier: true,
        friendlyId: true,
      },
    },
  },
} as const;

type AttemptForCompletion = Prisma.TaskRunAttemptGetPayload<typeof AttemptForCompletionGetPayload>;

export const AttemptForExecutionGetPayload = {
  select: {
    id: true,
    friendlyId: true,
    taskRunId: true,
    number: true,
    startedAt: true,
    createdAt: true,
    backgroundWorkerId: true,
    backgroundWorkerTaskId: true,
    backgroundWorker: {
      select: {
        contentHash: true,
        version: true,
      },
    },
    backgroundWorkerTask: {
      select: {
        machineConfig: true,
        slug: true,
        filePath: true,
        exportName: true,
      },
    },
    status: true,
    runtimeEnvironment: {
      select: {
        ...RuntimeEnvironmentForEnvRepoPayload.select,
        organization: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
        project: {
          select: {
            id: true,
            externalRef: true,
            slug: true,
            name: true,
          },
        },
      },
    },
    taskRun: {
      select: {
        id: true,
        status: true,
        traceContext: true,
        machinePreset: true,
        friendlyId: true,
        payload: true,
        payloadType: true,
        context: true,
        createdAt: true,
        startedAt: true,
        isTest: true,
        metadata: true,
        metadataType: true,
        idempotencyKey: true,
        usageDurationMs: true,
        costInCents: true,
        baseCostInCents: true,
        maxDurationInSeconds: true,
        tags: true,
        concurrencyKey: true,
      },
    },
    queue: {
      select: {
        name: true,
        friendlyId: true,
      },
    },
  },
} as const;

type AttemptForExecution = Prisma.TaskRunAttemptGetPayload<typeof AttemptForExecutionGetPayload>;

class SharedQueueTasks {
  private _completionPayloadFromAttempt(attempt: AttemptForCompletion): TaskRunExecutionResult {
    const ok = attempt.status === "COMPLETED";

    if (ok) {
      const success: TaskRunSuccessfulExecutionResult = {
        ok,
        id: attempt.taskRun.friendlyId,
        output: attempt.output ?? undefined,
        outputType: attempt.outputType,
        taskIdentifier: attempt.taskRun.taskIdentifier,
      };
      return success;
    } else {
      const failure: TaskRunFailedExecutionResult = {
        ok,
        id: attempt.taskRun.friendlyId,
        error: attempt.error as TaskRunError,
        taskIdentifier: attempt.taskRun.taskIdentifier,
      };
      return failure;
    }
  }

  private async _executionFromAttempt(
    attempt: AttemptForExecution,
    machinePreset?: MachinePreset
  ): Promise<V3ProdTaskRunExecution> {
    const { backgroundWorkerTask, taskRun, queue } = attempt;

    if (!machinePreset) {
      machinePreset =
        machinePresetFromRun(attempt.taskRun) ??
        machinePresetFromConfig(backgroundWorkerTask.machineConfig ?? {});
    }

    const metadata = await parsePacket({
      data: taskRun.metadata ?? undefined,
      dataType: taskRun.metadataType,
    });

    const execution: V3ProdTaskRunExecution = {
      task: {
        id: backgroundWorkerTask.slug,
        filePath: backgroundWorkerTask.filePath,
        exportName: backgroundWorkerTask.exportName ?? backgroundWorkerTask.slug,
      },
      attempt: {
        id: attempt.friendlyId,
        number: attempt.number,
        startedAt: attempt.startedAt ?? attempt.createdAt,
        backgroundWorkerId: attempt.backgroundWorkerId,
        backgroundWorkerTaskId: attempt.backgroundWorkerTaskId,
        status: "EXECUTING" as const,
      },
      run: {
        id: taskRun.friendlyId,
        payload: taskRun.payload,
        payloadType: taskRun.payloadType,
        context: taskRun.context,
        createdAt: taskRun.createdAt,
        startedAt: taskRun.startedAt ?? taskRun.createdAt,
        tags: taskRun.tags.map((tag) => tag.name),
        isTest: taskRun.isTest,
        idempotencyKey: taskRun.idempotencyKey ?? undefined,
        durationMs: taskRun.usageDurationMs,
        costInCents: taskRun.costInCents,
        baseCostInCents: taskRun.baseCostInCents,
        metadata,
        maxDuration: taskRun.maxDurationInSeconds ?? undefined,
        concurrencyKey: taskRun.concurrencyKey ?? undefined,
      },
      queue: {
        id: queue.friendlyId,
        name: queue.name,
      },
      environment: {
        id: attempt.runtimeEnvironment.id,
        slug: attempt.runtimeEnvironment.slug,
        type: attempt.runtimeEnvironment.type,
      },
      organization: {
        id: attempt.runtimeEnvironment.organization.id,
        slug: attempt.runtimeEnvironment.organization.slug,
        name: attempt.runtimeEnvironment.organization.title,
      },
      project: {
        id: attempt.runtimeEnvironment.project.id,
        ref: attempt.runtimeEnvironment.project.externalRef,
        slug: attempt.runtimeEnvironment.project.slug,
        name: attempt.runtimeEnvironment.project.name,
      },
      batch: undefined, // TODO: Removing this for now until we can do it more efficiently
      worker: {
        id: attempt.backgroundWorkerId,
        contentHash: attempt.backgroundWorker.contentHash,
        version: attempt.backgroundWorker.version,
      },
      machine: machinePreset,
    };

    return execution;
  }

  async getCompletionPayloadFromAttempt(id: string): Promise<TaskRunExecutionResult | undefined> {
    const attempt = await prisma.taskRunAttempt.findFirst({
      where: {
        id,
        status: {
          in: FINAL_ATTEMPT_STATUSES,
        },
      },
      ...AttemptForCompletionGetPayload,
    });

    if (!attempt) {
      logger.error("No completed attempt found", { id });
      return;
    }

    return this._completionPayloadFromAttempt(attempt);
  }

  async getExecutionPayloadFromAttempt({
    id,
    setToExecuting,
    isRetrying,
    skipStatusChecks,
  }: {
    id: string;
    setToExecuting?: boolean;
    isRetrying?: boolean;
    skipStatusChecks?: boolean;
  }): Promise<V3ProdTaskRunExecutionPayload | undefined> {
    const attempt = await prisma.taskRunAttempt.findFirst({
      where: {
        id,
      },
      ...AttemptForExecutionGetPayload,
    });

    if (!attempt) {
      logger.error("getExecutionPayloadFromAttempt: No attempt found", { id });
      return;
    }

    if (!skipStatusChecks) {
      switch (attempt.status) {
        case "CANCELED":
        case "EXECUTING": {
          logger.error(
            "getExecutionPayloadFromAttempt: Invalid attempt status for execution payload retrieval",
            {
              attemptId: id,
              status: attempt.status,
            }
          );
          return;
        }
      }

      switch (attempt.taskRun.status) {
        case "CANCELED":
        case "EXECUTING":
        case "INTERRUPTED": {
          logger.error(
            "getExecutionPayloadFromAttempt: Invalid run status for execution payload retrieval",
            {
              attemptId: id,
              runId: attempt.taskRunId,
              status: attempt.taskRun.status,
            }
          );
          return;
        }
      }
    }

    if (setToExecuting) {
      if (isFinalAttemptStatus(attempt.status) || isFinalRunStatus(attempt.taskRun.status)) {
        logger.error("getExecutionPayloadFromAttempt: Status already in final state", {
          attempt: {
            id: attempt.id,
            status: attempt.status,
          },
          run: {
            id: attempt.taskRunId,
            status: attempt.taskRun.status,
          },
        });
        return;
      }

      await prisma.taskRunAttempt.update({
        where: {
          id,
        },
        data: {
          status: "EXECUTING",
          taskRun: {
            update: {
              data: {
                status: isRetrying ? "RETRYING_AFTER_FAILURE" : "EXECUTING",
              },
            },
          },
        },
      });
    }

    const { backgroundWorkerTask, taskRun } = attempt;

    const machinePreset =
      machinePresetFromRun(attempt.taskRun) ??
      machinePresetFromConfig(backgroundWorkerTask.machineConfig ?? {});

    const execution = await this._executionFromAttempt(attempt, machinePreset);
    const variables = await this.#buildEnvironmentVariables(
      attempt.runtimeEnvironment,
      taskRun.id,
      machinePreset
    );

    const payload: V3ProdTaskRunExecutionPayload = {
      execution,
      traceContext: taskRun.traceContext as Record<string, unknown>,
      environment: variables.reduce((acc: Record<string, string>, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {}),
    };

    return payload;
  }

  async getResumePayload(attemptId: string): Promise<
    | {
        execution: V3ProdTaskRunExecution;
        completion: TaskRunExecutionResult;
      }
    | undefined
  > {
    const attempt = await prisma.taskRunAttempt.findFirst({
      where: {
        id: attemptId,
      },
      select: {
        ...AttemptForExecutionGetPayload.select,
        error: true,
        output: true,
        outputType: true,
        taskRun: {
          select: {
            ...AttemptForExecutionGetPayload.select.taskRun.select,
            taskIdentifier: true,
          },
        },
      },
    });

    if (!attempt) {
      logger.error("getResumePayload: No attempt found", { id: attemptId });
      return;
    }

    const execution = await this._executionFromAttempt(attempt);
    const completion = this._completionPayloadFromAttempt(attempt);

    return {
      execution,
      completion,
    };
  }

  async getResumePayloads(attemptIds: string[]): Promise<
    Array<{
      execution: V3ProdTaskRunExecution;
      completion: TaskRunExecutionResult;
    }>
  > {
    const attempts = await prisma.taskRunAttempt.findMany({
      where: {
        id: {
          in: attemptIds,
        },
      },
      select: {
        ...AttemptForExecutionGetPayload.select,
        error: true,
        output: true,
        outputType: true,
        taskRun: {
          select: {
            ...AttemptForExecutionGetPayload.select.taskRun.select,
            taskIdentifier: true,
          },
        },
      },
    });

    if (attempts.length !== attemptIds.length) {
      logger.error("getResumePayloads: Not all attempts found", { attemptIds });

      throw new ResumePayloadAttemptsNotFoundError(attemptIds);
    }

    const payloads = await Promise.all(
      attempts.map(async (attempt) => {
        const execution = await this._executionFromAttempt(attempt);

        if (!execution) {
          throw new ResumePayloadExecutionNotFoundError(attempt.id);
        }

        const completion = this._completionPayloadFromAttempt(attempt);

        if (!completion) {
          throw new ResumePayloadCompletionNotFoundError(attempt.id);
        }

        return {
          execution,
          completion,
        };
      })
    );

    return payloads;
  }

  async getLatestExecutionPayloadFromRun(
    id: string,
    setToExecuting?: boolean,
    isRetrying?: boolean
  ): Promise<V3ProdTaskRunExecutionPayload | undefined> {
    const run = await prisma.taskRun.findFirst({
      where: {
        id,
      },
      include: {
        attempts: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    const latestAttempt = run?.attempts[0];

    if (!latestAttempt) {
      logger.error("No attempts for run", { id });
      return;
    }

    return this.getExecutionPayloadFromAttempt({
      id: latestAttempt.id,
      setToExecuting,
      isRetrying,
    });
  }

  async getLazyAttemptPayload(
    envId: string,
    runId: string
  ): Promise<TaskRunExecutionLazyAttemptPayload | undefined> {
    const environment = await findEnvironmentById(envId);

    if (!environment) {
      logger.error("getLazyAttemptPayload: Environment not found", { runId, envId });
      return;
    }

    const run = await prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      select: {
        id: true,
        traceContext: true,
        friendlyId: true,
        isTest: true,
        lockedBy: {
          select: {
            machineConfig: true,
          },
        },
        machinePreset: true,
      },
    });

    if (!run) {
      logger.error("getLazyAttemptPayload: Run not found", { runId, envId });
      return;
    }

    const attemptCount = await prisma.taskRunAttempt.count({
      where: {
        taskRunId: run.id,
      },
    });

    logger.debug("getLazyAttemptPayload: Getting lazy attempt payload for run", {
      run,
      attemptCount,
    });

    const machinePreset =
      machinePresetFromRun(run) ?? machinePresetFromConfig(run.lockedBy?.machineConfig ?? {});

    const variables = await this.#buildEnvironmentVariables(environment, run.id, machinePreset);

    return {
      traceContext: run.traceContext as Record<string, unknown>,
      environment: variables.reduce((acc: Record<string, string>, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {}),
      runId: run.friendlyId,
      messageId: run.id,
      isTest: run.isTest,
      attemptCount,
      metrics: [],
    } satisfies TaskRunExecutionLazyAttemptPayload;
  }

  async taskHeartbeat(attemptFriendlyId: string) {
    logger.debug("[SharedQueueConsumer] taskHeartbeat()", { id: attemptFriendlyId });

    const taskRunAttempt = await prisma.taskRunAttempt.findFirst({
      where: { friendlyId: attemptFriendlyId },
    });

    if (!taskRunAttempt) {
      return;
    }

    await this.#heartbeat(taskRunAttempt.taskRunId);
  }

  async taskRunHeartbeat(runId: string) {
    logger.debug("[SharedQueueConsumer] taskRunHeartbeat()", { runId });

    await this.#heartbeat(runId);
  }

  public async taskRunFailed(completion: TaskRunFailedExecutionResult) {
    logger.debug("[SharedQueueConsumer] taskRunFailed()", { completion });

    const service = new FailedTaskRunService();

    await service.call(completion.id, completion);
  }

  async #heartbeat(runId: string) {
    await marqs?.heartbeatMessage(runId);

    try {
      // There can be a lot of calls per minute and the data doesn't have to be accurate, so use the read replica
      const taskRun = await $replica.taskRun.findFirst({
        where: {
          id: runId,
        },
        select: {
          id: true,
          status: true,
          runtimeEnvironment: {
            select: {
              type: true,
            },
          },
          lockedToVersion: {
            select: {
              supportsLazyAttempts: true,
            },
          },
        },
      });

      if (!taskRun) {
        logger.error("SharedQueueTasks.#heartbeat: Task run not found", {
          runId,
        });

        return;
      }

      if (taskRun.runtimeEnvironment.type === "DEVELOPMENT") {
        return;
      }

      if (isFinalRunStatus(taskRun.status)) {
        logger.debug("SharedQueueTasks.#heartbeat: Task run is in final status", {
          runId,
          status: taskRun.status,
        });

        // Signal to exit any leftover containers
        socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", {
          version: "v1",
          runId: taskRun.id,
          // Give the run a few seconds to exit to complete any flushing etc
          delayInMs: taskRun.lockedToVersion?.supportsLazyAttempts ? 5_000 : undefined,
        });
        return;
      }
    } catch (error) {
      logger.error("SharedQueueTasks.#heartbeat: Error signaling run cancellation", {
        runId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  async #buildEnvironmentVariables(
    environment: RuntimeEnvironmentForEnvRepo,
    runId: string,
    machinePreset: MachinePreset
  ): Promise<Array<EnvironmentVariable>> {
    const variables = await resolveVariablesForEnvironment(environment);

    const jwt = await generateJWTTokenForEnvironment(environment, {
      run_id: runId,
      machine_preset: machinePreset.name,
    });

    return [
      ...variables,
      ...[
        { key: "TRIGGER_JWT", value: jwt },
        { key: "TRIGGER_RUN_ID", value: runId },
        {
          key: "TRIGGER_MACHINE_PRESET",
          value: machinePreset.name,
        },
      ],
    ];
  }
}

export const sharedQueueTasks = singleton("sharedQueueTasks", () => new SharedQueueTasks());
