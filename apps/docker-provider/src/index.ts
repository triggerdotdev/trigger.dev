import { $, type ExecaChildProcess, execa } from "execa";
import {
  SimpleLogger,
  TaskOperations,
  ProviderShell,
  TaskOperationsRestoreOptions,
  TaskOperationsCreateOptions,
  TaskOperationsIndexOptions,
} from "@trigger.dev/core-apps";

const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const COORDINATOR_PORT = process.env.COORDINATOR_PORT || 8020;
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://0.0.0.0:4318";

const logger = new SimpleLogger(`[${MACHINE_NAME}]`);

type InitializeReturn = {
  canCheckpoint: boolean;
  willSimulate: boolean;
};

function isExecaChildProcess(maybeExeca: unknown): maybeExeca is Awaited<ExecaChildProcess> {
  return typeof maybeExeca === "object" && maybeExeca !== null && "escapedCommand" in maybeExeca;
}

class DockerTaskOperations implements TaskOperations {
  #initialized = false;
  #canCheckpoint = false;

  constructor(private opts = { forceSimulate: false }) {}

  async #initialize(): Promise<InitializeReturn> {
    if (this.#initialized) {
      return this.#getInitializeReturn();
    }

    logger.log("Initializing task operations");

    if (this.opts.forceSimulate) {
      logger.log("Forced simulation enabled. Will simulate regardless of checkpoint support.");
    }

    try {
      await $`criu --version`;
    } catch (error) {
      logger.error("No checkpoint support: Missing CRIU binary. Will simulate instead.");
      this.#canCheckpoint = false;
      this.#initialized = true;

      return this.#getInitializeReturn();
    }

    try {
      await $`docker checkpoint`;
    } catch (error) {
      logger.error("No checkpoint support: Docker needs to have experimental features enabled");
      logger.error("Will simulate instead");
      this.#canCheckpoint = false;
      this.#initialized = true;

      return this.#getInitializeReturn();
    }

    logger.log("Full checkpoint support!");

    this.#initialized = true;
    this.#canCheckpoint = true;

    return this.#getInitializeReturn();
  }

  #getInitializeReturn(): InitializeReturn {
    return {
      canCheckpoint: this.#canCheckpoint,
      willSimulate: !this.#canCheckpoint || this.opts.forceSimulate,
    };
  }

  async index(opts: TaskOperationsIndexOptions) {
    await this.#initialize();

    const containerName = this.#getIndexContainerName(opts.shortCode);

    logger.log(`Indexing task ${opts.imageRef}`, {
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
    });

    try {
      logger.debug(
        await execa("docker", [
          "run",
          "--network=host",
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
    } catch (error: any) {
      if (!isExecaChildProcess(error)) {
        throw error;
      }

      logger.error("Index failed:", {
        opts,
        exitCode: error.exitCode,
        escapedCommand: error.escapedCommand,
        stdout: error.stdout,
        stderr: error.stderr,
      });
    }
  }

  async create(opts: TaskOperationsCreateOptions) {
    await this.#initialize();

    const containerName = this.#getRunContainerName(opts.runId);

    try {
      logger.debug(
        await execa("docker", [
          "run",
          "--network=host",
          "--detach",
          `--env=TRIGGER_ENV_ID=${opts.envId}`,
          `--env=TRIGGER_RUN_ID=${opts.runId}`,
          `--env=TRIGGER_ATTEMPT_ID=${opts.attemptId}`,
          `--env=OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}`,
          `--env=POD_NAME=${containerName}`,
          `--env=COORDINATOR_HOST=${COORDINATOR_HOST}`,
          `--env=COORDINATOR_PORT=${COORDINATOR_PORT}`,
          `--name=${containerName}`,
          `${opts.image}`,
        ])
      );
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
    await this.#initialize();

    const containerName = this.#getRunContainerName(opts.runId);

    if (!this.#canCheckpoint || this.opts.forceSimulate) {
      logger.log("Simulating restore");

      const { exitCode } = logger.debug(await $`docker unpause ${containerName}`);

      if (exitCode !== 0) {
        throw new Error("docker unpause command failed");
      }

      return;
    }

    const { exitCode } = logger.debug(
      await $`docker start --checkpoint=${opts.checkpointRef} ${containerName}`
    );

    if (exitCode !== 0) {
      throw new Error("docker start command failed");
    }
  }

  async delete(opts: { runId: string }) {
    await this.#initialize();

    logger.log("noop: delete");
  }

  async get(opts: { runId: string }) {
    await this.#initialize();

    logger.log("noop: get");
  }

  #getIndexContainerName(suffix: string) {
    return `task-index-${suffix}`;
  }

  #getRunContainerName(suffix: string) {
    return `task-run-${suffix}`;
  }
}

const provider = new ProviderShell({
  tasks: new DockerTaskOperations({ forceSimulate: true }),
  type: "docker",
});

provider.listen();
