import { SupervisorSession } from "@trigger.dev/core/v3/workers";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { env } from "./env.js";
import { WorkloadServer } from "./workloadServer/index.js";
import type { WorkloadManagerOptions, WorkloadManager } from "./workloadManager/types.js";
import Docker from "dockerode";
import { z } from "zod";
import { type DequeuedMessage } from "@trigger.dev/core/v3";
import {
  DockerResourceMonitor,
  KubernetesResourceMonitor,
  NoopResourceMonitor,
  type ResourceMonitor,
} from "./resourceMonitor.js";
import { KubernetesWorkloadManager } from "./workloadManager/kubernetes.js";
import { DockerWorkloadManager } from "./workloadManager/docker.js";
import {
  HttpServer,
  CheckpointClient,
  isKubernetesEnvironment,
} from "@trigger.dev/core/v3/serverOnly";
import { createK8sApi } from "./clients/kubernetes.js";
import { collectDefaultMetrics } from "prom-client";
import { register } from "./metrics.js";
import { PodCleaner } from "./services/podCleaner.js";
import { FailedPodHandler } from "./services/failedPodHandler.js";
import { getWorkerToken } from "./workerToken.js";

if (env.METRICS_COLLECT_DEFAULTS) {
  collectDefaultMetrics({ register });
}

class ManagedSupervisor {
  private readonly workerSession: SupervisorSession;
  private readonly metricsServer?: HttpServer;
  private readonly workloadServer: WorkloadServer;
  private readonly workloadManager: WorkloadManager;
  private readonly logger = new SimpleStructuredLogger("managed-supervisor");
  private readonly resourceMonitor: ResourceMonitor;
  private readonly checkpointClient?: CheckpointClient;

  private readonly podCleaner?: PodCleaner;
  private readonly failedPodHandler?: FailedPodHandler;

  private readonly isKubernetes = isKubernetesEnvironment(env.KUBERNETES_FORCE_ENABLED);
  private readonly warmStartUrl = env.TRIGGER_WARM_START_URL;

