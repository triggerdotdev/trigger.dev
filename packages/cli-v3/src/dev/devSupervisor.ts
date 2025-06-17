import { setTimeout as awaitTimeout } from "node:timers/promises";
import {
  BuildManifest,
  CreateBackgroundWorkerRequestBody,
  DevConfigResponseBody,
  SemanticInternalAttributes,
  TaskManifest,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { CliApiClient } from "../apiClient.js";
import { DevCommandOptions } from "../commands/dev.js";
import { eventBus } from "../utilities/eventBus.js";
import { logger } from "../utilities/logger.js";
import { resolveSourceFiles } from "../utilities/sourceFiles.js";
import { BackgroundWorker } from "./backgroundWorker.js";
import { WorkerRuntime } from "./workerRuntime.js";
import { chalkTask, cliLink, prettyError } from "../utilities/cliOutput.js";
import { DevRunController } from "../entryPoints/dev-run-controller.js";
import { io, Socket } from "socket.io-client";
import {
  WorkerClientToServerEvents,
  WorkerServerToClientEvents,
} from "@trigger.dev/core/v3/workers";
import pLimit from "p-limit";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import type { Metafile } from "esbuild";
import { TaskRunProcessPool } from "./taskRunProcessPool.js";

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

/**
 * The DevSupervisor is used when you run the `trigger.dev dev` command (with engine 2.0+)
 * It's responsible for:
 *   - Creating/registering BackgroundWorkers
 *   - Pulling runs from the queue
 *   - Delegating executing the runs to DevRunController
 *   - Receiving snapshot update pings (via socket)
 */
class DevSupervisor implements WorkerRuntime {
  private config?: DevConfigResponseBody;
  private disconnectPresence: (() => void) | undefined;
  private lastManifest?: BuildManifest;
  private latestWorkerId?: string;

  /** Receive notifications when runs change state */
  private socket?: Socket<WorkerServerToClientEvents, WorkerClientToServerEvents>;
  private socketIsReconnecting = false;

  /** Workers are versions of the code */
  private workers: Map<string, BackgroundWorker> = new Map();

  /** Map of run friendly id to run controller. They process runs from start to finish.  */
  private runControllers: Map<string, DevRunController> = new Map();

  private socketConnections = new Set<string>();

  private runLimiter?: ReturnType<typeof pLimit>;
  private taskRunProcessPool?: TaskRunProcessPool;

  constructor(public readonly options: WorkerRuntimeOptions) {}

  async init(): Promise<void> {
    logger.debug("[DevSupervisor] initialized worker runtime", { options: this.options });

    //get the settings for dev
    const settings = await this.options.client.dev.config();
    if (!settings.success) {
      throw new Error(
        `Failed to connect to ${this.options.client.apiURL}. Couldn't retrieve settings: ${settings.error}`
      );
    }

    logger.debug("[DevSupervisor] Got dev settings", { settings: settings.data });
    this.config = settings.data;

    this.options.client.dev.setEngineURL(this.config.engineUrl);

    const maxConcurrentRuns = Math.min(
      this.config.maxConcurrentRuns,
      this.options.args.maxConcurrentRuns ?? this.config.maxConcurrentRuns
    );

    logger.debug("[DevSupervisor] Using maxConcurrentRuns", { maxConcurrentRuns });

    this.runLimiter = pLimit(maxConcurrentRuns);

    // Initialize the task run process pool
    const env = await this.#getEnvVars();

    const enableProcessReuse =
      typeof this.options.config.experimental_processKeepAlive === "boolean"
        ? this.options.config.experimental_processKeepAlive
        : false;

    if (enableProcessReuse) {
      logger.debug("[DevSupervisor] Enabling process reuse", {
        enableProcessReuse,
      });
    }

    this.taskRunProcessPool = new TaskRunProcessPool({
      env,
      cwd: this.options.config.workingDir,
      enableProcessReuse:
        typeof this.options.config.experimental_processKeepAlive === "boolean"
          ? this.options.config.experimental_processKeepAlive
          : false,
      maxPoolSize: 3,
      maxExecutionsPerProcess: 50,
    });

    this.socket = this.#createSocket();

    //start an SSE connection for presence
    this.disconnectPresence = await this.#startPresenceConnection();

    //start dequeuing
    await this.#dequeueRuns();
  }

  async shutdown(): Promise<void> {
    this.disconnectPresence?.();
    try {
      this.socket?.close();
    } catch (error) {
      logger.debug("[DevSupervisor] shutdown, socket failed to close", { error });
    }

    // Shutdown the task run process pool
    if (this.taskRunProcessPool) {
      await this.taskRunProcessPool.shutdown();
    }
  }

  async initializeWorker(
    manifest: BuildManifest,
    metafile: Metafile,
    stop: () => void
  ): Promise<void> {
    if (this.lastManifest && this.lastManifest.contentHash === manifest.contentHash) {
      logger.debug("worker skipped", { lastManifestContentHash: this.lastManifest?.contentHash });
      eventBus.emit("workerSkipped");
      stop();
      return;
    }

    const env = await this.#getEnvVars();

    const backgroundWorker = new BackgroundWorker(manifest, metafile, {
      env,
      cwd: this.options.config.workingDir,
      stop,
    });

    logger.debug("initializing background worker", { manifest });

    await backgroundWorker.initialize();

    if (!backgroundWorker.manifest) {
      stop();
      throw new Error("Could not initialize worker");
    }

    const validationIssue = validateWorkerManifest(backgroundWorker.manifest);

    if (validationIssue) {
      prettyError(
        generationValidationIssueHeader(validationIssue),
        generateValidationIssueMessage(validationIssue, backgroundWorker.manifest!, manifest),
        generateValidationIssueFooter(validationIssue)
      );
      stop();
      return;
    }

    const sourceFiles = resolveSourceFiles(manifest.sources, backgroundWorker.manifest.tasks);

    const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
      localOnly: true,
      metadata: {
        packageVersion: manifest.packageVersion,
        cliPackageVersion: manifest.cliPackageVersion,
        tasks: backgroundWorker.manifest.tasks,
        queues: backgroundWorker.manifest.queues,
        contentHash: manifest.contentHash,
        sourceFiles,
      },
      engine: "V2",
      supportsLazyAttempts: true,
    };

    const backgroundWorkerRecord = await this.options.client.createBackgroundWorker(
      this.options.config.project,
      backgroundWorkerBody
    );

    if (!backgroundWorkerRecord.success) {
      stop();
      throw new Error(backgroundWorkerRecord.error);
    }

    backgroundWorker.serverWorker = backgroundWorkerRecord.data;
    this.#registerWorker(backgroundWorker);
    this.lastManifest = manifest;
    this.latestWorkerId = backgroundWorker.serverWorker.id;

    eventBus.emit("backgroundWorkerInitialized", backgroundWorker);
  }

  /**
   * Tries to dequeue runs for all the active versions running.
   * For the latest version we will pull from the main queue, so we don't specify that.
   */
  async #dequeueRuns() {
    if (!this.config) {
      throw new Error("No config, can't dequeue runs");
    }

    if (!this.latestWorkerId) {
      //try again later
      logger.debug(`[DevSupervisor] dequeueRuns. No latest worker ID, trying again later`);
      setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithoutRun);
      return;
    }

    if (
      this.runLimiter &&
      this.runLimiter.activeCount + this.runLimiter.pendingCount > this.runLimiter.concurrency
    ) {
      logger.debug(`[DevSupervisor] dequeueRuns. Run limit reached, trying again later`);
      setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithoutRun);
      return;
    }

    //get relevant versions
    //ignore deprecated and the latest worker
    const oldWorkerIds = this.#getActiveOldWorkers();

    try {
      //todo later we should track available resources and machines used, and pass them in here (it supports it)
      const result = await this.options.client.dev.dequeue({
        currentWorker: this.latestWorkerId,
        oldWorkers: oldWorkerIds,
      });

      if (!result.success) {
        logger.debug(`[DevSupervisor] dequeueRuns. Failed to dequeue runs`, {
          error: result.error,
        });
        setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithoutRun);
        return;
      }

      //no runs, try again later
      if (result.data.dequeuedMessages.length === 0) {
        // logger.debug(`No dequeue runs for versions`, {
        //   oldWorkerIds,
        //   latestWorkerId: this.latestWorkerId,
        // });
        setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithoutRun);
        return;
      }

      logger.debug(`[DevSupervisor] dequeueRuns. Results`, {
        dequeuedMessages: JSON.stringify(result.data.dequeuedMessages),
      });

      //start runs
      for (const message of result.data.dequeuedMessages) {
        const worker = this.workers.get(message.backgroundWorker.friendlyId);

        if (!worker) {
          logger.debug(
            `[DevSupervisor] dequeueRuns. Dequeued a run but there's no BackgroundWorker so we can't execute it`,
            {
              run: message.run.friendlyId,
              workerId: message.backgroundWorker.friendlyId,
            }
          );

          //todo call the API to crash the run with a good message
          continue;
        }

        let runController = this.runControllers.get(message.run.friendlyId);
        if (runController) {
          logger.debug(
            `[DevSupervisor] dequeueRuns. Dequeuing a run that already has a runController`,
            {
              runController: message.run.friendlyId,
            }
          );

          //todo, what do we do here?
          //todo I think the run shouldn't exist and we should kill the process but TBC
          continue;
        }

        if (!worker.serverWorker) {
          logger.debug(`[DevSupervisor] dequeueRuns. Worker doesn't have a serverWorker`, {
            run: message.run.friendlyId,
            worker,
          });
          continue;
        }

        if (!worker.manifest) {
          logger.debug(`[DevSupervisor] dequeueRuns. Worker doesn't have a manifest`, {
            run: message.run.friendlyId,
            worker,
          });
          continue;
        }

        if (!this.taskRunProcessPool) {
          logger.debug(`[DevSupervisor] dequeueRuns. No task run process pool`, {
            run: message.run.friendlyId,
            worker,
          });
          continue;
        }

        //new run
        runController = new DevRunController({
          runFriendlyId: message.run.friendlyId,
          worker: worker,
          httpClient: this.options.client,
          logLevel: this.options.args.logLevel,
          taskRunProcessPool: this.taskRunProcessPool,
          onFinished: () => {
            logger.debug("[DevSupervisor] Run finished", { runId: message.run.friendlyId });

            //stop the run controller, and remove it
            runController?.stop();
            this.runControllers.delete(message.run.friendlyId);
            this.#unsubscribeFromRunNotifications(message.run.friendlyId);

            //stop the worker if it is deprecated and there are no more runs
            if (worker.deprecated) {
              this.#tryDeleteWorker(message.backgroundWorker.friendlyId).finally(() => {});
            }
          },
          onSubscribeToRunNotifications: async (run, snapshot) => {
            this.#subscribeToRunNotifications();
          },
          onUnsubscribeFromRunNotifications: async (run, snapshot) => {
            this.#unsubscribeFromRunNotifications(run.friendlyId);
          },
        });

        this.runControllers.set(message.run.friendlyId, runController);

        if (this.runLimiter) {
          this.runLimiter(() => runController.start(message)).then(() => {
            logger.debug("[DevSupervisor] Run started", { runId: message.run.friendlyId });
          });
        } else {
          //don't await for run completion, we want to dequeue more runs
          runController.start(message).then(() => {
            logger.debug("[DevSupervisor] Run started", { runId: message.run.friendlyId });
          });
        }
      }

      setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithRun);
    } catch (error) {
      logger.debug(`[DevSupervisor] dequeueRuns. Error thrown`, { error });
      //dequeue again
      setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithoutRun);
    }
  }

  async #startPresenceConnection() {
    try {
      const eventSource = this.options.client.dev.presenceConnection();

      // Regular "ping" messages
      eventSource.addEventListener("presence", (event: any) => {
        // logger.debug(`Presence ping received`, { event });
      });

      // Connection was lost and successfully reconnected
      eventSource.addEventListener("reconnect", (event: any) => {
        logger.debug("[DevSupervisor] Presence connection restored");
      });

      // Handle messages that might have been missed during disconnection
      eventSource.addEventListener("missed_events", (event: any) => {
        logger.debug("[DevSupervisor] Missed some presence events during disconnection");
      });

      // If you need to close it manually
      return () => {
        logger.info("[DevSupervisor] Closing presence connection");
        eventSource.close();
      };
    } catch (error) {
      throw error;
    }
  }

  async #getEnvVars(): Promise<Record<string, string>> {
    const environmentVariablesResponse = await this.options.client.getEnvironmentVariables(
      this.options.config.project
    );

    const OTEL_IMPORT_HOOK_INCLUDES = (this.options.config.instrumentedPackageNames ?? []).join(
      ","
    );

    return {
      ...resolveLocalEnvVars(
        this.options.args.envFile,
        environmentVariablesResponse.success ? environmentVariablesResponse.data.variables : {}
      ),
      NODE_ENV: "development",
      TRIGGER_API_URL: this.options.client.apiURL,
      TRIGGER_SECRET_KEY: this.options.client.accessToken!,
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
      OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
        [SemanticInternalAttributes.PROJECT_DIR]: this.options.config.workingDir,
      }),
      OTEL_IMPORT_HOOK_INCLUDES,
    };
  }

  async #registerWorker(worker: BackgroundWorker) {
    if (!worker.serverWorker) {
      return;
    }

    //deprecate other workers
    for (const [workerId, existingWorker] of this.workers.entries()) {
      if (workerId === worker.serverWorker.id) {
        continue;
      }

      existingWorker.deprecate();
      this.#tryDeleteWorker(workerId).finally(() => {});
    }

    this.workers.set(worker.serverWorker.id, worker);
  }

  #createSocket() {
    const wsUrl = new URL(this.options.client.apiURL);
    wsUrl.pathname = "/dev-worker";

    const socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: {
        Authorization: `Bearer ${this.options.client.accessToken}`,
      },
    });

    socket.on("run:notify", async ({ version, run }) => {
      logger.debug("[DevSupervisor] Received run notification", { version, run });

      this.options.client.dev.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: "run:notify received by runner",
      });

      const controller = this.runControllers.get(run.friendlyId);

      if (!controller) {
        logger.debug("[DevSupervisor] Ignoring notification, no local run ID", {
          runId: run.friendlyId,
        });
        return;
      }

      await controller.getLatestSnapshot();
    });

    socket.on("connect", () => {
      logger.debug("[DevSupervisor] Connected to supervisor");

      if (socket.recovered || this.socketIsReconnecting) {
        logger.debug("[DevSupervisor] Socket recovered");
        eventBus.emit("socketConnectionReconnected", `Connection was recovered`);
      }

      this.socketIsReconnecting = false;

      for (const controller of this.runControllers.values()) {
        controller.resubscribeToRunNotifications();
      }
    });

    socket.on("connect_error", (error) => {
      logger.debug("[DevSupervisor] Connection error", { error });
    });

    socket.on("disconnect", (reason, description) => {
      logger.debug("[DevSupervisor] socket was disconnected", {
        reason,
        description,
        active: socket.active,
      });

      if (reason === "io server disconnect") {
        // the disconnection was initiated by the server, you need to manually reconnect
        socket.connect();
      } else {
        this.socketIsReconnecting = true;
        eventBus.emit("socketConnectionDisconnected", reason);
      }
    });

    const interval = setInterval(() => {
      logger.debug("[DevSupervisor] Socket connections", {
        connections: Array.from(this.socketConnections),
      });
    }, 5000);

    return socket;
  }

  #subscribeToRunNotifications() {
    const runFriendlyIds = Array.from(this.runControllers.keys());

    if (!this.socket) {
      logger.debug("[DevSupervisor] Socket not connected");
      return;
    }

    for (const id of runFriendlyIds) {
      this.socketConnections.add(id);
    }

    logger.debug("[DevSupervisor] Subscribing to run notifications", {
      runFriendlyIds,
      connections: Array.from(this.socketConnections),
    });

    this.socket.emit("run:subscribe", { version: "1", runFriendlyIds });
  }

  #unsubscribeFromRunNotifications(friendlyId: string) {
    if (!this.socket) {
      logger.debug("[DevSupervisor] Socket not connected");
      return;
    }

    this.socketConnections.delete(friendlyId);

    logger.debug("[DevSupervisor] Unsubscribing from run notifications", {
      runFriendlyId: friendlyId,
      connections: Array.from(this.socketConnections),
    });

    this.socket.emit("run:unsubscribe", { version: "1", runFriendlyIds: [friendlyId] });
  }

  #getActiveOldWorkers() {
    return Array.from(this.workers.values())
      .filter((worker) => {
        //exclude the latest
        if (worker.serverWorker?.id === this.latestWorkerId) {
          return false;
        }

        //if it's deprecated AND there are no executing runs, then filter it out
        if (worker.deprecated && worker.serverWorker?.id) {
          return this.#workerHasInProgressRuns(worker.serverWorker.id);
        }

        return true;
      })
      .map((worker) => worker.serverWorker?.id)
      .filter((id): id is string => id !== undefined);
  }

  #workerHasInProgressRuns(friendlyId: string) {
    for (const controller of this.runControllers.values()) {
      logger.debug("[DevSupervisor] Checking controller", {
        controllerFriendlyId: controller.workerFriendlyId,
        friendlyId,
      });
      if (controller.workerFriendlyId === friendlyId) {
        return true;
      }
    }

    return false;
  }

  /** Deletes the worker if there are no active runs, after a delay */
  async #tryDeleteWorker(friendlyId: string) {
    await awaitTimeout(1_000);
    this.#deleteWorker(friendlyId);
  }

  #deleteWorker(friendlyId: string) {
    logger.debug("[DevSupervisor] Delete worker (if relevant)", {
      workerId: friendlyId,
    });

    const worker = this.workers.get(friendlyId);
    if (!worker) {
      return;
    }

    if (this.#workerHasInProgressRuns(friendlyId)) {
      return;
    }

    worker.stop();
    this.workers.delete(friendlyId);
  }
}

