import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { env } from "../env.js";
import { getDockerHostDomain, getRunnerId } from "../util.js";
import Docker from "dockerode";

export class DockerWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("docker-workload-manager");
  private readonly docker: Docker;

  constructor(private opts: WorkloadManagerOptions) {
    this.docker = new Docker();

    if (opts.workloadApiDomain) {
      this.logger.warn("⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }
  }

  async create(opts: WorkloadManagerCreateOptions) {
    this.logger.log("create()", { opts });

    const runnerId = getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber);

    // Build environment variables
    const envVars: string[] = [
      `TRIGGER_DEQUEUED_AT_MS=${opts.dequeuedAt.getTime()}`,
      `TRIGGER_POD_SCHEDULED_AT_MS=${Date.now()}`,
      `TRIGGER_ENV_ID=${opts.envId}`,
      `TRIGGER_RUN_ID=${opts.runFriendlyId}`,
      `TRIGGER_SNAPSHOT_ID=${opts.snapshotFriendlyId}`,
      `TRIGGER_SUPERVISOR_API_PROTOCOL=${this.opts.workloadApiProtocol}`,
      `TRIGGER_SUPERVISOR_API_PORT=${this.opts.workloadApiPort}`,
      `TRIGGER_SUPERVISOR_API_DOMAIN=${this.opts.workloadApiDomain ?? getDockerHostDomain()}`,
      `TRIGGER_WORKER_INSTANCE_NAME=${env.TRIGGER_WORKER_INSTANCE_NAME}`,
      `OTEL_EXPORTER_OTLP_ENDPOINT=${env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
      `TRIGGER_RUNNER_ID=${runnerId}`,
    ];

    if (this.opts.warmStartUrl) {
      envVars.push(`TRIGGER_WARM_START_URL=${this.opts.warmStartUrl}`);
    }

    if (this.opts.metadataUrl) {
      envVars.push(`TRIGGER_METADATA_URL=${this.opts.metadataUrl}`);
    }

    if (this.opts.heartbeatIntervalSeconds) {
      envVars.push(`TRIGGER_HEARTBEAT_INTERVAL_SECONDS=${this.opts.heartbeatIntervalSeconds}`);
    }

    if (this.opts.snapshotPollIntervalSeconds) {
      envVars.push(
        `TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS=${this.opts.snapshotPollIntervalSeconds}`
      );
    }

    if (this.opts.additionalEnvVars) {
      Object.entries(this.opts.additionalEnvVars).forEach(([key, value]) => {
        envVars.push(`${key}=${value}`);
      });
    }

    const hostConfig: Docker.HostConfig = {
      NetworkMode: env.DOCKER_NETWORK,
      AutoRemove: !!this.opts.dockerAutoremove,
    };

    if (env.ENFORCE_MACHINE_PRESETS) {
      envVars.push(`TRIGGER_MACHINE_CPU=${opts.machine.cpu}`);
      envVars.push(`TRIGGER_MACHINE_MEMORY=${opts.machine.memory}`);

      hostConfig.NanoCpus = opts.machine.cpu * 1e9;
      hostConfig.Memory = opts.machine.memory * 1024 * 1024 * 1024;
    }

    const containerCreateOpts: Docker.ContainerCreateOptions = {
      Env: envVars,
      name: runnerId,
      Hostname: runnerId,
      HostConfig: hostConfig,
      Image: opts.image,
      AttachStdout: false,
      AttachStderr: false,
      AttachStdin: false,
    };

    try {
      // Create container
      const container = await this.docker.createContainer(containerCreateOpts);

      // Start container
      const startResult = await container.start();

      this.logger.debug("create succeeded", { opts, startResult, container, containerCreateOpts });
    } catch (error) {
      this.logger.error("create failed:", { opts, error, containerCreateOpts });
    }
  }
}
