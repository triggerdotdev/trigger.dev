import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { env } from "../env.js";
import { getDockerHostDomain, getRunnerId, normalizeDockerHostUrl } from "../util.js";
import Docker from "dockerode";
import { tryCatch } from "@trigger.dev/core";

export class DockerWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("docker-workload-manager");
  private readonly docker: Docker;

  private readonly runnerNetworks: string[];
  private readonly auth?: Docker.AuthConfig;
  private readonly platformOverride?: string;

  constructor(private opts: WorkloadManagerOptions) {
    this.docker = new Docker({
      version: env.DOCKER_API_VERSION,
    });

    if (opts.workloadApiDomain) {
      this.logger.warn("⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }

    this.runnerNetworks = env.DOCKER_RUNNER_NETWORKS.split(",");

    this.platformOverride = env.DOCKER_PLATFORM;
    if (this.platformOverride) {
      this.logger.info("🖥️  Platform override", {
        targetPlatform: this.platformOverride,
        hostPlatform: process.arch,
      });
    }

    if (env.DOCKER_REGISTRY_USERNAME && env.DOCKER_REGISTRY_PASSWORD && env.DOCKER_REGISTRY_URL) {
      this.logger.info("🐋 Using Docker registry credentials", {
        username: env.DOCKER_REGISTRY_USERNAME,
        url: env.DOCKER_REGISTRY_URL,
      });

      this.auth = {
        username: env.DOCKER_REGISTRY_USERNAME,
        password: env.DOCKER_REGISTRY_PASSWORD,
        serveraddress: env.DOCKER_REGISTRY_URL,
      };
    } else {
      this.logger.warn("🐋 No Docker registry credentials provided, skipping auth");
    }
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
      `PRETTY_LOGS=${env.RUNNER_PRETTY_LOGS}`,
    ];

    if (this.opts.warmStartUrl) {
      envVars.push(`TRIGGER_WARM_START_URL=${normalizeDockerHostUrl(this.opts.warmStartUrl)}`);
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

    let imageRef = opts.image;

    if (env.DOCKER_STRIP_IMAGE_DIGEST) {
      imageRef = opts.image.split("@")[0]!;
    }

    const containerCreateOpts: Docker.ContainerCreateOptions = {
      name: runnerId,
      Hostname: runnerId,
      HostConfig: hostConfig,
      Image: imageRef,
      AttachStdout: false,
      AttachStderr: false,
      AttachStdin: false,
    };

    if (this.platformOverride) {
      containerCreateOpts.platform = this.platformOverride;
    }

    const logger = this.logger.child({ opts, containerCreateOpts });

    const [inspectError, inspectResult] = await tryCatch(this.docker.getImage(imageRef).inspect());

    let shouldPull = !!inspectError;
    if (this.platformOverride) {
      const imageArchitecture = inspectResult?.Architecture;

      // When the image architecture doesn't match the platform, we need to pull the image
      if (imageArchitecture && !this.platformOverride.includes(imageArchitecture)) {
        shouldPull = true;
      }
    }

    // If the image is not present, try to pull it
    if (shouldPull) {
      logger.info("Pulling image", {
        error: inspectError,
        image: opts.image,
        targetPlatform: this.platformOverride,
        imageArchitecture: inspectResult?.Architecture,
      });

      // Ensure the image is present
      const [createImageError, imageResponseReader] = await tryCatch(
        this.docker.createImage(this.auth, {
          fromImage: imageRef,
          ...(this.platformOverride ? { platform: this.platformOverride } : {}),
        })
      );
      if (createImageError) {
        logger.error("Failed to pull image", { error: createImageError });
        return;
      }

      const [imageReadError, imageResponse] = await tryCatch(readAllChunks(imageResponseReader));
      if (imageReadError) {
        logger.error("failed to read image response", { error: imageReadError });
        return;
      }

      logger.debug("pulled image", { image: opts.image, imageResponse });
    } else {
      // Image is present, so we can use it to create the container
    }

    // Create container
    const [createContainerError, container] = await tryCatch(
      this.docker.createContainer({
        ...containerCreateOpts,
        // Add env vars here so they're not logged
        Env: envVars,
      })
    );

    if (createContainerError) {
      logger.error("Failed to create container", { error: createContainerError });
      return;
    }

    // If there are multiple networks to attach to we need to attach the remaining ones after creation
    if (remainingNetworks.length > 0) {
      await this.attachContainerToNetworks({
        containerId: container.id,
        networkNames: remainingNetworks,
      });
    }

    // Start container
    const [startError, startResult] = await tryCatch(container.start());

    if (startError) {
      logger.error("Failed to start container", { error: startError, containerId: container.id });
      return;
    }

    logger.debug("create succeeded", { startResult, containerId: container.id });
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

async function readAllChunks(reader: NodeJS.ReadableStream) {
  const chunks = [];
  for await (const chunk of reader) {
    chunks.push(chunk.toString());
  }
  return chunks;
}
