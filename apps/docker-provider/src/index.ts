import { $, type ExecaChildProcess, execa } from "execa";
import {
  ProviderShell,
  TaskOperations,
  TaskOperationsCreateOptions,
  TaskOperationsIndexOptions,
  TaskOperationsRestoreOptions,
} from "@trigger.dev/core/v3/apps";
import { SimpleLogger } from "@trigger.dev/core/v3/apps";
import { isExecaChildProcess } from "@trigger.dev/core/v3/apps";
import { testDockerCheckpoint } from "@trigger.dev/core/v3/serverOnly";
import { setTimeout } from "node:timers/promises";
import { PostStartCauses, PreStopCauses } from "@trigger.dev/core/v3";

const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const COORDINATOR_PORT = process.env.COORDINATOR_PORT || 8020;
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";
const DOCKER_NETWORK = process.env.DOCKER_NETWORK || "host";

const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://0.0.0.0:4318";

const FORCE_CHECKPOINT_SIMULATION = ["1", "true"].includes(
  process.env.FORCE_CHECKPOINT_SIMULATION ?? "false"
);

const logger = new SimpleLogger(`[${MACHINE_NAME}]`);

type TaskOperationsInitReturn = {
  canCheckpoint: boolean;
  willSimulate: boolean;
};

class DockerTaskOperations implements TaskOperations {
  #initialized = false;
  #canCheckpoint = false;

  constructor(private opts = { forceSimulate: false }) {}

  async init(): Promise<TaskOperationsInitReturn> {
    if (this.#initialized) {
      return this.#getInitReturn(this.#canCheckpoint);
    }

    logger.log("Initializing task operations");

    const testCheckpoint = await testDockerCheckpoint();

    if (testCheckpoint.ok) {
      return this.#getInitReturn(true);
    }

    logger.error(testCheckpoint.message, testCheckpoint.error);
    return this.#getInitReturn(false);
  }

  #getInitReturn(canCheckpoint: boolean): TaskOperationsInitReturn {
    this.#canCheckpoint = canCheckpoint;

    if (canCheckpoint) {
      if (!this.#initialized) {
        logger.log("Full checkpoint support!");
      }
    }

    this.#initialized = true;

    const willSimulate = !canCheckpoint || this.opts.forceSimulate;

    if (willSimulate) {
      logger.log("Simulation mode enabled. Containers will be paused, not checkpointed.", {
        forceSimulate: this.opts.forceSimulate,
      });
    }

