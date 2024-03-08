import { $ } from "execa";
import { Machine } from "@trigger.dev/core/v3";
import { SimpleLogger, TaskOperations, ProviderShell } from "@trigger.dev/core-apps";

const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const COORDINATOR_PORT = process.env.COORDINATOR_PORT || 8020;
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://0.0.0.0:4318";

const logger = new SimpleLogger(`[${MACHINE_NAME}]`);

class DockerTaskOperations implements TaskOperations {
  constructor(private opts = { forceSimulate: false }) {}

  async index(opts: {
    contentHash: string;
    imageTag: string;
    envId: string;
    apiKey: string;
    apiUrl: string;
  }) {
    const containerName = this.#getIndexContainerName(opts.contentHash);

    logger.log(`Indexing task ${opts.imageTag}`, {
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
    });

    const { exitCode } = logger.debug(
      await $`docker run --rm -e TRIGGER_SECRET_KEY=${opts.apiKey} -e TRIGGER_API_URL=${opts.apiUrl} -e COORDINATOR_HOST=${COORDINATOR_HOST} -e COORDINATOR_PORT=${COORDINATOR_PORT} -e POD_NAME=${containerName} -e TRIGGER_ENV_ID=${opts.envId} -e INDEX_TASKS=true --name=${containerName} ${opts.imageTag}`
    );

    if (exitCode !== 0) {
      throw new Error("docker run command failed");
    }
  }

  async create(opts: { attemptId: string; image: string; machine: Machine; envId: string }) {
    const containerName = this.#getRunContainerName(opts.attemptId);

    const { exitCode } = logger.debug(
      await $`docker run -d -e OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT} -e COORDINATOR_HOST=${COORDINATOR_HOST} -e COORDINATOR_PORT=${COORDINATOR_PORT} -e POD_NAME=${containerName} -e TRIGGER_ENV_ID=${opts.envId} -e TRIGGER_ATTEMPT_ID=${opts.attemptId} --name=${containerName} ${opts.image}`
    );

    if (exitCode !== 0) {
      throw new Error("docker run command failed");
    }
  }

  async restore(opts: { attemptId: string; checkpointRef: string; machine: Machine }) {
    const containerName = this.#getRunContainerName(opts.attemptId);

    if (this.opts.forceSimulate) {
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
    logger.log("noop: delete");
  }

  async get(opts: { runId: string }) {
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