type ValidationIssue =
  | {
      type: "duplicateTaskId";
      duplicationTaskIds: string[];
    }
  | {
      type: "noTasksDefined";
    };

function validateWorkerManifest(manifest: WorkerManifest): ValidationIssue | undefined {
  const issues: ValidationIssue[] = [];

  if (!manifest.tasks || manifest.tasks.length === 0) {
    return { type: "noTasksDefined" };
  }

  // Check for any duplicate task ids
  const taskIds = manifest.tasks.map((task) => task.id);
  const duplicateTaskIds = taskIds.filter((id, index) => taskIds.indexOf(id) !== index);

  if (duplicateTaskIds.length > 0) {
    return { type: "duplicateTaskId", duplicationTaskIds: duplicateTaskIds };
  }

  return undefined;
}

function generationValidationIssueHeader(issue: ValidationIssue) {
  switch (issue.type) {
    case "duplicateTaskId": {
      return `Duplicate task ids detected`;
    }
    case "noTasksDefined": {
      return `No tasks exported from your trigger files`;
    }
  }
}

function generateValidationIssueFooter(issue: ValidationIssue) {
  switch (issue.type) {
    case "duplicateTaskId": {
      return cliLink("View the task docs", "https://trigger.dev/docs/tasks/overview");
    }
    case "noTasksDefined": {
      return cliLink("View the task docs", "https://trigger.dev/docs/tasks/overview");
    }
  }
}

