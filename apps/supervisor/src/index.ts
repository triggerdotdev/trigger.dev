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
import { ComputeWorkloadManager } from "./workloadManager/compute.js";
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
import { OtlpTraceService } from "./services/otlpTraceService.js";
import { extractTraceparent, getRestoreRunnerId } from "./util.js";
import { createRedisClient, type Redis } from "@internal/redis";
import { BackpressureMonitor } from "./backpressure/backpressureMonitor.js";
import { RedisBackpressureSignalSource } from "./backpressure/redisBackpressureSignalSource.js";
import { BackpressureMetrics } from "./backpressure/backpressureMetrics.js";
import {
  fromContext,
  recordPhaseSince,
  runWideEvent,
  setExtra,
  setMeta,
  type WideEventOptions,
} from "./wideEvents/index.js";

if (env.METRICS_COLLECT_DEFAULTS) {
  collectDefaultMetrics({ register });
}

class ManagedSupervisor {
  private readonly workerSession: SupervisorSession;
  private readonly metricsServer?: HttpServer;
  private readonly workloadServer: WorkloadServer;
  private readonly workloadManager: WorkloadManager;
  private readonly computeManager?: ComputeWorkloadManager;
  private readonly logger = new SimpleStructuredLogger("managed-supervisor");
  private readonly resourceMonitor: ResourceMonitor;
  private readonly checkpointClient?: CheckpointClient;

  private readonly podCleaner?: PodCleaner;
  private readonly failedPodHandler?: FailedPodHandler;
  private readonly tracing?: OtlpTraceService;
  private readonly backpressureMonitor?: BackpressureMonitor;
  private readonly backpressureRedis?: Redis;

  private readonly isKubernetes = isKubernetesEnvironment(env.KUBERNETES_FORCE_ENABLED);
  private readonly warmStartUrl = env.TRIGGER_WARM_START_URL;

  private readonly wideEventOpts: WideEventOptions = {
    service: "supervisor",
    env: { nodeId: env.TRIGGER_WORKER_INSTANCE_NAME },
    enabled: env.TRIGGER_WIDE_EVENTS_ENABLED,
  };
  private readonly wideEventsNoisyRoutes = env.TRIGGER_WIDE_EVENTS_NOISY_ROUTES;

