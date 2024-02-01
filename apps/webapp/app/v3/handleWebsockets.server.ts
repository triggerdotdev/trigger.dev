import {
  BackgroundWorkerClientMessages,
  TaskRunExecutionResult,
  TaskRunExecution,
  ZodMessageHandler,
  ZodMessageSender,
  clientWebsocketMessages,
  serverWebsocketMessages,
  TaskRunExecutionPayload,
} from "@trigger.dev/core/v3";
import { BackgroundWorker, BackgroundWorkerTask } from "@trigger.dev/database";
import { Evt } from "evt";
import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { AuthenticatedEnvironment, authenticateApiKey } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "../utils/singleton";
import { generateFriendlyId } from "./friendlyIdentifiers";

export const wss = singleton("wss", initalizeWebSocketServer);

let handlers: Map<string, WebsocketHandlers>;

function initalizeWebSocketServer() {
  const server = new WebSocketServer({ noServer: true });

  server.on("connection", handleWebSocketConnection);

  handlers = new Map();

  return server;
}

async function handleWebSocketConnection(ws: WebSocket, req: IncomingMessage) {
  const authHeader = req.headers.authorization;

  if (!authHeader || typeof authHeader !== "string") {
    ws.close(1008, "Missing Authorization header");
    return;
  }

  const [authType, apiKey] = authHeader.split(" ");

  if (authType !== "Bearer" || !apiKey) {
    ws.close(1008, "Invalid Authorization header");
    return;
  }

  const authenticationResult = await authenticateApiKey(apiKey);

  if (!authenticationResult) {
    ws.close(1008, "Invalid API key");
    return;
  }

  const authenticatedEnv = authenticationResult.environment;

  const handler = new WebsocketHandlers(ws, authenticatedEnv);

  handlers.set(handler.id, handler);

  handler.onClose.attach((closeEvent) => {
    logger.debug("Websocket closed", { closeEvent });

    handlers.delete(handler.id);
  });

  await handler.start();
}

class WebsocketHandlers {
  public id: string;
  public onClose: Evt<CloseEvent> = new Evt();

  private backgroundWorkerHandlers: Map<string, BackgroundWorkerHandler> = new Map();
  private _sender: ZodMessageSender<typeof serverWebsocketMessages>;

  constructor(public ws: WebSocket, public authenticatedEnv: AuthenticatedEnvironment) {
    this.id = randomUUID();

    ws.addEventListener("message", this.#handleMessage.bind(this));
    ws.addEventListener("close", this.#handleClose.bind(this));
    ws.addEventListener("error", this.#handleError.bind(this));

    this._sender = new ZodMessageSender({
      schema: serverWebsocketMessages,
      sender: async (message) => {
        ws.send(JSON.stringify(message));
      },
    });
  }

  async start() {
    this._sender.send("SERVER_READY", { id: this.id });
  }

  async #handleMessage(ev: MessageEvent) {
    const data = JSON.parse(ev.data.toString());

    logger.debug("Websocket message received", { data });

    const handler = new ZodMessageHandler({
      schema: clientWebsocketMessages,
      messages: {
        READY_FOR_TASKS: async (payload) => {
          const handler = new BackgroundWorkerHandler(
            payload.backgroundWorkerId,
            this.authenticatedEnv,
            this._sender
          );

          this.backgroundWorkerHandlers.set(handler.id, handler);

          await handler.start();
        },
        WORKER_DEPRECATED: async (payload) => {
          const handler = this.backgroundWorkerHandlers.get(payload.backgroundWorkerId);

          if (!handler) {
            logger.error("Failed to find background worker handler", {
              backgroundWorkerId: payload.backgroundWorkerId,
            });
            return;
          }

          await handler.deprecate();
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          const handler = this.backgroundWorkerHandlers.get(payload.backgroundWorkerId);

          if (!handler) {
            logger.error("Failed to find background worker handler", {
              backgroundWorkerId: payload.backgroundWorkerId,
            });
            return;
          }

          await handler.handleMessage(payload.data);
        },
      },
    });

    await handler.handleMessage(data);
  }

  async #handleClose(ev: CloseEvent) {
    for (const handler of this.backgroundWorkerHandlers.values()) {
      await handler.stop();
    }

    this.backgroundWorkerHandlers.clear();

    this.onClose.post(ev);
  }

  async #handleError(ev: Event) {
    logger.error("Websocket error", { ev });
  }
}

class BackgroundWorkerHandler {
  private _backgroundWorker: BackgroundWorker | undefined;
  private _backgroundWorkerTasks: Array<BackgroundWorkerTask> | undefined;
  private _abortController: AbortController = new AbortController();
  private _deprecated: boolean = false;

  constructor(
    public id: string,
    public env: AuthenticatedEnvironment,
    private sender: ZodMessageSender<typeof serverWebsocketMessages>
  ) {}

  async start() {
    const backgroundWorker = await prisma.backgroundWorker.findUnique({
      where: { friendlyId: this.id, runtimeEnvironmentId: this.env.id },
      include: {
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      logger.error("Failed to find background worker", { id: this.id });
      return;
    }

    this._backgroundWorker = backgroundWorker;
    this._backgroundWorkerTasks = backgroundWorker.tasks;

    logger.debug("Background worker ready", { backgroundWorker });

    this.#startRunLoop().catch((err) => {
      logger.error("Background worker runloop error", { err });
    });
  }

  async handleMessage(message: BackgroundWorkerClientMessages) {
    switch (message.type) {
      case "TASK_RUN_COMPLETED": {
        await this.#handleTaskRunCompleted(message.completion);

        break;
      }
    }
  }

