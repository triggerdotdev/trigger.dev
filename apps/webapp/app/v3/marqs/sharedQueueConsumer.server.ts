import { Context, ROOT_CONTEXT, Span, SpanKind, context, trace } from "@opentelemetry/api";
import {
  ProdTaskRunExecutionPayload,
  RetryOptions,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
  ZodMessageSender,
  defaultRetryOptions,
  flattenAttributes,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { BackgroundWorker, BackgroundWorkerTask } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { eventRepository } from "../eventRepository.server";

const tracer = trace.getTracer("sharedQueueConsumer");

const MessageBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE"),
    taskIdentifier: z.string(),
  }),
]);

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type SharedQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
};

export class SharedQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _options: Required<SharedQueueConsumerOptions>;
  private _perTraceCountdown: number | undefined;
  private _lastNewTrace: Date | undefined;
  private _currentSpanContext: Context | undefined;
  private _taskFailures: number = 0;
  private _taskSuccesses: number = 0;
  private _currentSpan: Span | undefined;
  private _endSpanInNextIteration = false;

  constructor(
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>,
    options: SharedQueueConsumerOptions = {}
  ) {
    this._options = {
      maximumItemsPerTrace: options.maximumItemsPerTrace ?? 1_000, // 1k items per trace
      traceTimeoutSeconds: options.traceTimeoutSeconds ?? 60, // 60 seconds
    };
  }

  public async registerBackgroundWorker(id: string, envId?: string) {
    if (!envId) {
      logger.error("Environment ID is required for background worker registration", {
        backgroundWorkerId: id,
      });
      return;
    }

    const backgroundWorker = await prisma.backgroundWorker.findUnique({
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

  public async stop() {
    this._enabled = false;
  }

  #enable() {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    this._perTraceCountdown = this._options.maximumItemsPerTrace;
    this._lastNewTrace = new Date();
    this._taskFailures = 0;
    this._taskSuccesses = 0;

    this.#doWork().finally(() => {});
  }

  async #doWork() {
    if (!this._enabled) {
      return;
    }

    // Check if the trace has expired
    if (
      this._perTraceCountdown === 0 ||
      Date.now() - this._lastNewTrace!.getTime() > this._options.traceTimeoutSeconds * 1000 ||
      this._currentSpanContext === undefined ||
      this._endSpanInNextIteration
    ) {
      if (this._currentSpan) {
        this._currentSpan.setAttribute("tasks.period.failures", this._taskFailures);
        this._currentSpan.setAttribute("tasks.period.successes", this._taskSuccesses);

        this._currentSpan.end();
      }

      // Create a new trace
      this._currentSpan = tracer.startSpan(
        "SharedQueueConsumer.doWork()",
        {
          kind: SpanKind.CONSUMER,
        },
        ROOT_CONTEXT
      );

      // Get the span trace context
      this._currentSpanContext = trace.setSpan(ROOT_CONTEXT, this._currentSpan);

      this._perTraceCountdown = this._options.maximumItemsPerTrace;
      this._lastNewTrace = new Date();
      this._taskFailures = 0;
      this._taskSuccesses = 0;
      this._endSpanInNextIteration = false;
    }

    return context.with(this._currentSpanContext ?? ROOT_CONTEXT, async () => {
      await this.#doWorkInternal();
      this._perTraceCountdown = this._perTraceCountdown! - 1;
    });
  }

  async #doWorkInternal() {
    // Attempt to dequeue a message from the shared queue
    // If no message is available, reschedule the worker to run again in 1 second
    // If a message is available, find the BackgroundWorkerTask that matches the message's taskIdentifier
    // If no matching task is found, nack the message and reschedule the worker to run again in 1 second
    // If the matching task is found, create the task attempt and lock the task run, then send the task run to the client
    // Store the message as a processing message
    // If the websocket connection disconnects before the task run is completed, nack the message
    // When the task run completes, ack the message
    // Using a heartbeat mechanism, if the client keeps responding with a heartbeat, we'll keep the message processing and increase the visibility timeout.

    const message = await marqs?.dequeueMessageInSharedQueue();

    if (!message) {
      setTimeout(() => this.#doWork(), 1000);
      return;
    }

    console.log("dequeueMessageInSharedQueue()", message);

    const envId = this.#envIdFromQueue(message.queue);

    const environment = await prisma.runtimeEnvironment.findUnique({
      include: {
        organization: true,
        project: true,
      },
      where: {
        id: envId,
      },
    });

    if (!environment) {
      logger.error("Environment not found", {
        queueMessage: message.data,
        envId,
      });
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const messageBody = MessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
        env: environment,
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const existingTaskRun = await prisma.taskRun.findUnique({
      where: {
        id: message.messageId,
      },
    });

    if (!existingTaskRun) {
      logger.error("No existing task run", {
        queueMessage: message.data,
        messageId: message.messageId,
      });
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundWorker = await prisma.backgroundWorker.findFirst({
      where: {
        runtimeEnvironmentId: existingTaskRun.runtimeEnvironmentId,
        projectId: existingTaskRun.projectId,
        imageDetails: {
          some: {},
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        tasks: true,
        imageDetails: true,
      },
    });

    if (!backgroundWorker) {
      logger.error("No matching background worker found for task run", {
        queueMessage: message.data,
        messageId: message.messageId,
      });
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundTask = backgroundWorker.tasks.find(
      (task) => task.slug === existingTaskRun.taskIdentifier
    );

    if (!backgroundTask) {
      logger.warn("No matching background task found for task run", {
        taskRun: existingTaskRun.id,
        taskIdentifier: existingTaskRun.taskIdentifier,
        backgroundWorker: backgroundWorker.id,
        taskSlugs: backgroundWorker.tasks.map((task) => task.slug),
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const lockedTaskRun = await prisma.taskRun.update({
      where: {
        id: message.messageId,
      },
      data: {
        lockedAt: new Date(),
        lockedById: backgroundTask.id,
      },
      include: {
        attempts: {
          take: 1,
          orderBy: { number: "desc" },
        },
        tags: true,
      },
    });

    if (!lockedTaskRun) {
      logger.warn("Failed to lock task run", {
        taskRun: existingTaskRun.id,
        taskIdentifier: existingTaskRun.taskIdentifier,
        backgroundWorker: backgroundWorker.id,
        messageId: message.messageId,
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const queue = await prisma.taskQueue.findUnique({
      where: {
        runtimeEnvironmentId_name: {
          runtimeEnvironmentId: environment.id,
          name: lockedTaskRun.queue,
        },
      },
    });

    if (!queue) {
      await marqs?.nackMessage(message.messageId);
      setTimeout(() => this.#doWork(), 1000);
      return;
    }

    if (!this._enabled) {
      await marqs?.nackMessage(message.messageId);
      return;
    }

    const taskRunAttempt = await prisma.taskRunAttempt.create({
      data: {
        number: lockedTaskRun.attempts[0] ? lockedTaskRun.attempts[0].number + 1 : 1,
        friendlyId: generateFriendlyId("attempt"),
        taskRunId: lockedTaskRun.id,
        startedAt: new Date(),
        backgroundWorkerId: backgroundTask.workerId,
        backgroundWorkerTaskId: backgroundTask.id,
        status: "PENDING" as const,
        queueId: queue.id,
      },
    });

    try {
      // TODO: send trace context down to the CLI
      await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
        backgroundWorkerId: backgroundWorker.friendlyId,
        data: {
          type: "SCHEDULE_ATTEMPT",
          id: taskRunAttempt.id,
          image: backgroundWorker.imageDetails[0].tag,
        },
      });
    } catch (e) {
      if (e instanceof Error) {
        this._currentSpan?.recordException(e);
      } else {
        this._currentSpan?.recordException(new Error(String(e)));
      }

      this._endSpanInNextIteration = true;

      // We now need to unlock the task run and delete the task run attempt
      await prisma.$transaction([
        prisma.taskRun.update({
          where: {
            id: lockedTaskRun.id,
          },
          data: {
            lockedAt: null,
            lockedById: null,
          },
        }),
        prisma.taskRunAttempt.delete({
          where: {
            id: taskRunAttempt.id,
          },
        }),
      ]);

      // Finally we need to nack the message so it can be retried
      await marqs?.nackMessage(message.messageId);
    } finally {
      setTimeout(() => this.#doWork(), 100);
    }
  }

  #envIdFromQueue(queueName: string) {
    return queueName.split(":")[1];
  }
}

export class SharedQueueTasks {
  async getExecutionPayloadFromAttempt(id: string): Promise<ProdTaskRunExecutionPayload> {
    const attempt = await prisma.taskRunAttempt.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        backgroundWorker: true,
        backgroundWorkerTask: true,
        taskRun: {
          include: {
            runtimeEnvironment: {
              include: {
                organization: true,
                project: true,
              },
            },
            tags: true,
          },
        },
        queue: true,
      },
    });

    const { backgroundWorkerTask, taskRun, queue } = attempt;

    const execution = {
      task: {
        id: backgroundWorkerTask.slug,
        filePath: backgroundWorkerTask.filePath,
        exportName: backgroundWorkerTask.exportName,
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
        tags: taskRun.tags.map((tag) => tag.name),
      },
      queue: {
        id: queue.friendlyId,
        name: queue.name,
      },
      environment: {
        id: taskRun.runtimeEnvironment.id,
        slug: taskRun.runtimeEnvironment.slug,
        type: taskRun.runtimeEnvironment.type,
      },
      organization: {
        id: taskRun.runtimeEnvironment.organization.id,
        slug: taskRun.runtimeEnvironment.organization.slug,
        name: taskRun.runtimeEnvironment.organization.title,
      },
      project: {
        id: taskRun.runtimeEnvironment.project.id,
        ref: taskRun.runtimeEnvironment.project.externalRef,
        slug: taskRun.runtimeEnvironment.project.slug,
        name: taskRun.runtimeEnvironment.project.name,
      },
      worker: {
        id: attempt.backgroundWorkerId,
        contentHash: attempt.backgroundWorker.contentHash,
        version: attempt.backgroundWorker.version,
      },
    };

    const payload = {
      execution,
      traceContext: taskRun.traceContext as Record<string, unknown>,
    };

    return payload;
  }

  async completeTaskRun(completion: TaskRunExecutionResult, execution: TaskRunExecution) {
    logger.debug("Task run completed", { taskRunCompletion: completion });

    const taskRunAttempt = completion.ok
      ? await prisma.taskRunAttempt.update({
          where: { friendlyId: completion.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            output: completion.output,
            outputType: completion.outputType,
          },
          include: {
            taskRun: true,
            backgroundWorkerTask: true,
          },
        })
      : await prisma.taskRunAttempt.update({
          where: { friendlyId: completion.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            error: completion.error,
          },
          include: {
            taskRun: true,
            backgroundWorkerTask: true,
          },
        });

    if (!completion.ok && completion.retry !== undefined) {
      const retryConfig = taskRunAttempt.backgroundWorkerTask.retryConfig
        ? {
            ...defaultRetryOptions,
            ...RetryOptions.parse(taskRunAttempt.backgroundWorkerTask.retryConfig),
          }
        : undefined;

      const environment = await prisma.runtimeEnvironment.findUniqueOrThrow({
        where: {
          id: execution.environment.id,
        },
        include: {
          project: true,
          organization: true,
        },
      });

      const retryAt = new Date(completion.retry.timestamp);
      // Retry the task run
      await eventRepository.recordEvent(
        retryConfig?.maxAttempts
          ? `Retry ${execution.attempt.number}/${retryConfig?.maxAttempts - 1} delay`
          : `Retry #${execution.attempt.number} delay`,
        {
          taskSlug: taskRunAttempt.taskRun.taskIdentifier,
          environment: environment,
          attributes: {
            metadata: this.#generateMetadataAttributesForNextAttempt(execution),
            properties: {
              retryAt: retryAt.toISOString(),
              factor: retryConfig?.factor,
              maxAttempts: retryConfig?.maxAttempts,
              minTimeoutInMs: retryConfig?.minTimeoutInMs,
              maxTimeoutInMs: retryConfig?.maxTimeoutInMs,
              randomize: retryConfig?.randomize,
            },
            runId: taskRunAttempt.taskRunId,
            style: {
              icon: "schedule-attempt",
            },
            queueId: taskRunAttempt.queueId,
            queueName: taskRunAttempt.taskRun.queue,
          },
          context: taskRunAttempt.taskRun.traceContext as Record<string, string | undefined>,
          spanIdSeed: `retry-${taskRunAttempt.number + 1}`,
          endTime: retryAt,
        }
      );

      await marqs?.nackMessage(taskRunAttempt.taskRunId, completion.retry.timestamp);
    } else {
      await marqs?.acknowledgeMessage(taskRunAttempt.taskRunId);
    }
  }

  #generateMetadataAttributesForNextAttempt(execution: TaskRunExecution) {
    const context = TaskRunContext.parse(execution);

    // @ts-ignore
    context.attempt = {
      number: context.attempt.number + 1,
    };

    return flattenAttributes(context, "ctx");
  }

  async taskHeartbeat(id: string, seconds: number = 60) {
    const taskRunAttempt = await prisma.taskRunAttempt.findUnique({
      where: { friendlyId: id },
    });

    if (!taskRunAttempt) {
      return;
    }

    await marqs?.heartbeatMessage(taskRunAttempt.taskRunId, seconds);
  }
}
