import {
  BuildManifest,
  clientWebsocketMessages,
  SemanticInternalAttributes,
  serverWebsocketMessages,
  TaskRunExecutionLazyAttemptPayload,
} from "@trigger.dev/core/v3";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { ClientRequestArgs } from "node:http";
import { WebSocket } from "partysocket";
import { ClientOptions, WebSocket as wsWebSocket } from "ws";
import { CliApiClient } from "../apiClient.js";
import { DevCommandOptions } from "../commands/dev.js";
import { chalkError } from "../utilities/cliOutput.js";
import { logger } from "../utilities/logger.js";
import { BackgroundWorker, BackgroundWorkerCoordinator } from "./backgroundWorker.js";
import {
  MessagePayloadFromSchema,
  ZodMessageHandler,
  ZodMessageSender,
} from "@trigger.dev/core/v3/zodMessageHandler";
import { resolveDotEnvVars } from "../utilities/dotEnv.js";

export interface WorkerRuntime {
  shutdown(): Promise<void>;
  initializeWorker(manifest: BuildManifest): Promise<void>;
}

export type WorkerRuntimeOptions = {
  name: string | undefined;
  config: ResolvedConfig;
  args: DevCommandOptions;
  client: CliApiClient;
  dashboardUrl: string;
};

export async function startWorkerRuntime(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const runtime = new DevWorkerRuntime(options);

  await runtime.init();

  return runtime;
}

class DevWorkerRuntime implements WorkerRuntime {
  private websocket: WebSocket;
  private backgroundWorkerCoordinator: BackgroundWorkerCoordinator;
  private sender: ZodMessageSender<typeof clientWebsocketMessages>;
  private websocketMessageHandler: ZodMessageHandler<typeof serverWebsocketMessages>;