  constructor() {
    // Strip secret-like env vars before debug-logging the rest. Add any new
    // secret env var here so it never lands in the DEBUG "Starting up" log.
    const {
      TRIGGER_WORKER_TOKEN,
      MANAGED_WORKER_SECRET,
      COMPUTE_GATEWAY_AUTH_TOKEN,
      TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_PASSWORD,
      ...envWithoutSecrets
    } = env;

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

    if (env.COMPUTE_GATEWAY_URL) {
      if (!env.TRIGGER_WORKLOAD_API_DOMAIN) {
        throw new Error("TRIGGER_WORKLOAD_API_DOMAIN is not set, cannot create compute manager");
      }

      const callbackUrl = `${env.TRIGGER_WORKLOAD_API_PROTOCOL}://${env.TRIGGER_WORKLOAD_API_DOMAIN}:${env.TRIGGER_WORKLOAD_API_PORT_EXTERNAL}/api/v1/compute/snapshot-complete`;

      if (env.COMPUTE_TRACE_SPANS_ENABLED) {
        this.tracing = new OtlpTraceService({
          endpointUrl: env.COMPUTE_TRACE_OTLP_ENDPOINT,
        });
      }

      const computeManager = new ComputeWorkloadManager({
        ...workloadManagerOptions,
        gateway: {
          url: env.COMPUTE_GATEWAY_URL,
          authToken: env.COMPUTE_GATEWAY_AUTH_TOKEN,
          timeoutMs: env.COMPUTE_GATEWAY_TIMEOUT_MS,
        },
        snapshots: {
          enabled: env.COMPUTE_SNAPSHOTS_ENABLED,
          delayMs: env.COMPUTE_SNAPSHOT_DELAY_MS,
          dispatchLimit: env.COMPUTE_SNAPSHOT_DISPATCH_LIMIT,
          callbackUrl,
        },
        tracing: this.tracing,
        runner: {
          instanceName: env.TRIGGER_WORKER_INSTANCE_NAME,
          otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
          prettyLogs: env.RUNNER_PRETTY_LOGS,
        },
      });
      this.computeManager = computeManager;
      this.workloadManager = computeManager;
    } else {
      this.workloadManager = this.isKubernetes
        ? new KubernetesWorkloadManager(workloadManagerOptions)
        : new DockerWorkloadManager(workloadManagerOptions);
    }

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

    if (env.TRIGGER_DEQUEUE_BACKPRESSURE_ENABLED) {
      this.backpressureRedis = createRedisClient(
        {
          host: env.TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_HOST,
          port: env.TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_PORT,
          username: env.TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_USERNAME,
          password: env.TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_PASSWORD,
          ...(env.TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_TLS_DISABLED ? {} : { tls: {} }),
        },
        {
          onError: (error) =>
            this.logger.error("Backpressure redis error", { error: error.message }),
        }
      );

      this.backpressureMonitor = new BackpressureMonitor({
        enabled: true,
        source: new RedisBackpressureSignalSource(
          this.backpressureRedis,
          env.TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_KEY
        ),
        refreshIntervalMs: env.TRIGGER_DEQUEUE_BACKPRESSURE_REFRESH_MS,
        maxVerdictAgeMs: env.TRIGGER_DEQUEUE_BACKPRESSURE_MAX_VERDICT_AGE_MS,
        rampMs: env.TRIGGER_DEQUEUE_BACKPRESSURE_RAMP_MS,
        dryRun: env.TRIGGER_DEQUEUE_BACKPRESSURE_DRY_RUN,
        logger: this.logger,
        metrics: new BackpressureMetrics({ register }),
      });

      this.logger.log("🛑 Dequeue backpressure enabled", {
        key: env.TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_KEY,
        refreshIntervalMs: env.TRIGGER_DEQUEUE_BACKPRESSURE_REFRESH_MS,
        maxVerdictAgeMs: env.TRIGGER_DEQUEUE_BACKPRESSURE_MAX_VERDICT_AGE_MS,
        rampMs: env.TRIGGER_DEQUEUE_BACKPRESSURE_RAMP_MS,
        dryRun: env.TRIGGER_DEQUEUE_BACKPRESSURE_DRY_RUN,
      });
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
      metricsRegistry: register,
      scaling: {
        strategy: env.TRIGGER_DEQUEUE_SCALING_STRATEGY,
        minConsumerCount: env.TRIGGER_DEQUEUE_MIN_CONSUMER_COUNT,
        maxConsumerCount: env.TRIGGER_DEQUEUE_MAX_CONSUMER_COUNT,
        scaleUpCooldownMs: env.TRIGGER_DEQUEUE_SCALING_UP_COOLDOWN_MS,
        scaleDownCooldownMs: env.TRIGGER_DEQUEUE_SCALING_DOWN_COOLDOWN_MS,
        targetRatio: env.TRIGGER_DEQUEUE_SCALING_TARGET_RATIO,
        ewmaAlpha: env.TRIGGER_DEQUEUE_SCALING_EWMA_ALPHA,
        batchWindowMs: env.TRIGGER_DEQUEUE_SCALING_BATCH_WINDOW_MS,
        dampingFactor: env.TRIGGER_DEQUEUE_SCALING_DAMPING_FACTOR,
        // Freeze scale-up while backpressure is hard-engaged (not during the resume
        // ramp). Undefined when backpressure is disabled → no effect on scaling.
        shouldPauseScaling: () => this.backpressureMonitor?.isEngaged() ?? false,
      },
      runNotificationsEnabled: env.TRIGGER_WORKLOAD_API_ENABLED,
      heartbeatIntervalSeconds: env.TRIGGER_WORKER_HEARTBEAT_INTERVAL_SECONDS,
      sendRunDebugLogs: env.SEND_RUN_DEBUG_LOGS,
      preDequeue: async () => {
        // Synchronous, hot-path-safe cached read; undefined when backpressure is disabled.
        const skipForBackpressure = this.backpressureMonitor?.shouldSkipDequeue() ?? false;

        if (!env.RESOURCE_MONITOR_ENABLED || this.isKubernetes) {
          // Resource monitor is not used in k8s; backpressure is the only gate there.
          return { skipDequeue: skipForBackpressure };
        }

        const resources = await this.resourceMonitor.getNodeResources();

        return {
          maxResources: {
            cpu: resources.cpuAvailable,
            memory: resources.memoryAvailable,
          },
          skipDequeue:
            skipForBackpressure ||
            resources.cpuAvailable < 0.25 ||
            resources.memoryAvailable < 0.25,
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
      this.logger.verbose("runNotification", { time, run });

      this.workloadServer.notifyRun({ run });
    });

    this.workerSession.on(
      "runQueueMessage",
      async ({ time, message, dequeueResponseMs, pollingIntervalMs }) => {
        this.logger.verbose(`Received message with timestamp ${time.toLocaleString()}`, message);

        const traceparent = extractTraceparent(message.run.traceContext);

        await runWideEvent(
          {
            ...this.wideEventOpts,
            op: "dequeue",
            kind: "inbound",
            traceparent,
            setup: (state) => {
              setMeta(state, "run_id", message.run.friendlyId);
              setMeta(state, "env_id", message.environment.id);
              setMeta(state, "org_id", message.organization.id);
              setMeta(state, "project_id", message.project.id);
              if (message.deployment.friendlyId) {
                setMeta(state, "deployment_id", message.deployment.friendlyId);
              }
              setMeta(state, "machine_preset", message.run.machine.name);
              state.extras.iteration = "dequeue";
              state.extras.dequeue_response_ms = dequeueResponseMs;
              state.extras.polling_interval_ms = pollingIntervalMs;
              state.extras.completed_waitpoints = message.completedWaitpoints.length;
            },
          },
          async () => {
            if (message.completedWaitpoints.length > 0) {
              this.logger.debug("Run has completed waitpoints", {
                runId: message.run.id,
                completedWaitpoints: message.completedWaitpoints.length,
              });
            }

            if (!message.image) {
              setExtra(fromContext(), "path_taken", "skipped_no_image");
              this.logger.error("Run has no image", { runId: message.run.id });
              return;
            }

            const { checkpoint, ...rest } = message;

            // Register trace context early so snapshot spans work for all paths
            // (cold create, restore, warm start). Re-registration on restore is safe
            // since dequeue always provides fresh context.
            if (this.computeManager?.traceSpansEnabled && traceparent) {
              this.workloadServer.registerRunTraceContext(message.run.friendlyId, {
                traceparent,
                envId: message.environment.id,
                orgId: message.organization.id,
                projectId: message.project.id,
              });
            }

            if (checkpoint) {
              setExtra(fromContext(), "path_taken", "restore");
              this.logger.debug("Restoring run", { runId: message.run.id });

              if (this.computeManager) {
                const restoreStart = performance.now();
                try {
                  const runnerId = getRestoreRunnerId(message.run.friendlyId, checkpoint.id);

                  const didRestore = await this.computeManager.restore({
                    snapshotId: checkpoint.location,
                    runnerId,
                    runFriendlyId: message.run.friendlyId,
                    snapshotFriendlyId: message.snapshot.friendlyId,
                    machine: message.run.machine,
                    traceContext: message.run.traceContext,
                    envId: message.environment.id,
                    orgId: message.organization.id,
                    projectId: message.project.id,
                    dequeuedAt: message.dequeuedAt,
                  });
                  recordPhaseSince("restore", restoreStart, undefined);
                  setExtra(fromContext(), "did_restore", didRestore);

                  if (didRestore) {
                    this.logger.debug("Compute restore successful", {
                      runId: message.run.id,
                      runnerId,
                    });
                  } else {
                    this.logger.error("Compute restore failed", {
                      runId: message.run.id,
                      runnerId,
                    });
                  }
                } catch (error) {
                  recordPhaseSince(
                    "restore",
                    restoreStart,
                    error instanceof Error ? error : new Error(String(error))
                  );
                  this.logger.error("Failed to restore run (compute)", { error });
                }

                return;
              }

              if (!this.checkpointClient) {
                this.logger.error("No checkpoint client", { runId: message.run.id });
                return;
              }

              const restoreStart = performance.now();
              try {
                const didRestore = await this.checkpointClient.restoreRun({
                  runFriendlyId: message.run.friendlyId,
                  snapshotFriendlyId: message.snapshot.friendlyId,
                  body: {
                    ...rest,
                    checkpoint,
                  },
                });
                recordPhaseSince("restore", restoreStart, undefined);
                setExtra(fromContext(), "did_restore", didRestore);

                if (didRestore) {
                  this.logger.debug("Restore successful", { runId: message.run.id });
                } else {
                  this.logger.error("Restore failed", { runId: message.run.id });
                }
              } catch (error) {
                recordPhaseSince(
                  "restore",
                  restoreStart,
                  error instanceof Error ? error : new Error(String(error))
                );
                this.logger.error("Failed to restore run", { error });
              }

              return;
            }

            this.logger.debug("Scheduling run", { runId: message.run.id });

            const warmStartStart = performance.now();
            const didWarmStart = await this.tryWarmStart(message, traceparent);
            const warmStartCheckMs = Math.round(performance.now() - warmStartStart);
            recordPhaseSince("warm_start", warmStartStart, undefined);
            setExtra(fromContext(), "did_warm_start", didWarmStart);

            if (didWarmStart) {
              setExtra(fromContext(), "path_taken", "warm_start");
              this.logger.debug("Warm start successful", { runId: message.run.id });
              return;
            }

            setExtra(fromContext(), "path_taken", "cold_create");

            const createStart = performance.now();
            try {
              if (!message.deployment.friendlyId) {
                // mostly a type guard, deployments always exists for deployed environments
                // a proper fix would be to use a discriminated union schema to differentiate between dequeued runs in dev and in deployed environments.
                throw new Error("Deployment is missing");
              }

              await this.workloadManager.create({
                dequeuedAt: message.dequeuedAt,
                dequeueResponseMs,
                pollingIntervalMs,
                warmStartCheckMs,
                envId: message.environment.id,
                envType: message.environment.type,
                image: message.image,
                machine: message.run.machine,
                orgId: message.organization.id,
                projectId: message.project.id,
                deploymentFriendlyId: message.deployment.friendlyId,
                deploymentVersion: message.backgroundWorker.version,
                runId: message.run.id,
                runFriendlyId: message.run.friendlyId,
                version: message.version,
                nextAttemptNumber: message.run.attemptNumber,
                snapshotId: message.snapshot.id,
                snapshotFriendlyId: message.snapshot.friendlyId,
                placementTags: message.placementTags,
                traceContext: message.run.traceContext,
                annotations: message.run.annotations,
                hasPrivateLink: message.organization.hasPrivateLink,
              });
              recordPhaseSince("workload_create", createStart, undefined);

              // Disabled for now
              // this.resourceMonitor.blockResources({
              //   cpu: message.run.machine.cpu,
              //   memory: message.run.machine.memory,
              // });
            } catch (error) {
              recordPhaseSince(
                "workload_create",
                createStart,
                error instanceof Error ? error : new Error(String(error))
              );
              this.logger.error("Failed to create workload", { error });
            }
          }
        );
      }
    );

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
      computeManager: this.computeManager,
      tracing: this.tracing,
      wideEventOpts: this.wideEventOpts,
      wideEventsNoisyRoutes: this.wideEventsNoisyRoutes,
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

  private async tryWarmStart(
    dequeuedMessage: DequeuedMessage,
    traceparent: string | undefined
  ): Promise<boolean> {
    if (!this.warmStartUrl) {
      return false;
    }

    const warmStartUrlWithPath = new URL("/warm-start", this.warmStartUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Propagate the inbound W3C traceparent so the upstream warm-start
    // receiver continues the same trace instead of minting a new one. Gated
    // by the same kill switch as the wide-event emission so the whole PR is
    // a no-op on the wire when disabled.
    if (this.wideEventOpts.enabled && traceparent) {
      headers.traceparent = traceparent;
    }

    try {
      const res = await fetch(warmStartUrlWithPath.href, {
        method: "POST",
        headers,
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
    this.backpressureMonitor?.start();
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
    await this.workloadServer.stop();
    await this.workerSession.stop();

    // Optional services
    this.backpressureMonitor?.stop();
    await this.backpressureRedis?.quit();
    await this.podCleaner?.stop();
    await this.failedPodHandler?.stop();
    await this.metricsServer?.stop();
  }
}

const worker = new ManagedSupervisor();
worker.start();