  constructor() {
    const { TRIGGER_WORKER_TOKEN, MANAGED_WORKER_SECRET, ...envWithoutSecrets } = env;

    if (env.DEBUG) {
      this.logger.debug("Starting up", { envWithoutSecrets });
    }

    if (this.warmStartUrl) {
      this.logger.log("🔥 Warm starts enabled", {
        warmStartUrl: this.warmStartUrl,
      });
    }

    const workloadManagerOptions = {
      workloadApiProtocol: env.TRIGGER_WORKLOAD_API_PROTOCOL,
      workloadApiDomain: env.TRIGGER_WORKLOAD_API_DOMAIN,
      workloadApiPort: env.TRIGGER_WORKLOAD_API_PORT_EXTERNAL,
      warmStartUrl: this.warmStartUrl,
      metadataUrl: env.TRIGGER_METADATA_URL,
      imagePullSecrets: env.KUBERNETES_IMAGE_PULL_SECRETS?.split(","),
      heartbeatIntervalSeconds: env.RUNNER_HEARTBEAT_INTERVAL_SECONDS,
      snapshotPollIntervalSeconds: env.RUNNER_SNAPSHOT_POLL_INTERVAL_SECONDS,
      additionalEnvVars: env.RUNNER_ADDITIONAL_ENV_VARS,
      dockerAutoremove: env.DOCKER_AUTOREMOVE_EXITED_CONTAINERS,
    } satisfies WorkloadManagerOptions;

    this.resourceMonitor = env.RESOURCE_MONITOR_ENABLED
      ? this.isKubernetes
        ? new KubernetesResourceMonitor(createK8sApi(), env.TRIGGER_WORKER_INSTANCE_NAME)
        : new DockerResourceMonitor(new Docker())
      : new NoopResourceMonitor();

    this.workloadManager = this.isKubernetes
      ? new KubernetesWorkloadManager(workloadManagerOptions)
      : new DockerWorkloadManager(workloadManagerOptions);

    if (this.isKubernetes) {
      if (env.POD_CLEANER_ENABLED) {
        this.logger.log("🧹 Pod cleaner enabled", {
          namespace: env.KUBERNETES_NAMESPACE,
          batchSize: env.POD_CLEANER_BATCH_SIZE,
          intervalMs: env.POD_CLEANER_INTERVAL_MS,
        });
        this.podCleaner = new PodCleaner({
          register,
          namespace: env.KUBERNETES_NAMESPACE,
          batchSize: env.POD_CLEANER_BATCH_SIZE,
          intervalMs: env.POD_CLEANER_INTERVAL_MS,
        });
      } else {
        this.logger.warn("Pod cleaner disabled");
      }

      if (env.FAILED_POD_HANDLER_ENABLED) {
        this.logger.log("🔁 Failed pod handler enabled", {
          namespace: env.KUBERNETES_NAMESPACE,
          reconnectIntervalMs: env.FAILED_POD_HANDLER_RECONNECT_INTERVAL_MS,
        });
        this.failedPodHandler = new FailedPodHandler({
          register,
          namespace: env.KUBERNETES_NAMESPACE,
          reconnectIntervalMs: env.FAILED_POD_HANDLER_RECONNECT_INTERVAL_MS,
        });
      } else {
        this.logger.warn("Failed pod handler disabled");
      }
    }

    if (env.TRIGGER_DEQUEUE_INTERVAL_MS > env.TRIGGER_DEQUEUE_IDLE_INTERVAL_MS) {
      this.logger.warn(
        `⚠️  TRIGGER_DEQUEUE_INTERVAL_MS (${env.TRIGGER_DEQUEUE_INTERVAL_MS}) is greater than TRIGGER_DEQUEUE_IDLE_INTERVAL_MS (${env.TRIGGER_DEQUEUE_IDLE_INTERVAL_MS}) - did you mix them up?`
      );
    }

    this.workerSession = new SupervisorSession({
      workerToken: getWorkerToken(),
      apiUrl: env.TRIGGER_API_URL,
      instanceName: env.TRIGGER_WORKER_INSTANCE_NAME,
      managedWorkerSecret: env.MANAGED_WORKER_SECRET,
      dequeueIntervalMs: env.TRIGGER_DEQUEUE_INTERVAL_MS,
      dequeueIdleIntervalMs: env.TRIGGER_DEQUEUE_IDLE_INTERVAL_MS,
      queueConsumerEnabled: env.TRIGGER_DEQUEUE_ENABLED,
      maxRunCount: env.TRIGGER_DEQUEUE_MAX_RUN_COUNT,
      maxConsumerCount: env.TRIGGER_DEQUEUE_MAX_CONSUMER_COUNT,
      runNotificationsEnabled: env.TRIGGER_WORKLOAD_API_ENABLED,
      heartbeatIntervalSeconds: env.TRIGGER_WORKER_HEARTBEAT_INTERVAL_SECONDS,
      sendRunDebugLogs: env.SEND_RUN_DEBUG_LOGS,
      preDequeue: async () => {
        if (!env.RESOURCE_MONITOR_ENABLED) {
          return {};
        }

        if (this.isKubernetes) {
          // Not used in k8s for now
          return {};
        }

        const resources = await this.resourceMonitor.getNodeResources();

        return {
          maxResources: {
            cpu: resources.cpuAvailable,
            memory: resources.memoryAvailable,
          },
          skipDequeue: resources.cpuAvailable < 0.25 || resources.memoryAvailable < 0.25,
        };
      },
      preSkip: async () => {
        // When the node is full, it should still try to warm start runs
        // await this.tryWarmStartAllThisNode();
      },
    });

    if (env.TRIGGER_CHECKPOINT_URL) {
      this.logger.log("🥶 Checkpoints enabled", {
        checkpointUrl: env.TRIGGER_CHECKPOINT_URL,
      });

      this.checkpointClient = new CheckpointClient({
        apiUrl: new URL(env.TRIGGER_CHECKPOINT_URL),
        workerClient: this.workerSession.httpClient,
        orchestrator: this.isKubernetes ? "KUBERNETES" : "DOCKER",
      });
    }

    this.workerSession.on("runNotification", async ({ time, run }) => {
      this.logger.log("runNotification", { time, run });

      this.workloadServer.notifyRun({ run });
    });

    this.workerSession.on("runQueueMessage", async ({ time, message }) => {
      this.logger.log(`Received message with timestamp ${time.toLocaleString()}`, message);

      if (message.completedWaitpoints.length > 0) {
        this.logger.debug("Run has completed waitpoints", {
          runId: message.run.id,
          completedWaitpoints: message.completedWaitpoints.length,
        });
      }

      if (!message.image) {
        this.logger.error("Run has no image", { runId: message.run.id });
        return;
      }

      const { checkpoint, ...rest } = message;

      if (checkpoint) {
        this.logger.log("Restoring run", { runId: message.run.id });

        if (!this.checkpointClient) {
          this.logger.error("No checkpoint client", { runId: message.run.id });
          return;
        }

        try {
          const didRestore = await this.checkpointClient.restoreRun({
            runFriendlyId: message.run.friendlyId,
            snapshotFriendlyId: message.snapshot.friendlyId,
            body: {
              ...rest,
              checkpoint,
            },
          });

          if (didRestore) {
            this.logger.log("Restore successful", { runId: message.run.id });
          } else {
            this.logger.error("Restore failed", { runId: message.run.id });
          }
        } catch (error) {
          this.logger.error("Failed to restore run", { error });
        }

        return;
      }

      this.logger.log("Scheduling run", { runId: message.run.id });

      const didWarmStart = await this.tryWarmStart(message);

      if (didWarmStart) {
        this.logger.log("Warm start successful", { runId: message.run.id });
        return;
      }

      try {
        await this.workloadManager.create({
          dequeuedAt: message.dequeuedAt,
          envId: message.environment.id,
          envType: message.environment.type,
          image: message.image,
          machine: message.run.machine,
          orgId: message.organization.id,
          projectId: message.project.id,
          runId: message.run.id,
          runFriendlyId: message.run.friendlyId,
          version: message.version,
          nextAttemptNumber: message.run.attemptNumber,
          snapshotId: message.snapshot.id,
          snapshotFriendlyId: message.snapshot.friendlyId,
        });

        // Disabled for now
        // this.resourceMonitor.blockResources({
        //   cpu: message.run.machine.cpu,
        //   memory: message.run.machine.memory,
        // });
      } catch (error) {
        this.logger.error("Failed to create workload", { error });
      }
    });

    if (env.METRICS_ENABLED) {
      this.metricsServer = new HttpServer({
        port: env.METRICS_PORT,
        host: env.METRICS_HOST,
        metrics: {
          register,
          expose: true,
        },
      });
    }

    // Responds to workload requests only
    this.workloadServer = new WorkloadServer({
      port: env.TRIGGER_WORKLOAD_API_PORT_INTERNAL,
      host: env.TRIGGER_WORKLOAD_API_HOST_INTERNAL,
      workerClient: this.workerSession.httpClient,
      checkpointClient: this.checkpointClient,
    });

    this.workloadServer.on("runConnected", this.onRunConnected.bind(this));
    this.workloadServer.on("runDisconnected", this.onRunDisconnected.bind(this));
  }

