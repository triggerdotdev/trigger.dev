import { Context, ROOT_CONTEXT, Span, SpanKind, context, trace } from "@opentelemetry/api";
import {
  Machine,
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  TaskRunError,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import {
  BackgroundWorker,
  BackgroundWorkerTask,
  TaskRunAttemptStatus,
  TaskRunStatus,
} from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { marqs, sanitizeQueueName } from "~/v3/marqs/index.server";
import { EnvironmentVariablesRepository } from "../environmentVariables/environmentVariablesRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { socketIo } from "../handleSocketIo.server";
import {
  findCurrentWorkerDeployment,
  getWorkerDeploymentFromWorker,
  getWorkerDeploymentFromWorkerTask,
} from "../models/workerDeployment.server";
import { RestoreCheckpointService } from "../services/restoreCheckpoint.server";
import { SEMINTATTRS_FORCE_RECORDING, tracer } from "../tracer.server";
import { CrashTaskRunService } from "../services/crashTaskRun.server";

const WithTraceContext = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

export const SharedQueueMessageBody = z.discriminatedUnion("type", [
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
  WithTraceContext.extend({
    type: z.literal("FAIL"),
    reason: z.string(),
  }),
]);

export type SharedQueueMessageBody = z.infer<typeof SharedQueueMessageBody>;

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type SharedQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
  nextTickInterval?: number;
  interval?: number;
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

  constructor(
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>,
    options: SharedQueueConsumerOptions = {}
  ) {
    this._options = {
      maximumItemsPerTrace: options.maximumItemsPerTrace ?? 1_000, // 1k items per trace
      traceTimeoutSeconds: options.traceTimeoutSeconds ?? 60, // 60 seconds
      nextTickInterval: options.nextTickInterval ?? 1000, // 1 second
      interval: options.interval ?? 100, // 100ms
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
      this.#doMoreWork(this._options.nextTickInterval);
      return;
    }

    logger.log("dequeueMessageInSharedQueue()", { queueMessage: message });

    const messageBody = SharedQueueMessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
      });

      await this.#ackAndDoMoreWork(message.messageId);
      return;
    }

    // TODO: For every ACK, decide what should be done with the existing run and attempts. Make sure to check the current statuses first.

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

          // INFO: There used to be a race condition where tasks could be triggered, but execute messages could be dequeued before the run finished being created in the DB
          //       This should not be happening anymore. In case it does, consider reqeueuing here with a brief delay while limiting total retries.

          await this.#ackAndDoMoreWork(message.messageId);
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

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        // Check if the task run is locked to a specific worker, if not, use the current worker deployment
        const deployment = existingTaskRun.lockedById
          ? await getWorkerDeploymentFromWorkerTask(existingTaskRun.lockedById)
          : existingTaskRun.lockedToVersionId
          ? await getWorkerDeploymentFromWorker(existingTaskRun.lockedToVersionId)
          : await findCurrentWorkerDeployment(existingTaskRun.runtimeEnvironmentId);

        if (!deployment || !deployment.worker) {
          logger.error("No matching deployment found for task run", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        if (!deployment.imageReference) {
          logger.error("Deployment is missing an image reference", {
            queueMessage: message.data,
            messageId: message.messageId,
            deployment: deployment.id,
          });

          await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const backgroundTask = deployment.worker.tasks.find(
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
          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const lockedTaskRun = await prisma.taskRun.update({
          where: {
            id: message.messageId,
          },
          data: {
            lockedAt: new Date(),
            lockedById: backgroundTask.id,
            lockedToVersionId: deployment.worker.id,
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

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
              name: sanitizeQueueName(lockedTaskRun.queue),
            },
          },
        });

        if (!queue) {
          logger.debug("SharedQueueConsumer queue not found, so nacking message", {
            queueMessage: message,
            taskRunQueue: lockedTaskRun.queue,
            runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
          });

          await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval);
          return;
        }

        if (!this._enabled) {
          logger.debug("SharedQueueConsumer not enabled, so nacking message", {
            queueMessage: message,
          });

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
            runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
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
                envId: lockedTaskRun.runtimeEnvironment.id,
                envType: lockedTaskRun.runtimeEnvironment.type,
                orgId: lockedTaskRun.runtimeEnvironment.organizationId,
                projectId: lockedTaskRun.runtimeEnvironment.projectId,
                runId: taskRunAttempt.taskRunId,
              },
            });
          }
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

          logger.error("SharedQueueConsumer errored, so nacking message", {
            queueMessage: message,
            error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
          });

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
              runtimeEnvironmentId: resumableAttempt.runtimeEnvironmentId,
              name: sanitizeQueueName(resumableRun.queue),
            },
          },
        });

        if (!queue) {
          logger.debug("SharedQueueConsumer queue not found, so nacking message", {
            queueName: sanitizeQueueName(resumableRun.queue),
            attempt: resumableAttempt,
          });

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
      // Fail for whatever reason, usually runs that have been resumed but stopped heartbeating
      case "FAIL": {
        const existingTaskRun = await prisma.taskRun.findUnique({
          where: {
            id: message.messageId,
          },
        });

        if (!existingTaskRun) {
          logger.error("No existing task run to fail", {
            queueMessage: messageBody,
            messageId: message.messageId,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        // TODO: Consider failing the attempt and retrying instead. This may not be a good idea, as dequeued FAIL messages tend to point towards critical, persistent errors.
        const service = new CrashTaskRunService();
        await service.call(existingTaskRun.id, {
          crashAttempts: true,
          reason: messageBody.data.reason,
        });

        await this.#ackAndDoMoreWork(message.messageId);
        return;
      }
    }

    this.#doMoreWork();
    return;
  }

  #doMoreWork(intervalInMs = this._options.interval) {
    setTimeout(() => this.#doWork(), intervalInMs);
  }

  async #ackAndDoMoreWork(messageId: string, intervalInMs?: number) {
    await marqs?.acknowledgeMessage(messageId);
    this.#doMoreWork(intervalInMs);
  }

  async #nackAndDoMoreWork(messageId: string, queueIntervalInMs?: number, nackRetryInMs?: number) {
    const retryAt = nackRetryInMs ? Date.now() + nackRetryInMs : undefined;
    await marqs?.nackMessage(messageId, retryAt);
    this.#doMoreWork(queueIntervalInMs);
  }

  async #markRunAsWaitingForDeploy(runId: string) {
    logger.debug("Marking run as waiting for deploy", { runId });

    return await prisma.taskRun.update({
      where: {
        id: runId,
      },
      data: {
        status: "WAITING_FOR_DEPLOY",
      },
    });
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
        id: attempt.taskRun.friendlyId,
        output: attempt.output ?? undefined,
        outputType: attempt.outputType,
      };
      return success;
    } else {
      const failure: TaskRunFailedExecutionResult = {
        ok,
        id: attempt.taskRun.friendlyId,
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
            batchItems: {
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
        idempotencyKey: taskRun.idempotencyKey ?? undefined,
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
      batch:
        taskRun.batchItems[0] && taskRun.batchItems[0].batchTaskRun
          ? { id: taskRun.batchItems[0].batchTaskRun.friendlyId }
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
