import { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { AuthenticatedEnvironment, authenticateApiKey } from "~/services/apiAuth.server";
import { singleton } from "../utils/singleton";
import { randomUUID } from "node:crypto";
import { Evt } from "evt";
import { logger } from "~/services/logger.server";
import { prisma } from "~/db.server";
import { z } from "zod";
import { BackgroundWorker, BackgroundWorkerTask, TaskRun } from "@trigger.dev/database";

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

const clientMessageSchema = z.discriminatedUnion("message", [
  z.object({
    message: z.literal("READY_FOR_TASKS"),
    backgroundWorkerId: z.string(),
  }),
  z.object({
    message: z.literal("WORKER_SHUTDOWN"),
    backgroundWorkerId: z.string(),
  }),
  z.object({
    message: z.literal("WORKER_STOPPED"),
    backgroundWorkerId: z.string(),
  }),
  z.object({
    message: z.literal("BACKGROUND_WORKER_MESSAGE"),
    backgroundWorkerId: z.string(),
    data: z.unknown(),
  }),
]);

// Step 1: We'll receive a response with the background worker's information, which we can use to find out which tasks it supports
// Step 2: We query for the task runs in the database
// Step 3: We send the task runs to the client
// Step 4: The client responds with which taskruns they are executing now
// Step 5: We update the TaskRuns with the background worker and background worker task
class WebsocketHandlers {
  public id: string;
  public onClose: Evt<CloseEvent> = new Evt();

  private backgroundWorkerHandlers: Map<string, BackgroundWorkerHandler> = new Map();

  constructor(public ws: WebSocket, public authenticatedEnv: AuthenticatedEnvironment) {
    this.id = randomUUID();

    ws.addEventListener("message", this.#handleMessage.bind(this));
    ws.addEventListener("close", this.#handleClose.bind(this));
    ws.addEventListener("error", this.#handleError.bind(this));
  }

  async start() {
    this.ws.send(JSON.stringify({ message: "SERVER_READY", id: this.id }));
  }

  async #handleMessage(ev: MessageEvent) {
    const data = JSON.parse(ev.data.toString());

    logger.debug("Websocket message received", { data });

    const message = clientMessageSchema.safeParse(data);

    if (!message.success) {
      logger.error("Invalid message received", { issues: message.error.issues });
      return;
    }

    switch (message.data.message) {
      case "READY_FOR_TASKS": {
        const handler = new BackgroundWorkerHandler(
          message.data.backgroundWorkerId,
          this.authenticatedEnv,
          this.ws.send.bind(this.ws)
        );

        this.backgroundWorkerHandlers.set(handler.id, handler);

        await handler.start();

        break;
      }
      case "WORKER_STOPPED": {
        const handler = this.backgroundWorkerHandlers.get(message.data.backgroundWorkerId);

        if (!handler) {
          logger.error("Failed to find background worker handler", {
            backgroundWorkerId: message.data.backgroundWorkerId,
          });
          return;
        }

        await handler.stop();

        break;
      }
      case "WORKER_SHUTDOWN": {
        const handler = this.backgroundWorkerHandlers.get(message.data.backgroundWorkerId);

        if (handler) {
          await handler.stop();
          this.backgroundWorkerHandlers.delete(handler.id);
        }

        break;
      }
      case "BACKGROUND_WORKER_MESSAGE": {
        const handler = this.backgroundWorkerHandlers.get(message.data.backgroundWorkerId);

        if (!handler) {
          logger.error("Failed to find background worker handler", {
            backgroundWorkerId: message.data.backgroundWorkerId,
          });
          return;
        }

        await handler.handleMessage(message.data.data);

        break;
      }
    }
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

const backgroundWorkerHandlerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TASK_RUN_COMPLETED"),
    taskRunCompletion: z.object({
      id: z.string(),
      output: z.string().optional(),
      outputType: z.string().optional(),
      error: z.string().optional(),
    }),
  }),
]);

class BackgroundWorkerHandler {
  private _backgroundWorker: BackgroundWorker | undefined;
  private _backgroundWorkerTasks: Array<BackgroundWorkerTask> | undefined;
  private _abortController: AbortController = new AbortController();

  constructor(
    public id: string,
    public env: AuthenticatedEnvironment,
    private send: WebSocket["send"]
  ) {}

  async start() {
    const backgroundWorker = await prisma.backgroundWorker.findUnique({
      where: { id: this.id, runtimeEnvironmentId: this.env.id },
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

  async handleMessage(data: unknown) {
    const message = backgroundWorkerHandlerSchema.safeParse(data);

    if (!message.success) {
      logger.error("Invalid message received", { issues: message.error.issues });
      return;
    }

    switch (message.data.type) {
      case "TASK_RUN_COMPLETED": {
        await this.#handleTaskRunCompleted(message.data.taskRunCompletion);

        break;
      }
    }
  }

  async stop() {
    this._abortController.abort();
  }

  async #handleTaskRunCompleted(taskRunCompletion: any) {
    logger.debug("Task run completed", { taskRunCompletion });

    await prisma.taskRun.update({
      where: { id: taskRunCompletion.id },
      data: {
        status: taskRunCompletion.error ? "FAILED" : "COMPLETED",
        output: taskRunCompletion.output,
        outputType: taskRunCompletion.outputType,
        error: taskRunCompletion.error,
        completedAt: new Date(),
      },
    });
  }

  // Every 1 second, we'll check for new tasks to run and send them to the client
  // if the abort controller is aborted, we'll stop the runloop
  async #startRunLoop() {
    while (!this._abortController.signal.aborted) {
      const taskRuns = await this.#reserveTaskRuns();

      if (taskRuns.length > 0) {
        logger.debug("Sending task runs to client", { taskRuns });

        if (this._abortController.signal.aborted) {
          // Return reserverd task runs to pending
          await this.#returnReservedTasksToPending(taskRuns);
          return;
        }

        this.send(
          JSON.stringify({
            message: "BACKGROUND_WORKER_MESSAGE",
            backgroundWorkerId: this.id,
            data: {
              type: "PENDING_TASK_RUNS",
              taskRuns: taskRuns,
            },
          })
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async #returnReservedTasksToPending(taskRuns: Array<TaskRun>) {
    await prisma.taskRun.updateMany({
      where: {
        id: {
          in: taskRuns.map((taskRun) => taskRun.id),
        },
      },
      data: {
        status: "PENDING",
        startedAt: null,
        backgroundWorkerId: null,
        backgroundWorkerTaskId: null,
      },
    });
  }

  async #reserveTaskRuns() {
    const taskRuns: Array<TaskRun> = [];

    if (!this._backgroundWorkerTasks) {
      return taskRuns;
    }

    for (const task of this._backgroundWorkerTasks) {
      const reservedTaskRuns = await this.#reserveTaskRunsForTask(task);

      taskRuns.push(...reservedTaskRuns);
    }

    return taskRuns;
  }

  async #reserveTaskRunsForTask(task: BackgroundWorkerTask) {
    return await prisma.$transaction(async (tx) => {
      const taskRuns = await tx.taskRun.findMany({
        where: {
          taskIdentifier: task.slug,
          status: "PENDING",
        },
      });

      await tx.taskRun.updateMany({
        where: {
          id: {
            in: taskRuns.map((taskRun) => taskRun.id),
          },
        },
        data: {
          status: "EXECUTING",
          startedAt: new Date(),
          backgroundWorkerId: this.id,
          backgroundWorkerTaskId: task.id,
        },
      });

      return taskRuns.map((taskRun) => ({ ...taskRun, status: "EXECUTING" as const }));
    });
  }
}
