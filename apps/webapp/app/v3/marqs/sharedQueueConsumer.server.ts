import {
  Context,
  ROOT_CONTEXT,
  Span,
  SpanKind,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";
import {
  Machine,
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  TaskRunError,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  ZodMessageSender,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import {
  BackgroundWorker,
  BackgroundWorkerTask,
  TaskRunAttemptStatus,
  TaskRunStatus,
} from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { EnvironmentVariablesRepository } from "../environmentVariables/environmentVariablesRepository.server";
import { CancelAttemptService } from "../services/cancelAttempt.server";
import { socketIo } from "../handleSocketIo.server";
import { singleton } from "~/utils/singleton";
import { RestoreCheckpointService } from "../services/restoreCheckpoint.server";
import { findCurrentWorkerDeployment } from "../models/workerDeployment.server";

const tracer = trace.getTracer("sharedQueueConsumer");

const WithTraceContext = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

const MessageBody = z.discriminatedUnion("type", [
  WithTraceContext.extend({
    type: z.literal("EXECUTE"),
    taskIdentifier: z.string(),
    checkpointEventId: z.string().optional(),
  }),
  WithTraceContext.extend({
    type: z.literal("RESUME"),
    completedAttemptIds: z.string().array(),
    resumableAttemptId: z.string(),
    checkpointEventId: z.string().optional(),
  }),
  WithTraceContext.extend({
    type: z.literal("RESUME_AFTER_DURATION"),
    resumableAttemptId: z.string(),
    checkpointEventId: z.string(),
  }),
]);

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type SharedQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
  nextTickInterval?: number;
  interval?: number;
  parentContext?: Context;
};

export class SharedQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _deprecatedWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _options: Required<SharedQueueConsumerOptions>;
  private _perTraceCountdown: number | undefined;
  private _lastNewTrace: Date | undefined;
  private _currentSpanContext: Context | undefined;
  private _taskFailures: number = 0;
  private _taskSuccesses: number = 0;
  private _currentSpan: Span | undefined;
  private _endSpanInNextIteration = false;
  private _tasks = sharedQueueTasks;
  private _inProgressAttempts: Map<string, string> = new Map(); // Keys are task attempt friendly IDs, values are TaskRun ids/queue message ids

  constructor(
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>,
    options: SharedQueueConsumerOptions = {}
  ) {
    this._options = {
      maximumItemsPerTrace: options.maximumItemsPerTrace ?? 1_000, // 1k items per trace
      traceTimeoutSeconds: options.traceTimeoutSeconds ?? 60, // 60 seconds
      nextTickInterval: options.nextTickInterval ?? 1000, // 1 second
      interval: options.interval ?? 100, // 100ms
      parentContext: options.parentContext ?? ROOT_CONTEXT,
    };
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

  public async stop(reason: string = "Provider disconnected") {
    if (!this._enabled) {
      return;
    }

    logger.debug("Stopping shared queue consumer");
    this._enabled = false;
  }

  async #cancelInProgressAttempts(reason: string) {
    const service = new CancelAttemptService();

    const cancelledAt = new Date();

    const inProgressAttempts = new Map(this._inProgressAttempts);

    this._inProgressAttempts.clear();

    for (const [attemptId, messageId] of inProgressAttempts) {
      await this.#cancelInProgressAttempt(attemptId, messageId, service, cancelledAt, reason);
    }
  }

  async #cancelInProgressAttempt(
    attemptId: string,
    messageId: string,
    cancelAttemptService: CancelAttemptService,
    cancelledAt: Date,
    reason: string
  ) {
    try {
      await cancelAttemptService.call(attemptId, messageId, cancelledAt, reason);
    } catch (e) {
      logger.error("Failed to cancel in progress attempt", {
        attemptId,
        messageId,
        error: e,
      });
    }
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

  #endCurrentSpan() {
    if (this._currentSpan) {
      this._currentSpan.setAttribute("tasks.period.failures", this._taskFailures);
      this._currentSpan.setAttribute("tasks.period.successes", this._taskSuccesses);
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
      Date.now() - this._lastNewTrace!.getTime() > this._options.traceTimeoutSeconds * 1000 ||
      this._currentSpanContext === undefined ||
      this._endSpanInNextIteration
    ) {
      this.#endCurrentSpan();

      const parentContext = this._options.parentContext ?? ROOT_CONTEXT;

      // Create a new trace
      this._currentSpan = tracer.startSpan(
        "SharedQueueConsumer.doWork()",
        {
          kind: SpanKind.CONSUMER,
        },
        parentContext
      );

      // Get the span trace context
      this._currentSpanContext = trace.setSpan(parentContext, this._currentSpan);

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
      this.#doMoreWork(this._options.nextTickInterval);
      return;
    }

    logger.log("dequeueMessageInSharedQueue()", { queueMessage: message });

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

      this.#ackAndDoMoreWork(message.messageId);
      return;
    }

    const messageBody = MessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
        env: environment,
      });

      this.#ackAndDoMoreWork(message.messageId);
      return;
    }

    switch (messageBody.data.type) {
      case "EXECUTE": {
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

          this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const retryingFromCheckpoint = !!messageBody.data.checkpointEventId;

        const EXECUTABLE_RUN_STATUSES: {
          fromCheckpoint: TaskRunStatus[];
          withoutCheckpoint: TaskRunStatus[];
        } = {
          fromCheckpoint: ["WAITING_TO_RESUME"],
          withoutCheckpoint: ["PENDING", "RETRYING_AFTER_FAILURE"],
        };

        if (
          (retryingFromCheckpoint &&
            !EXECUTABLE_RUN_STATUSES.fromCheckpoint.includes(existingTaskRun.status)) ||
          (!retryingFromCheckpoint &&
            !EXECUTABLE_RUN_STATUSES.withoutCheckpoint.includes(existingTaskRun.status))
        ) {
          logger.debug("Task run has invalid status for execution", {
            queueMessage: message.data,
            messageId: message.messageId,
            taskRun: existingTaskRun.id,
            status: existingTaskRun.status,
            retryingFromCheckpoint,
          });

          this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const deployment = await findCurrentWorkerDeployment(existingTaskRun.runtimeEnvironmentId);

        if (!deployment || !deployment.worker) {
          logger.error("No matching deployment found for task run", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        if (!deployment.imageReference) {
          logger.error("Deployment is missing an image reference", {
            queueMessage: message.data,
            messageId: message.messageId,
            deployment: deployment.id,
          });

          this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const backgroundTask = deployment.worker.tasks.find(
          (task) => task.slug === existingTaskRun.taskIdentifier
        );

        if (!backgroundTask) {
          logger.warn("No matching background task found for task run", {
            taskRun: existingTaskRun.id,
            taskIdentifier: existingTaskRun.taskIdentifier,
            deployment: deployment.id,
            backgroundWorker: deployment.worker.id,
            taskSlugs: deployment.worker.tasks.map((task) => task.slug),
          });

          this.#ackAndDoMoreWork(message.messageId);
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
            checkpoints: {
              take: 1,
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        });

        if (!lockedTaskRun) {
          logger.warn("Failed to lock task run", {
            taskRun: existingTaskRun.id,
            taskIdentifier: existingTaskRun.taskIdentifier,
            deployment: deployment.id,
            backgroundWorker: deployment.worker.id,
            messageId: message.messageId,
          });

          this.#ackAndDoMoreWork(message.messageId);
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
          await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval);
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
            runtimeEnvironmentId: environment.id,
          },
          include: {
            backgroundWorkerTask: true,
          },
        });

        const isRetry = taskRunAttempt.number > 1;

        const { machineConfig } = taskRunAttempt.backgroundWorkerTask;
        const machine = Machine.safeParse(machineConfig ?? {});

        if (!machine.success) {
          logger.error("Failed to parse machine config", {
            queueMessage: message.data,
            messageId: message.messageId,
            attemptId: taskRunAttempt.id,
            machineConfig,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }
        try {
          if (messageBody.data.checkpointEventId) {
            const restoreService = new RestoreCheckpointService();

            const checkpoint = await restoreService.call({
              eventId: messageBody.data.checkpointEventId,
              isRetry,
            });

            if (!checkpoint) {
              logger.error("Failed to restore checkpoint", {
                queueMessage: message.data,
                messageId: message.messageId,
              });

              await this.#ackAndDoMoreWork(message.messageId);
              return;
            }
          } else if (isRetry) {
            socketIo.coordinatorNamespace.emit("READY_FOR_RETRY", {
              version: "v1",
              runId: taskRunAttempt.taskRunId,
            });
          } else {
            await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
              backgroundWorkerId: deployment.worker.friendlyId,
              data: {
                type: "SCHEDULE_ATTEMPT",
                image: deployment.imageReference,
                version: deployment.version,
                machine: machine.data,
                // identifiers
                id: taskRunAttempt.id,
                envId: environment.id,
                envType: environment.type,
                orgId: environment.organizationId,
                projectId: environment.projectId,
                runId: taskRunAttempt.taskRunId,
              },
            });
          }

          this._inProgressAttempts.set(taskRunAttempt.friendlyId, message.messageId);
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

          await this.#nackAndDoMoreWork(message.messageId);
          return;
        }

        break;
      }
      // Resume after dependency completed with no remaining retries
      case "RESUME": {
        if (messageBody.data.checkpointEventId) {
          try {
            const restoreService = new RestoreCheckpointService();

            const checkpoint = await restoreService.call({
              eventId: messageBody.data.checkpointEventId,
            });

            if (!checkpoint) {
              logger.error("Failed to restore checkpoint", {
                queueMessage: message.data,
                messageId: message.messageId,
              });

              await this.#ackAndDoMoreWork(message.messageId);
              return;
            }
          } catch (e) {
            if (e instanceof Error) {
              this._currentSpan?.recordException(e);
            } else {
              this._currentSpan?.recordException(new Error(String(e)));
            }

            this._endSpanInNextIteration = true;

            await this.#nackAndDoMoreWork(message.messageId);
            return;
          }

          this.#doMoreWork();
          return;
        }

        if (messageBody.data.completedAttemptIds.length < 1) {
          logger.error("No attempt IDs provided", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const resumableRun = await prisma.taskRun.findUnique({
          where: {
            id: message.messageId,
          },
        });

        if (!resumableRun) {
          logger.error("Resumable run not found", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const resumableAttempt = await prisma.taskRunAttempt.findUnique({
          where: {
            id: messageBody.data.resumableAttemptId,
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

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: environment.id,
              name: resumableRun.queue,
            },
          },
        });

        if (!queue) {
          await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval);
          return;
        }

        if (!this._enabled) {
          await marqs?.nackMessage(message.messageId);
          return;
        }

        const completions: TaskRunExecutionResult[] = [];
        const executions: TaskRunExecution[] = [];

        for (const completedAttemptId of messageBody.data.completedAttemptIds) {
          const completedAttempt = await prisma.taskRunAttempt.findUnique({
            where: {
              id: completedAttemptId,
              taskRun: {
                lockedAt: {
                  not: null,
                },
                lockedById: {
                  not: null,
                },
              },
            },
          });

          if (!completedAttempt) {
            logger.error("Completed attempt not found", {
              queueMessage: message.data,
              messageId: message.messageId,
            });

            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }

          const completion = await this._tasks.getCompletionPayloadFromAttempt(completedAttempt.id);

          if (!completion) {
            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }

          completions.push(completion);

          const executionPayload = await this._tasks.getExecutionPayloadFromAttempt(
            completedAttempt.id
          );

          if (!executionPayload) {
            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }

          executions.push(executionPayload.execution);
        }

        try {
          // The attempt should still be running so we can broadcast to all coordinators to resume immediately
          socketIo.coordinatorNamespace.emit("RESUME_AFTER_DEPENDENCY", {
            version: "v1",
            runId: resumableAttempt.taskRunId,
            attemptId: resumableAttempt.id,
            attemptFriendlyId: resumableAttempt.friendlyId,
            completions,
            executions,
          });
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          await this.#nackAndDoMoreWork(message.messageId);
          return;
        }

        break;
      }
      // Resume after duration-based wait
      case "RESUME_AFTER_DURATION": {
        try {
          const restoreService = new RestoreCheckpointService();

          const checkpoint = await restoreService.call({
            eventId: messageBody.data.checkpointEventId,
          });

          if (!checkpoint) {
            logger.error("Failed to restore checkpoint", {
              queueMessage: message.data,
              messageId: message.messageId,
            });

            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          await this.#nackAndDoMoreWork(message.messageId);
          return;
        }

        break;
      }
    }

    this.#doMoreWork();
    return;
  }

  #envIdFromQueue(queueName: string) {
    return queueName.split(":")[1];
  }

  #doMoreWork(intervalInMs = this._options.interval) {
    setTimeout(() => this.#doWork(), intervalInMs);
  }

  async #ackAndDoMoreWork(messageId: string, intervalInMs?: number) {
    await marqs?.acknowledgeMessage(messageId);
    this.#doMoreWork(intervalInMs);
  }

  async #nackAndDoMoreWork(messageId: string, intervalInMs?: number) {
    await marqs?.nackMessage(messageId);
    this.#doMoreWork(intervalInMs);
  }
}