  constructor(public readonly options: WorkerRuntimeOptions) {
    const websocketUrl = new URL(this.options.client.apiURL);
    websocketUrl.protocol = websocketUrl.protocol.replace("http", "ws");
    websocketUrl.pathname = `/ws`;

    this.sender = new ZodMessageSender({
      schema: clientWebsocketMessages,
      sender: async (message) => {
        this.websocket.send(JSON.stringify(message));
      },
    });

    this.backgroundWorkerCoordinator = new BackgroundWorkerCoordinator(
      `${options.dashboardUrl}/projects/v3/${options.config.project}`
    );

    this.backgroundWorkerCoordinator.onWorkerTaskRunHeartbeat.attach(
      async ({ worker, backgroundWorkerId, id }) => {
        await this.sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_HEARTBEAT",
            id,
          },
        });
      }
    );

    this.backgroundWorkerCoordinator.onTaskCompleted.attach(
      async ({ backgroundWorkerId, completion, execution }) => {
        await this.sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_COMPLETED",
            completion,
            execution,
          },
        });
      }
    );

    this.backgroundWorkerCoordinator.onTaskFailedToRun.attach(
      async ({ backgroundWorkerId, completion }) => {
        await this.sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_FAILED_TO_RUN",
            completion,
          },
        });
      }
    );

    this.backgroundWorkerCoordinator.onWorkerRegistered.attach(async ({ id, worker, record }) => {
      await this.sender.send("READY_FOR_TASKS", {
        backgroundWorkerId: id,
      });
    });

    this.websocketMessageHandler = new ZodMessageHandler({
      schema: serverWebsocketMessages,
      messages: {
        SERVER_READY: async (payload) => {
          await this.#serverReady(payload);
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          await this.#backgroundWorkerMessage(payload);
        },
      },
    });

    this.websocket = new WebSocket(websocketUrl.href, [], {
      WebSocket: WebsocketFactory(this.options.client.accessToken!),
      connectionTimeout: 10000,
      maxRetries: 10,
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.4, // This leads to the following retry times: 1, 1.4, 1.96, 2.74, 3.84, 5.38, 7.53, 10.54, 14.76, 20.66
      maxEnqueuedMessages: 250,
    });

    this.websocket.addEventListener("open", async (event) => {
      logger.debug("WebSocket opened", { event });
    });

    this.websocket.addEventListener("close", (event) => {
      logger.debug("WebSocket closed", { event });
    });

    this.websocket.addEventListener("error", (event) => {
      logger.log(`${chalkError("WebSocketError:")} ${event.error.message}`);
    });

    this.websocket.addEventListener("message", this.#handleWebsocketMessage.bind(this));
  }

  async init(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.websocket.close();
  }

  async initializeWorker(manifest: BuildManifest, options?: { cwd?: string }): Promise<void> {
    const env = await this.#getEnvVars();

    const backgroundWorker = new BackgroundWorker(manifest, {
      env,
      cwd: this.options.config.workingDir,
    });

    await backgroundWorker.initialize();
  }

  async #getEnvVars(): Promise<Record<string, string>> {
    const environmentVariablesResponse = await this.options.client.getEnvironmentVariables(
      this.options.config.project
    );

    const processEnv = gatherProcessEnv();
    const dotEnvVars = resolveDotEnvVars();

    return {
      ...processEnv,
      ...(environmentVariablesResponse.success ? environmentVariablesResponse.data.variables : {}),
      ...dotEnvVars,
      TRIGGER_API_URL: this.options.client.apiURL,
      TRIGGER_SECRET_KEY: this.options.client.accessToken!,
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
      OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
        [SemanticInternalAttributes.PROJECT_DIR]: this.options.config.workingDir,
      }),
    };
  }

  async #handleWebsocketMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder("utf-8").decode(event.data)
      );

      await this.websocketMessageHandler.handleMessage(data);
    } catch (error) {
      if (error instanceof Error) {
        logger.error("Error while handling websocket message", { error: error.message });
      } else {
        logger.error(
          "Unkown error while handling websocket message, use `-l debug` for additional output"
        );
        logger.debug("Error while handling websocket message", { error });
      }
    }
  }

  async #serverReady(
    payload: MessagePayloadFromSchema<"SERVER_READY", typeof serverWebsocketMessages>
  ) {
    for (const worker of this.backgroundWorkerCoordinator.currentWorkers) {
      await this.sender.send("READY_FOR_TASKS", {
        backgroundWorkerId: worker.id,
        inProgressRuns: worker.worker.inProgressRuns,
      });
    }
  }

  async #backgroundWorkerMessage(
    payload: MessagePayloadFromSchema<"BACKGROUND_WORKER_MESSAGE", typeof serverWebsocketMessages>
  ) {
    const message = payload.data;

    logger.debug(
      `Received message from worker ${payload.backgroundWorkerId}`,
      JSON.stringify({ workerMessage: message })
    );

    switch (message.type) {
      case "CANCEL_ATTEMPT": {
        // Need to cancel the attempt somehow here
        this.backgroundWorkerCoordinator.cancelRun(payload.backgroundWorkerId, message.taskRunId);
        break;
      }
      case "EXECUTE_RUN_LAZY_ATTEMPT": {
        await this.#executeTaskRunLazyAttempt(payload.backgroundWorkerId, message.payload);
      }
    }
  }

  async #executeTaskRunLazyAttempt(id: string, payload: TaskRunExecutionLazyAttemptPayload) {
    const attemptResponse = await this.options.client.createTaskRunAttempt(payload.runId);

    if (!attemptResponse.success) {
      throw new Error(`Failed to create task run attempt: ${attemptResponse.error}`);
    }

    const execution = attemptResponse.data;

    const completion = await this.backgroundWorkerCoordinator.executeTaskRun(
      id,
      { execution, traceContext: payload.traceContext, environment: payload.environment },
      payload.messageId
    );

    return { execution, completion };
  }
}

function WebsocketFactory(apiKey: string) {
  return class extends wsWebSocket {
    constructor(address: string | URL, options?: ClientOptions | ClientRequestArgs) {
      super(address, { ...(options ?? {}), headers: { Authorization: `Bearer ${apiKey}` } });
    }
  };
}

function gatherProcessEnv() {
  const env = {
    ...process.env,
    NODE_ENV: "development",
  };

  // Filter out undefined values
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined));
}