    return {
      canCheckpoint,
      willSimulate,
    };
  }

  async index(opts: TaskOperationsIndexOptions) {
    await this.init();

    const containerName = this.#getIndexContainerName(opts.shortCode);

    logger.log(`Indexing task ${opts.imageRef}`, {
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
    });

    logger.debug(
      await execa("docker", [
        "run",
        `--network=${DOCKER_NETWORK}`,
        "--rm",
        `--env=INDEX_TASKS=true`,
        `--env=TRIGGER_SECRET_KEY=${opts.apiKey}`,
        `--env=TRIGGER_API_URL=${opts.apiUrl}`,
        `--env=TRIGGER_ENV_ID=${opts.envId}`,
        `--env=OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}`,
        `--env=POD_NAME=${containerName}`,
        `--env=COORDINATOR_HOST=${COORDINATOR_HOST}`,
        `--env=COORDINATOR_PORT=${COORDINATOR_PORT}`,
        `--name=${containerName}`,
        `${opts.imageRef}`,
      ])
    );
  }

  async create(opts: TaskOperationsCreateOptions) {
    await this.init();

    const containerName = this.#getRunContainerName(opts.runId, opts.nextAttemptNumber);

    const runArgs = [
      "run",
      `--network=${DOCKER_NETWORK}`,
      "--detach",
      `--env=TRIGGER_ENV_ID=${opts.envId}`,
      `--env=TRIGGER_RUN_ID=${opts.runId}`,
      `--env=OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}`,
      `--env=POD_NAME=${containerName}`,
      `--env=COORDINATOR_HOST=${COORDINATOR_HOST}`,
      `--env=COORDINATOR_PORT=${COORDINATOR_PORT}`,
      `--env=TRIGGER_POD_SCHEDULED_AT_MS=${Date.now()}`,
      `--name=${containerName}`,
    ];

    if (process.env.ENFORCE_MACHINE_PRESETS) {
      runArgs.push(`--cpus=${opts.machine.cpu}`, `--memory=${opts.machine.memory}G`);
    }

    if (opts.dequeuedAt) {
      runArgs.push(`--env=TRIGGER_RUN_DEQUEUED_AT_MS=${opts.dequeuedAt}`);
    }

    runArgs.push(`${opts.image}`);

    try {
      logger.debug(await execa("docker", runArgs));
    } catch (error) {
      if (!isExecaChildProcess(error)) {
        throw error;
      }

      logger.error("Create failed:", {
        opts,
        exitCode: error.exitCode,
        escapedCommand: error.escapedCommand,
        stdout: error.stdout,
        stderr: error.stderr,
      });
    }
  }

  async restore(opts: TaskOperationsRestoreOptions) {
    await this.init();

    const containerName = this.#getRunContainerName(opts.runId, opts.attemptNumber);

    if (!this.#canCheckpoint || this.opts.forceSimulate) {
      logger.log("Simulating restore");

      const unpause = logger.debug(await $`docker unpause ${containerName}`);

      if (unpause.exitCode !== 0) {
        throw new Error("docker unpause command failed");
      }

      await this.#sendPostStart(containerName);
      return;
    }

    const { exitCode } = logger.debug(
      await $`docker start --checkpoint=${opts.checkpointRef} ${containerName}`
    );

    if (exitCode !== 0) {
      throw new Error("docker start command failed");
    }

    await this.#sendPostStart(containerName);
  }

  async delete(opts: { runId: string }) {
    await this.init();

    const containerName = this.#getRunContainerName(opts.runId);
    await this.#sendPreStop(containerName);

    logger.log("noop: delete");
  }

  async get(opts: { runId: string }) {
    await this.init();

    logger.log("noop: get");
  }

  #getIndexContainerName(suffix: string) {
    return `task-index-${suffix}`;
  }

  #getRunContainerName(suffix: string, attemptNumber?: number) {
    return `task-run-${suffix}${attemptNumber && attemptNumber > 1 ? `-att${attemptNumber}` : ""}`;
  }

  async #sendPostStart(containerName: string): Promise<void> {
    try {
      const port = await this.#getHttpServerPort(containerName);
      logger.debug(await this.#runLifecycleCommand(containerName, port, "postStart", "restore"));
    } catch (error) {
      logger.error("postStart error", { error });
      throw new Error("postStart command failed");
    }
  }

  async #sendPreStop(containerName: string): Promise<void> {
    try {
      const port = await this.#getHttpServerPort(containerName);
      logger.debug(await this.#runLifecycleCommand(containerName, port, "preStop", "terminate"));
    } catch (error) {
      logger.error("preStop error", { error });
      throw new Error("preStop command failed");
    }
  }

  async #getHttpServerPort(containerName: string): Promise<number> {
    // We first get the correct port, which is random during dev as we run with host networking and need to avoid clashes
    // FIXME: Skip this in prod
    const logs = logger.debug(await $`docker logs ${containerName}`);
    const matches = logs.stdout.match(/http server listening on port (?<port>[0-9]+)/);

    const port = Number(matches?.groups?.port);

    if (!port) {
      throw new Error("failed to extract port from logs");
    }

    return port;
  }

  async #runLifecycleCommand<THookType extends "postStart" | "preStop">(
    containerName: string,
    port: number,
    type: THookType,
    cause: THookType extends "postStart" ? PostStartCauses : PreStopCauses,
    retryCount = 0
  ): Promise<ExecaChildProcess> {
    try {
      return await execa("docker", [
        "exec",
        containerName,
        "busybox",
        "wget",
        "-q",
        "-O-",
        `127.0.0.1:${port}/${type}?cause=${cause}`,
      ]);
    } catch (error: any) {
      if (type === "postStart" && retryCount < 6) {
        logger.debug(`retriable ${type} error`, { retryCount, message: error?.message });
        await setTimeout(exponentialBackoff(retryCount + 1, 2, 50, 1150, 50));

        return this.#runLifecycleCommand(containerName, port, type, cause, retryCount + 1);
      }

      logger.error(`final ${type} error`, { message: error?.message });
      throw new Error(`${type} command failed after ${retryCount - 1} retries`);
    }
  }
}

const provider = new ProviderShell({
  tasks: new DockerTaskOperations({ forceSimulate: FORCE_CHECKPOINT_SIMULATION }),
  type: "docker",
});

provider.listen();

function exponentialBackoff(
  retryCount: number,
  exponential: number,
  minDelay: number,
  maxDelay: number,
  jitter: number
): number {
  // Calculate the delay using the exponential backoff formula
  const delay = Math.min(Math.pow(exponential, retryCount) * minDelay, maxDelay);

  // Calculate the jitter
  const jitterValue = Math.random() * jitter;

  // Return the calculated delay with jitter
  return delay + jitterValue;
}
