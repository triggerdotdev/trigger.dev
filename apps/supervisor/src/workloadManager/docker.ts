import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { x } from "tinyexec";
import { env } from "../env.js";
import { getDockerHostDomain, getRunnerId } from "../util.js";

export class DockerWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("docker-workload-provider");

  constructor(private opts: WorkloadManagerOptions) {
    if (opts.workloadApiDomain) {
      this.logger.warn("[DockerWorkloadProvider] ⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }
  }

  async create(opts: WorkloadManagerCreateOptions) {
    this.logger.log("[DockerWorkloadProvider] Creating container", { opts });

    const runnerId = getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber);

    const runArgs = [
      "run",
      "--detach",
      `--network=${env.DOCKER_NETWORK}`,
      `--env=TRIGGER_DEQUEUED_AT_MS=${opts.dequeuedAt.getTime()}`,
      `--env=TRIGGER_POD_SCHEDULED_AT_MS=${Date.now()}`,
      `--env=TRIGGER_ENV_ID=${opts.envId}`,
      `--env=TRIGGER_RUN_ID=${opts.runFriendlyId}`,
      `--env=TRIGGER_SNAPSHOT_ID=${opts.snapshotFriendlyId}`,
      `--env=TRIGGER_SUPERVISOR_API_PROTOCOL=${this.opts.workloadApiProtocol}`,
      `--env=TRIGGER_SUPERVISOR_API_PORT=${this.opts.workloadApiPort}`,
      `--env=TRIGGER_SUPERVISOR_API_DOMAIN=${this.opts.workloadApiDomain ?? getDockerHostDomain()}`,
      `--env=TRIGGER_WORKER_INSTANCE_NAME=${env.TRIGGER_WORKER_INSTANCE_NAME}`,
      `--env=OTEL_EXPORTER_OTLP_ENDPOINT=${env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
      `--env=TRIGGER_RUNNER_ID=${runnerId}`,
      `--hostname=${runnerId}`,
      `--name=${runnerId}`,
    ];

    if (this.opts.warmStartUrl) {
      runArgs.push(`--env=TRIGGER_WARM_START_URL=${this.opts.warmStartUrl}`);
    }

    if (this.opts.metadataUrl) {
      runArgs.push(`--env=TRIGGER_METADATA_URL=${this.opts.metadataUrl}`);
    }

    if (this.opts.heartbeatIntervalSeconds) {
      runArgs.push(
        `--env=TRIGGER_HEARTBEAT_INTERVAL_SECONDS=${this.opts.heartbeatIntervalSeconds}`
      );
    }

    if (this.opts.snapshotPollIntervalSeconds) {
      runArgs.push(
        `--env=TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS=${this.opts.snapshotPollIntervalSeconds}`
      );
    }

    if (this.opts.additionalEnvVars) {
      Object.entries(this.opts.additionalEnvVars).forEach(([key, value]) => {
        runArgs.push(`--env=${key}=${value}`);
      });
    }

    if (env.ENFORCE_MACHINE_PRESETS) {
      runArgs.push(`--cpus=${opts.machine.cpu}`, `--memory=${opts.machine.memory}G`);
      runArgs.push(`--env=TRIGGER_MACHINE_CPU=${opts.machine.cpu}`);
      runArgs.push(`--env=TRIGGER_MACHINE_MEMORY=${opts.machine.memory}`);
    }

    runArgs.push(`${opts.image}`);

    try {
      const { stdout, stderr } = await x("docker", runArgs);
      this.logger.debug("[DockerWorkloadProvider] Create succeeded", { stdout, stderr });
    } catch (error) {
      this.logger.error("[DockerWorkloadProvider] Create failed:", { opts, error });
    }
  }
}
