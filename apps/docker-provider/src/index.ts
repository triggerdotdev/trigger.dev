import { $, type ExecaChildProcess, execa } from "execa";
import { Machine } from "@trigger.dev/core/v3";
import { SimpleLogger, TaskOperations, ProviderShell } from "@trigger.dev/core-apps";

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

  async index(opts: {
    contentHash: string;
    imageTag: string;
    envId: string;
    apiKey: string;
    apiUrl: string;
  }) {
    await this.#initialize();

    const containerName = this.#getIndexContainerName(opts.contentHash);

    logger.log(`Indexing task ${opts.imageTag}`, {
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
    });

    try {
      logger.debug(
        await execa("docker", [
          "run",
          "--network=host",
          "--rm",
          `--env=TRIGGER_SECRET_KEY=${opts.apiKey}`,
          `--env=TRIGGER_API_URL=${opts.apiUrl}`,
          `--env=COORDINATOR_HOST=${COORDINATOR_HOST}`,
          `--env=COORDINATOR_PORT=${COORDINATOR_PORT}`,
          `--env=POD_NAME=${containerName}`,
          `--env=TRIGGER_ENV_ID=${opts.envId}`,
          `--env=INDEX_TASKS=true`,
          `--name=${containerName}`,
          `${opts.imageTag}`,
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

      throw new Error(`Index failed with: ${error.stderr || error.stdout}`);
    }
  }

  async create(opts: {
    runId: string;
    attemptId: string;
    image: string;
    machine: Machine;
    envId: string;
  }) {
    await this.#initialize();

    const containerName = this.#getRunContainerName(opts.attemptId);

    try {
      logger.debug(
        await execa("docker", [
          "run",
          "--network=host",
          "--detach",
          `--env=OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}`,
          `--env=COORDINATOR_HOST=${COORDINATOR_HOST}`,
          `--env=COORDINATOR_PORT=${COORDINATOR_PORT}`,
          `--env=POD_NAME=${containerName}`,
          `--env=TRIGGER_ENV_ID=${opts.envId}`,
          `--env=TRIGGER_RUN_ID=${opts.runId}`,
          `--env=TRIGGER_ATTEMPT_ID=${opts.attemptId}`,
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

      throw new Error(`Create failed with: ${error.stderr || error.stdout}`);
    }
  }

  async restore(opts: {
    runId: string;
    attemptId: string;
    checkpointRef: string;
    machine: Machine;
  }) {
    await this.#initialize();

    const containerName = this.#getRunContainerName(opts.attemptId);

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

  #getIndexContainerName(contentHash: string) {
    return `task-index-${contentHash}`;
  }

  #getRunContainerName(attemptId: string) {
    return `task-run-${attemptId}`;
  }
}

const provider = new ProviderShell({
  tasks: new DockerTaskOperations({ forceSimulate: true }),
  type: "docker",
});

provider.listen();
