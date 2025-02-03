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
import { resolveDotEnvVars } from "../utilities/dotEnv.js";
import { eventBus } from "../utilities/eventBus.js";
import { logger } from "../utilities/logger.js";
import { sanitizeEnvVars } from "../utilities/sanitizeEnvVars.js";
import { resolveSourceFiles } from "../utilities/sourceFiles.js";
import { BackgroundWorkerEngine2 } from "./backgroundWorkerEngine2.js";
import { WorkerRuntime } from "./workerRuntime.js";
import { getVersions } from "fast-npm-meta";
import { chalkTask } from "../utilities/cliOutput.js";
import { DevRunController } from "../entryPoints/dev-run-controller.js";

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
  private config: DevConfigResponseBody;
  private disconnectPresence: (() => void) | undefined;
  private lastManifest?: BuildManifest;
  private latestWorkerId?: string;

  /* Workers are versions of the code */
  private workers: Map<string, BackgroundWorkerEngine2> = new Map();

  /* Map of run friendly id to run controller. They process runs from start to finish.  */
  private runControllers: Map<string, DevRunController> = new Map();

  constructor(public readonly options: WorkerRuntimeOptions) {}

  async init(): Promise<void> {
    logger.debug("initialized worker runtime", { options: this.options });

    //get the settings for dev
    const settings = await this.options.client.dev.config();
    if (!settings.success) {
      throw new Error(
        `Failed to connect to ${this.options.client.apiURL}. Couldn't retrieve settings: ${settings.error}`
      );
    }

    logger.debug("Got dev settings", { settings: settings.data });
    this.config = settings.data;

    //start an SSE connection for presence
    this.disconnectPresence = await this.#startPresenceConnection();

    //start dequeuing
    await this.#dequeueRuns();
  }

  async shutdown(): Promise<void> {
    this.disconnectPresence?.();
  }

  async initializeWorker(manifest: BuildManifest, stop: () => void): Promise<void> {
    if (this.lastManifest && this.lastManifest.contentHash === manifest.contentHash) {
      eventBus.emit("workerSkipped");
      stop();
      return;
    }

    const env = await this.#getEnvVars();

    const backgroundWorker = new BackgroundWorkerEngine2(manifest, {
      env,
      cwd: this.options.config.workingDir,
      stop,
    });

    await backgroundWorker.initialize();

    if (!backgroundWorker.manifest) {
      stop();
      throw new Error("Could not initialize worker");
    }

    const issues = validateWorkerManifest(backgroundWorker.manifest);

    if (issues.length > 0) {
      issues.forEach((issue) => logger.error(issue));
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
    if (!this.latestWorkerId) {
      //try again later
      setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithoutRun);
      return;
    }

    //todo handle deprecating worker versions

    //get relevant versions
    //ignore deprecated and the latest worker
    const oldWorkerIds = Array.from(this.workers.values())
      .filter((worker) => !worker.deprecated && worker.serverWorker?.id !== this.latestWorkerId)
      .map((worker) => worker.serverWorker?.id)
      .filter((id): id is string => id !== undefined);

    try {
      //todo later we should track available resources and machines used, and pass them in here (it supports it)
      const result = await this.options.client.dev.dequeue({
        currentWorker: this.latestWorkerId,
        oldWorkers: oldWorkerIds,
      });

      if (!result.success) {
        logger.error(`Failed to dequeue runs`, { error: result.error });
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

      logger.debug(`Dequeued runs`, {
        dequeuedMessages: JSON.stringify(result.data.dequeuedMessages),
      });

      //start runs
      for (const message of result.data.dequeuedMessages) {
        const worker = this.workers.get(message.backgroundWorker.friendlyId);

        if (!worker) {
          logger.error(`Dequeued a run but there's no BackgroundWorker so we can't execute it`, {
            run: message.run.id,
            workerId: message.backgroundWorker.friendlyId,
          });

          //todo call the API to crash the run with a good message
          continue;
        }

        let runController = this.runControllers.get(message.run.id);
        if (runController) {
          logger.error(`Dequeuing a run that already has a runController`, {
            runController: message.run.id,
          });

          //todo, what do we do here?
          //todo I think the run shouldn't exist and we should kill the process but TBC
          continue;
        }

        if (!worker.serverWorker) {
          logger.debug(`Worker doesn't have a serverWorker`, {
            run: message.run.id,
            worker,
          });
          continue;
        }

        if (!worker.manifest) {
          logger.debug(`Worker doesn't have a manifest`, {
            run: message.run.id,
            worker,
          });
          continue;
        }

        //new run
        runController = new DevRunController({
          runFriendlyId: message.run.friendlyId,
          workerManifest: worker.manifest,
          buildManifest: worker.build,
          envVars: worker.params.env,
          version: worker.serverWorker.version,
          httpClient: this.options.client,
        });
        this.runControllers.set(message.run.id, runController);

        await runController.start(message);
      }

      setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithRun);
    } catch (error) {
      logger.error(`Failed to dequeue runs`, { error });
      //dequeue again
      setTimeout(() => this.#dequeueRuns(), this.config.dequeueIntervalWithoutRun);
    }
  }

  async #startPresenceConnection() {
    try {
      const eventSource = await this.options.client.dev.presenceConnection();

      // Regular "ping" messages
      eventSource.addEventListener("presence", (event: any) => {
        // logger.debug(`Presence ping received`, { event });
      });

      // Connection was lost and successfully reconnected
      eventSource.addEventListener("reconnect", (event: any) => {
        logger.info("Presence connection restored");
      });

      // Handle messages that might have been missed during disconnection
      eventSource.addEventListener("missed_events", (event: any) => {
        logger.warn("Missed some presence events during disconnection");
      });

      // If you need to close it manually
      return () => {
        logger.info("Closing presence connection");
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

    const processEnv = gatherProcessEnv();
    const dotEnvVars = resolveDotEnvVars(undefined, this.options.args.envFile);
    const OTEL_IMPORT_HOOK_INCLUDES = (this.options.config.instrumentedPackageNames ?? []).join(
      ","
    );

    return {
      ...sanitizeEnvVars(processEnv),
      ...sanitizeEnvVars(
        environmentVariablesResponse.success ? environmentVariablesResponse.data.variables : {}
      ),
      ...sanitizeEnvVars(dotEnvVars),
      TRIGGER_API_URL: this.options.client.apiURL,
      TRIGGER_SECRET_KEY: this.options.client.accessToken!,
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
      OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
        [SemanticInternalAttributes.PROJECT_DIR]: this.options.config.workingDir,
      }),
      OTEL_IMPORT_HOOK_INCLUDES,
    };
  }

  async #registerWorker(worker: BackgroundWorkerEngine2) {
    if (!worker.serverWorker) {
      return;
    }

    //deprecate other workers
    for (const [workerId, existingWorker] of this.workers.entries()) {
      if (workerId === worker.serverWorker.id) {
        continue;
      }

      existingWorker.deprecate();
    }

    this.workers.set(worker.serverWorker.id, worker);
  }
}

function gatherProcessEnv() {
  const $env = {
    ...process.env,
    NODE_ENV: "development",
  };

  // Filter out undefined values
  return Object.fromEntries(Object.entries($env).filter(([key, value]) => value !== undefined));
}

function validateWorkerManifest(manifest: WorkerManifest): string[] {
  const issues: string[] = [];

  if (!manifest.tasks || manifest.tasks.length === 0) {
    issues.push("No tasks defined. Make sure you are exporting tasks.");
  }

  // Check for any duplicate task ids
  const taskIds = manifest.tasks.map((task) => task.id);
  const duplicateTaskIds = taskIds.filter((id, index) => taskIds.indexOf(id) !== index);

  if (duplicateTaskIds.length > 0) {
    issues.push(createDuplicateTaskIdOutputErrorMessage(duplicateTaskIds, manifest.tasks));
  }

  return issues;
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