  async stop() {
    this._abortController.abort();
  }

  // This will cause the background worker to stop accepting new tasks
  // it will still look for tasks locked to it
  async deprecate() {
    this._deprecated = true;
  }

  async #handleTaskRunCompleted(completion: TaskRunExecutionResult) {
    logger.debug("Task run completed", { taskRunCompletion: completion });

    if (completion.ok) {
      await prisma.taskRunAttempt.update({
        where: { friendlyId: completion.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: completion.output,
          outputType: completion.outputType,
        },
      });
    } else {
      await prisma.taskRunAttempt.update({
        where: { friendlyId: completion.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: completion.error,
        },
      });
    }
  }

  // Every 1 second, we'll check for new tasks to run and send them to the client
  // if the abort controller is aborted, we'll stop the runloop
  async #startRunLoop() {
    while (!this._abortController.signal.aborted) {
      const { payloads, returnReservedTasksToPending } = await this.#reserveTaskRuns();

      if (payloads.length > 0) {
        logger.debug("Sending task run payloads to client", { payloads });

        if (this._abortController.signal.aborted) {
          // Return reserverd task runs to pending
          await returnReservedTasksToPending();

          return;
        }

        this.sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId: this.id,
          data: {
            type: "EXECUTE_RUNS",
            payloads,
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async #reserveTaskRuns(): Promise<{
    payloads: Array<TaskRunExecutionPayload>;
    returnReservedTasksToPending: () => Promise<void>;
  }> {
    const allPayloads: Array<TaskRunExecutionPayload> = [];
    const allReturnReservedTasksToPending: Array<() => Promise<void>> = [];

    if (!this._backgroundWorkerTasks) {
      return { payloads: allPayloads, returnReservedTasksToPending: async () => {} };
    }

    for (const task of this._backgroundWorkerTasks) {
      const { payloads, returnReservedTasksToPending } = await this.#reserveTaskRunsForTask(task);

      allPayloads.push(...payloads);
      allReturnReservedTasksToPending.push(returnReservedTasksToPending);
    }

    const returnReservedTasksToPending = async () => {
      await Promise.all(allReturnReservedTasksToPending);
    };

    return { payloads: allPayloads, returnReservedTasksToPending };
  }

  async #findTaskRunsForTask(task: BackgroundWorkerTask, tx: PrismaClientOrTransaction) {
    if (this._deprecated) {
      // Only find task runs that are locked to this worker
      return tx.taskRun.findMany({
        where: {
          taskIdentifier: task.slug,
          lockedAt: { equals: null },
          runtimeEnvironmentId: task.runtimeEnvironmentId,
          lockedToVersionId: this._backgroundWorker!.id,
        },
        include: {
          attempts: {
            take: 1,
            orderBy: { number: "desc" },
          },
          tags: true,
        },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
    }

    return tx.taskRun.findMany({
      where: {
        OR: [{ lockedToVersionId: null }, { lockedToVersionId: this._backgroundWorker!.id }],
        AND: {
          taskIdentifier: task.slug,
          lockedAt: { equals: null },
          runtimeEnvironmentId: task.runtimeEnvironmentId,
        },
      },
      include: {
        attempts: {
          take: 1,
          orderBy: { number: "desc" },
        },
        tags: true,
      },
      orderBy: { createdAt: "asc" },
      take: 10,
    });
  }

  async #reserveTaskRunsForTask(task: BackgroundWorkerTask): Promise<{
    payloads: Array<TaskRunExecutionPayload>;
    returnReservedTasksToPending: () => Promise<void>;
  }> {
    return await prisma.$transaction(async (tx) => {
      const taskRuns = await this.#findTaskRunsForTask(task, tx);

      await tx.taskRun.updateMany({
        where: {
          id: {
            in: taskRuns.map((taskRun) => taskRun.id),
          },
        },
        data: {
          lockedAt: new Date(),
          lockedById: task.id,
        },
      });

      const attempts = taskRuns.map((taskRun) => {
        const attemptFriendlyId = generateFriendlyId("attempt");

        const create = {
          number: taskRun.attempts[0] ? taskRun.attempts[0].number + 1 : 1,
          friendlyId: attemptFriendlyId,
          taskRunId: taskRun.id,
          startedAt: new Date(),
          backgroundWorkerId: task.workerId,
          backgroundWorkerTaskId: task.id,
          status: "EXECUTING" as const,
        };

        const execution = {
          task: {
            id: task.slug,
            filePath: task.filePath,
            exportName: task.exportName,
          },
          attempt: {
            id: attemptFriendlyId,
            number: taskRun.attempts[0] ? taskRun.attempts[0].number + 1 : 1,
            startedAt: new Date(),
            backgroundWorkerId: this.id,
            backgroundWorkerTaskId: task.id,
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

        return { create, execution, traceContext: taskRun.traceContext as Record<string, unknown> };
      });

      await tx.taskRunAttempt.createMany({
        data: attempts.map(({ create }) => create),
      });

      const returnReservedTasksToPending = async () => {
        await prisma.taskRun.updateMany({
          where: {
            id: {
              in: attempts.map(({ create }) => create.taskRunId),
            },
          },
          data: {
            lockedAt: null,
            lockedById: null,
          },
        });

        await prisma.taskRunAttempt.updateMany({
          where: {
            friendlyId: {
              in: attempts.map(({ create }) => create.friendlyId),
            },
          },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            error: "Worker stopped",
          },
        });
      };

      return {
        payloads: attempts.map(({ execution, traceContext }) => ({ execution, traceContext })),
        returnReservedTasksToPending,
      };
    });
  }
}