  async onRunConnected({ run }: { run: { friendlyId: string } }) {
    this.logger.debug("Run connected", { run });
    this.workerSession.subscribeToRunNotifications([run.friendlyId]);
  }

  async onRunDisconnected({ run }: { run: { friendlyId: string } }) {
    this.logger.debug("Run disconnected", { run });
    this.workerSession.unsubscribeFromRunNotifications([run.friendlyId]);
  }

  private async tryWarmStart(dequeuedMessage: DequeuedMessage): Promise<boolean> {
    if (!this.warmStartUrl) {
      return false;
    }

    const warmStartUrlWithPath = new URL("/warm-start", this.warmStartUrl);

    try {
      const res = await fetch(warmStartUrlWithPath.href, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dequeuedMessage }),
      });

      if (!res.ok) {
        this.logger.error("Warm start failed", {
          runId: dequeuedMessage.run.id,
        });
        return false;
      }

      const data = await res.json();
      const parsedData = z.object({ didWarmStart: z.boolean() }).safeParse(data);

      if (!parsedData.success) {
        this.logger.error("Warm start response invalid", {
          runId: dequeuedMessage.run.id,
          data,
        });
        return false;
      }

      return parsedData.data.didWarmStart;
    } catch (error) {
      this.logger.error("Warm start error", {
        runId: dequeuedMessage.run.id,
        error,
      });
      return false;
    }
  }

  async start() {
    this.logger.log("Starting up");

    // Optional services
    await this.podCleaner?.start();
    await this.failedPodHandler?.start();
    await this.metricsServer?.start();

    if (env.TRIGGER_WORKLOAD_API_ENABLED) {
      this.logger.log("Workload API enabled", {
        protocol: env.TRIGGER_WORKLOAD_API_PROTOCOL,
        domain: env.TRIGGER_WORKLOAD_API_DOMAIN,
        port: env.TRIGGER_WORKLOAD_API_PORT_INTERNAL,
      });
      await this.workloadServer.start();
    } else {
      this.logger.warn("Workload API disabled");
    }

    await this.workerSession.start();
  }

  async stop() {
    this.logger.log("Shutting down");
    await this.workerSession.stop();

    // Optional services
    await this.podCleaner?.stop();
    await this.failedPodHandler?.stop();
    await this.metricsServer?.stop();
  }
}

const worker = new ManagedSupervisor();
worker.start();