class SharedQueueTasks {
  async getCompletionPayloadFromAttempt(id: string): Promise<TaskRunExecutionResult | undefined> {
    const attempt = await prisma.taskRunAttempt.findUnique({
      where: {
        id,
        status: {
          in: ["COMPLETED", "FAILED"],
        },
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

    if (!attempt) {
      logger.error("No completed attempt found", { id });
      return;
    }

    const ok = attempt.status === "COMPLETED";

    if (ok) {
      const success: TaskRunSuccessfulExecutionResult = {
        ok,
        id: attempt.friendlyId,
        output: attempt.output ?? undefined,
        outputType: attempt.outputType,
      };
      return success;
    } else {
      const failure: TaskRunFailedExecutionResult = {
        ok,
        id: attempt.friendlyId,
        error: attempt.error as TaskRunError,
      };
      return failure;
    }
  }

  async getExecutionPayloadFromAttempt(
    id: string,
    setToExecuting?: boolean,
    isRetrying?: boolean
  ): Promise<ProdTaskRunExecutionPayload | undefined> {
    const attempt = await prisma.taskRunAttempt.findUnique({
      where: {
        id,
      },
      include: {
        backgroundWorker: true,
        backgroundWorkerTask: true,
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
        taskRun: {
          include: {
            tags: true,
            batchItem: {
              include: {
                batchTaskRun: true,
              },
            },
          },
        },
        queue: true,
      },
    });

    if (!attempt) {
      logger.error("No attempt found", { id });
      return;
    }

    switch (attempt.status) {
      case "CANCELED":
      case "EXECUTING": {
        logger.error("Invalid attempt status for execution payload retrieval", {
          attemptId: id,
          status: attempt.status,
        });
        return;
      }
    }

    switch (attempt.taskRun.status) {
      case "CANCELED":
      case "EXECUTING":
      case "INTERRUPTED": {
        logger.error("Invalid run status for execution payload retrieval", {
          attemptId: id,
          runId: attempt.taskRunId,
          status: attempt.taskRun.status,
        });
        return;
      }
    }

    if (setToExecuting) {
      const FINAL_RUN_STATUSES: TaskRunStatus[] = [
        "CANCELED",
        "COMPLETED_SUCCESSFULLY",
        "COMPLETED_WITH_ERRORS",
        "INTERRUPTED",
        "SYSTEM_FAILURE",
      ];
      const FINAL_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["CANCELED", "COMPLETED", "FAILED"];

      if (
        FINAL_ATTEMPT_STATUSES.includes(attempt.status) ||
        FINAL_RUN_STATUSES.includes(attempt.taskRun.status)
      ) {
        logger.error("Status already in final state", {
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

    const { backgroundWorkerTask, taskRun, queue } = attempt;

    const execution: ProdTaskRunExecution = {
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
        isTest: taskRun.isTest,
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
      batch: taskRun.batchItem?.batchTaskRun
        ? { id: taskRun.batchItem.batchTaskRun.friendlyId }
        : undefined,
      worker: {
        id: attempt.backgroundWorkerId,
        contentHash: attempt.backgroundWorker.contentHash,
        version: attempt.backgroundWorker.version,
      },
    };

    const environmentRepository = new EnvironmentVariablesRepository();
    const variables = await environmentRepository.getEnvironmentVariables(
      attempt.runtimeEnvironment.projectId,
      attempt.runtimeEnvironmentId
    );

    const payload: ProdTaskRunExecutionPayload = {
      execution,
      traceContext: taskRun.traceContext as Record<string, unknown>,
      environment: variables.reduce((acc: Record<string, string>, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {}),
    };

    return payload;
  }

  async getLatestExecutionPayloadFromRun(
    id: string,
    setToExecuting?: boolean,
    isRetrying?: boolean
  ): Promise<ProdTaskRunExecutionPayload | undefined> {
    const run = await prisma.taskRun.findUnique({
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

    return this.getExecutionPayloadFromAttempt(latestAttempt.id, setToExecuting, isRetrying);
  }

  async taskHeartbeat(attemptFriendlyId: string, seconds: number = 60) {
    const taskRunAttempt = await prisma.taskRunAttempt.findUnique({
      where: { friendlyId: attemptFriendlyId },
    });

    if (!taskRunAttempt) {
      return;
    }

    await marqs?.heartbeatMessage(taskRunAttempt.taskRunId, seconds);
  }
}

export const sharedQueueTasks = singleton("sharedQueueTasks", () => new SharedQueueTasks());
