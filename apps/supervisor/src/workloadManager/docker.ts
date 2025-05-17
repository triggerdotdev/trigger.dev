import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { env } from "../env.js";
import { getDockerHostDomain, getRunnerId } from "../util.js";
import Docker from "dockerode";
import { tryCatch } from "@trigger.dev/core";

export class DockerWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("docker-workload-manager");
  private readonly docker: Docker;

  private readonly runnerNetworks: string[];

  constructor(private opts: WorkloadManagerOptions) {
    this.docker = new Docker();

    if (opts.workloadApiDomain) {
      this.logger.warn("⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }

    this.runnerNetworks = env.RUNNER_DOCKER_NETWORKS.split(",");
  }

  async create(opts: WorkloadManagerCreateOptions) {
    this.logger.log("create()", { opts });

    const runnerId = getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber);

    // Build environment variables
    const envVars: string[] = [
      `OTEL_EXPORTER_OTLP_ENDPOINT=${env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
      `TRIGGER_DEQUEUED_AT_MS=${opts.dequeuedAt.getTime()}`,
      `TRIGGER_POD_SCHEDULED_AT_MS=${Date.now()}`,
      `TRIGGER_ENV_ID=${opts.envId}`,
      `TRIGGER_RUN_ID=${opts.runFriendlyId}`,
      `TRIGGER_SNAPSHOT_ID=${opts.snapshotFriendlyId}`,
      `TRIGGER_SUPERVISOR_API_PROTOCOL=${this.opts.workloadApiProtocol}`,
      `TRIGGER_SUPERVISOR_API_PORT=${this.opts.workloadApiPort}`,
      `TRIGGER_SUPERVISOR_API_DOMAIN=${this.opts.workloadApiDomain ?? getDockerHostDomain()}`,
      `TRIGGER_WORKER_INSTANCE_NAME=${env.TRIGGER_WORKER_INSTANCE_NAME}`,
      `TRIGGER_RUNNER_ID=${runnerId}`,
      `TRIGGER_MACHINE_CPU=${opts.machine.cpu}`,
      `TRIGGER_MACHINE_MEMORY=${opts.machine.memory}`,
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
      AutoRemove: !!this.opts.dockerAutoremove,
    };

    const [firstNetwork, ...remainingNetworks] = this.runnerNetworks;

    // Always attach the first network at container creation time. This has the following benefits:
    // - If there is only a single network to attach, this will prevent having to make a separate request.
    // - If there are multiple networks to attach, this will ensure the runner won't also be connected to the bridge network
    hostConfig.NetworkMode = firstNetwork;

    if (env.DOCKER_ENFORCE_MACHINE_PRESETS) {
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

      // If there are multiple networks to attach to we need to attach the remaining ones after creation
      if (remainingNetworks.length > 0) {
        await this.attachContainerToNetworks({
          containerId: container.id,
          networkNames: remainingNetworks,
        });
      }

      // Start container
      const startResult = await container.start();

      this.logger.debug("create succeeded", {
        opts,
        startResult,
        containerId: container.id,
        containerCreateOpts,
      });
    } catch (error) {
      this.logger.error("create failed:", { opts, error, containerCreateOpts });
    }
  }

  private async attachContainerToNetworks({
    containerId,
    networkNames,
  }: {
    containerId: string;
    networkNames: string[];
  }) {
    this.logger.debug("Attaching container to networks", { containerId, networkNames });

    const [error, networkResults] = await tryCatch(
      this.docker.listNetworks({
        filters: {
          // Full name matches only to prevent unexpected results
          name: networkNames.map((name) => `^${name}$`),
        },
      })
    );

    if (error) {
      this.logger.error("Failed to list networks", { networkNames });
      return;
    }

    const results = await Promise.allSettled(
      networkResults.map((networkInfo) => {
        const network = this.docker.getNetwork(networkInfo.Id);
        return network.connect({ Container: containerId });
      })
    );

    if (results.some((r) => r.status === "rejected")) {
      this.logger.error("Failed to attach container to some networks", {
        containerId,
        networkNames,
        results,
      });
      return;
    }

    this.logger.debug("Attached container to networks", {
      containerId,
      networkNames,
      results,
    });
  }
}
