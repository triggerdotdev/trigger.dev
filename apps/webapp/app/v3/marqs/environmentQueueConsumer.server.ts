import {
  TaskRunExecutionResult,
  ZodMessageSender,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { BackgroundWorker, BackgroundWorkerTask } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";

const MessageBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE"),
    taskIdentifier: z.string(),
  }),
]);

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export class EnvironmentQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _processingMessages: Set<string> = new Set();

  constructor(
    public env: AuthenticatedEnvironment,
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>
  ) {}

  public async registerBackgroundWorker(id: string) {
    const backgroundWorker = await prisma.backgroundWorker.findUnique({
      where: { friendlyId: id, runtimeEnvironmentId: this.env.id },
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

  public async taskRunCompleted(workerId: string, completion: TaskRunExecutionResult) {
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
        })
      : await prisma.taskRunAttempt.update({
          where: { friendlyId: completion.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            error: completion.error,
          },
        });

    this._processingMessages.delete(taskRunAttempt.taskRunId);
    await marqs?.acknowledgeMessage(taskRunAttempt.taskRunId);
  }

  public async taskHeartbeat(workerId: string, id: string, seconds: number = 60) {
    const taskRunAttempt = await prisma.taskRunAttempt.findUnique({
      where: { friendlyId: id },
    });

    if (!taskRunAttempt) {
      return;
    }

    await marqs?.heartbeatMessage(taskRunAttempt.taskRunId, seconds);
  }

  public async stop() {
    this._enabled = false;
  }

  #enable() {
    if (this._enabled) {
      return;
    }

    this._enabled = true;

    this.#doWork().finally(() => {});
  }

  async #doWork() {
    if (!this._enabled) {
      return;
    }

    // Attempt to dequeue a message from the environment's queue
    // If no message is available, reschedule the worker to run again in 1 second
    // If a message is available, find the BackgroundWorkerTask that matches the message's taskIdentifier
    // If no matching task is found, nack the message and reschedule the worker to run again in 1 second
    // If the matching task is found, create the task attempt and lock the task run, then send the task run to the client
    // Store the message as a processing message
    // If the websocket connection disconnects before the task run is completed, nack the message
    // When the task run completes, ack the message
    // Using a heartbeat mechanism, if the client keeps responding with a heartbeat, we'll keep the message processing and increase the visibility timeout.

    const message = await marqs?.dequeueMessageInEnv(this.env);

    if (!message) {
      setTimeout(() => this.#doWork(), 1000);
      return;
    }

    const messageBody = MessageBody.safeParse(message.data);

    if (!messageBody.success) {
      // TODO: do some kind of DLQ thing?
      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    logger.debug("Dequeued message", {
      queueMessage: message,
    });

    const existingTaskRun = await prisma.taskRun.findUnique({
      where: {
        id: message.messageId,
      },
    });

    if (!existingTaskRun) {
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundWorker = existingTaskRun.lockedToVersionId
      ? this._backgroundWorkers.get(existingTaskRun.lockedToVersionId)
      : this.#getLatestBackgroundWorker();

    if (!backgroundWorker) {
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundTask = backgroundWorker.tasks.find(
      (task) => task.slug === existingTaskRun.taskIdentifier
    );

    if (!backgroundTask) {
      // TODO: some kind of DLQ thing?
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
      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const queue = await prisma.taskQueue.findUnique({
      where: {
        runtimeEnvironmentId_name: { runtimeEnvironmentId: this.env.id, name: lockedTaskRun.queue },
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
        status: "EXECUTING" as const,
        queueId: queue.id,
      },
    });

    const execution = {
      task: {
        id: backgroundTask.slug,
        filePath: backgroundTask.filePath,
        exportName: backgroundTask.exportName,
      },
      attempt: {
        id: taskRunAttempt.friendlyId,
        number: taskRunAttempt.number,
        startedAt: taskRunAttempt.startedAt ?? taskRunAttempt.createdAt,
        backgroundWorkerId: backgroundWorker.id,
        backgroundWorkerTaskId: backgroundTask.id,
        status: "EXECUTING" as const,
      },
      run: {
        id: lockedTaskRun.friendlyId,
        payload: lockedTaskRun.payload,
        payloadType: lockedTaskRun.payloadType,
        context: lockedTaskRun.context,
        createdAt: lockedTaskRun.createdAt,
        tags: lockedTaskRun.tags.map((tag) => tag.name),
      },
      queue: {
        id: queue.friendlyId,
        name: queue.name,
      },
      environment: {
        id: this.env.id,
        slug: this.env.slug,
        type: this.env.type,
      },
      organization: {
        id: this.env.organization.id,
        slug: this.env.organization.slug,
        name: this.env.organization.title,
      },
      project: {
        id: this.env.project.id,
        ref: this.env.project.externalRef,
        slug: this.env.project.slug,
        name: this.env.project.name,
      },
    };

    const payload = {
      execution,
      traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
    };

    this._sender.send("BACKGROUND_WORKER_MESSAGE", {
      backgroundWorkerId: backgroundWorker.friendlyId,
      data: {
        type: "EXECUTE_RUNS",
        payloads: [payload],
      },
    });

    this._processingMessages.add(message.messageId);

    setTimeout(() => this.#doWork(), 100);
  }

  // Get the latest background worker based on the version.
  // Versions are in the format of 20240101.1 and 20240101.2
  #getLatestBackgroundWorker() {
    const workers = Array.from(this._backgroundWorkers.values());

    if (workers.length === 0) {
      return;
    }

    return workers.reduce((acc, curr) => {
      if (acc.version > curr.version) {
        return acc;
      }

      return curr;
    });
  }
}