function generateValidationIssueMessage(
  issue: ValidationIssue,
  manifest: WorkerManifest,
  buildManifest: BuildManifest
) {
  switch (issue.type) {
    case "duplicateTaskId": {
      return createDuplicateTaskIdOutputErrorMessage(issue.duplicationTaskIds, manifest.tasks);
    }
    case "noTasksDefined": {
      return `
        Files:
        ${buildManifest.files.map((file) => file.entry).join("\n")}
        Make sure you have at least one task exported from your trigger files.
        You may have defined a task and forgot to add the export statement:
        \`\`\`ts
        import { task } from "@trigger.dev/sdk/v3";
        👇 Don't forget this
        export const myTask = task({
          id: "myTask",
          async run() {
            // Your task logic here
          }
        });
        \`\`\`
      `.replace(/^ {8}/gm, "");
    }
    default: {
      return `Unknown validation issue: ${issue}`;
    }
  }
}

function createDuplicateTaskIdOutputErrorMessage(
  duplicateTaskIds: Array<string>,
  tasks: Array<TaskManifest>
) {
  const duplicateTable = duplicateTaskIds
    .map((id) => {
      const $tasks = tasks.filter((task) => task.id === id);

      return `\n\n${chalkTask(id)} was found in:${tasks
        .map((task) => `\n${task.filePath} -> ${task.exportName}`)
        .join("")}`;
    })
    .join("");

  return `Duplicate ${chalkTask("task id")} detected:${duplicateTable}`;
}
