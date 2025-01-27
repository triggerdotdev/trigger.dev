import {
  BuildManifest,
  clientWebsocketMessages,
  CreateBackgroundWorkerRequestBody,
  SemanticInternalAttributes,
  serverWebsocketMessages,
  TaskManifest,
  TaskRunExecutionLazyAttemptPayload,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import {
  MessagePayloadFromSchema,
  ZodMessageHandler,
  ZodMessageSender,
} from "@trigger.dev/core/v3/zodMessageHandler";
import { ClientRequestArgs } from "node:http";
import { WebSocket } from "partysocket";
import { ClientOptions, WebSocket as wsWebSocket } from "ws";
import { CliApiClient } from "../apiClient.js";
import { DevCommandOptions } from "../commands/dev.js";
import { chalkError, chalkTask } from "../utilities/cliOutput.js";
import { resolveDotEnvVars } from "../utilities/dotEnv.js";
import { eventBus } from "../utilities/eventBus.js";
import { Logger, logger } from "../utilities/logger.js";
import { resolveSourceFiles } from "../utilities/sourceFiles.js";
import { BackgroundWorker, BackgroundWorkerCoordinator } from "./backgroundWorker.js";
import { sanitizeEnvVars } from "../utilities/sanitizeEnvVars.js";
import { VERSION } from "../version.js";
import { WorkerRuntime } from "./workerRuntime.js";

export type WorkerRuntimeOptions = {
  name: string | undefined;
  config: ResolvedConfig;
  args: DevCommandOptions;
  client: CliApiClient;
  dashboardUrl: string;
};

export async function startWorkerRuntime(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const runtime = new DevSupervisor(options);
  await runtime.init();
  return runtime;
}

class DevSupervisor implements WorkerRuntime {
  private config: DevConfigResponseBody;

  constructor(public readonly options: WorkerRuntimeOptions) {}

  async init(): Promise<void> {
    logger.debug("initialized worker runtime", { options: this.options });

    //todo get the settings for dev
    const settings = await this.options.client.devConfig();
    if (!settings.success) {
      throw new Error(`Failed to connect to retrieve dev settings: ${settings.error}`);
    }

    logger.debug("Got dev settings", { settings: settings.data });

    this.config = settings.data;

    //todo start an SSE connection to the presence endpoint
    //that endpoint will periodically update a last seen value in Redis. Look at how to do presence Redis.
    //the dashboard will subscribe to Redis for this.

    //todo start dequeuing. Each time we dequeue:
    // Before hitting the API we will see if there are enough resources to dequeue.
    // 1. If there are messages we will wait a brief period of time and dequeue again
    // 2. If there are no messages we will wait for a longer period of time and dequeue again
  }

  async shutdown(): Promise<void> {}

  async initializeWorker(manifest: BuildManifest, stop: () => void): Promise<void> {}
}

//todo ignore the dev queue pulling route in the rate limiter
//todo the queue pull endpoint should just update the presence
//todo ignore the dev presence
//we will need to hit the presence endpoint if we aren't going to dequeue because of CPU/RAM

//CLI hits an SSE endpoint, it will periodically update a last seen value in Redis. Look at how to do presence Redis.
//Frontend will subscribe to Redis for this.
