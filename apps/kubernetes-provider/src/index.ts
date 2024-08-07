import * as k8s from "@kubernetes/client-node";
import {
  ProviderShell,
  TaskOperations,
  TaskOperationsCreateOptions,
  TaskOperationsIndexOptions,
  TaskOperationsPrePullDeploymentOptions,
  TaskOperationsRestoreOptions,
} from "@trigger.dev/core-apps/provider";
import { SimpleLogger } from "@trigger.dev/core-apps/logger";
import {
  MachinePreset,
  PostStartCauses,
  PreStopCauses,
  EnvironmentType,
} from "@trigger.dev/core/v3";
import { randomUUID } from "crypto";
import { TaskMonitor } from "./taskMonitor";
import { PodCleaner } from "./podCleaner";
import { UptimeHeartbeat } from "./uptimeHeartbeat";

const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";
const NODE_NAME = process.env.NODE_NAME || "local";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318";

const POD_CLEANER_INTERVAL_SECONDS = Number(process.env.POD_CLEANER_INTERVAL_SECONDS || "300");

const UPTIME_HEARTBEAT_URL = process.env.UPTIME_HEARTBEAT_URL;
const UPTIME_INTERVAL_SECONDS = Number(process.env.UPTIME_INTERVAL_SECONDS || "60");
const UPTIME_MAX_PENDING_RUNS = Number(process.env.UPTIME_MAX_PENDING_RUNS || "25");
const UPTIME_MAX_PENDING_INDECES = Number(process.env.UPTIME_MAX_PENDING_INDECES || "10");
const UPTIME_MAX_PENDING_ERRORS = Number(process.env.UPTIME_MAX_PENDING_ERRORS || "10");

const logger = new SimpleLogger(`[${NODE_NAME}]`);
logger.log(`running in ${RUNTIME_ENV} mode`);

type Namespace = {
  metadata: {
    name: string;
  };
};

type ComputeResources = {
  [K in "cpu" | "memory" | "ephemeral-storage"]?: string;
};

class KubernetesTaskOperations implements TaskOperations {
  #namespace: Namespace;
  #k8sApi: {
    core: k8s.CoreV1Api;
    batch: k8s.BatchV1Api;
    apps: k8s.AppsV1Api;
  };

  constructor(namespace = "default") {
    this.#namespace = {
      metadata: {
        name: namespace,
      },
    };

    this.#k8sApi = this.#createK8sApi();
  }

  async init() {
    // noop
  }

  async index(opts: TaskOperationsIndexOptions) {
    await this.#createJob(
      {
        metadata: {
          name: this.#getIndexContainerName(opts.shortCode),
          namespace: this.#namespace.metadata.name,
        },
        spec: {
          completions: 1,
          backoffLimit: 0,
          ttlSecondsAfterFinished: 300,
          template: {
            metadata: {
              labels: {
                ...this.#getSharedLabels(opts),
                app: "task-index",
                "app.kubernetes.io/part-of": "trigger-worker",
                "app.kubernetes.io/component": "index",
                deployment: opts.deploymentId,
              },
            },
            spec: {
              ...this.#defaultPodSpec,
              containers: [
                {
                  name: this.#getIndexContainerName(opts.shortCode),
                  image: opts.imageRef,
                  ports: [
                    {
                      containerPort: 8000,
                    },
                  ],
                  resources: {
                    limits: {
                      cpu: "1",
                      memory: "1G",
                      "ephemeral-storage": "2Gi",
                    },
                  },
                  lifecycle: {
                    preStop: {
                      exec: {
                        command: this.#getLifecycleCommand("preStop", "terminate"),
                      },
                    },
                  },
                  env: [
                    ...this.#getSharedEnv(opts.envId),
                    {
                      name: "INDEX_TASKS",
                      value: "true",
                    },
                    {
                      name: "TRIGGER_SECRET_KEY",
                      value: opts.apiKey,
                    },
                    {
                      name: "TRIGGER_API_URL",
                      value: opts.apiUrl,
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      this.#namespace
    );
  }

  async create(opts: TaskOperationsCreateOptions) {
    await this.#createPod(
      {
        metadata: {
          name: this.#getRunContainerName(opts.runId),
          namespace: this.#namespace.metadata.name,
          labels: {
            ...this.#getSharedLabels(opts),
            app: "task-run",
            "app.kubernetes.io/part-of": "trigger-worker",
            "app.kubernetes.io/component": "create",
            run: opts.runId,
          },
        },
        spec: {
          ...this.#defaultPodSpec,
          terminationGracePeriodSeconds: 60 * 60,
          containers: [
            {
              name: this.#getRunContainerName(opts.runId),
              image: opts.image,
              ports: [
                {
                  containerPort: 8000,
                },
              ],
              resources: {
                requests: {
                  ...this.#defaultResourceRequests,
                },
                limits: {
                  ...this.#defaultResourceLimits,
                  ...this.#getResourcesFromMachineConfig(opts.machine),
                },
              },
              lifecycle: {
                preStop: {
                  exec: {
                    command: this.#getLifecycleCommand("preStop", "terminate"),
                  },
                },
              },
              env: [
                ...this.#getSharedEnv(opts.envId),
                {
                  name: "TRIGGER_RUN_ID",
                  value: opts.runId,
                },
              ],
              volumeMounts: [
                {
                  name: "taskinfo",
                  mountPath: "/etc/taskinfo",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "taskinfo",
              emptyDir: {},
            },
          ],
        },
      },
      this.#namespace
    );
  }

  async restore(opts: TaskOperationsRestoreOptions) {
    await this.#createPod(
      {
        metadata: {
          name: `${this.#getRunContainerName(opts.runId)}-${opts.checkpointId.slice(-8)}`,
          namespace: this.#namespace.metadata.name,
          labels: {
            ...this.#getSharedLabels(opts),
            app: "task-run",
            "app.kubernetes.io/part-of": "trigger-worker",
            "app.kubernetes.io/component": "restore",
            run: opts.runId,
            checkpoint: opts.checkpointId,
          },
        },
        spec: {
          ...this.#defaultPodSpec,
          initContainers: [
            {
              name: "pull-base-image",
              image: opts.imageRef,
              command: ["sleep", "0"],
            },
            {
              name: "populate-taskinfo",
              image: "registry.digitalocean.com/trigger/busybox",
              imagePullPolicy: "IfNotPresent",
              command: ["/bin/sh", "-c"],
              args: ["printenv COORDINATOR_HOST | tee /etc/taskinfo/coordinator-host"],
              env: [
                {
                  name: "COORDINATOR_HOST",
                  valueFrom: {
                    fieldRef: {
                      fieldPath: "status.hostIP",
                    },
                  },
                },
              ],
              volumeMounts: [
                {
                  name: "taskinfo",
                  mountPath: "/etc/taskinfo",
                },
              ],
            },
          ],
          containers: [
            {
              name: this.#getRunContainerName(opts.runId),
              image: opts.checkpointRef,
              ports: [
                {
                  containerPort: 8000,
                },
              ],
              resources: {
                requests: {
                  ...this.#defaultResourceRequests,
                },
                limits: {
                  ...this.#defaultResourceLimits,
                  ...this.#getResourcesFromMachineConfig(opts.machine),
                },
              },
              lifecycle: {
                postStart: {
                  exec: {
                    command: this.#getLifecycleCommand("postStart", "restore"),
                  },
                },
                preStop: {
                  exec: {
                    command: this.#getLifecycleCommand("preStop", "terminate"),
                  },
                },
              },
              volumeMounts: [
                {
                  name: "taskinfo",
                  mountPath: "/etc/taskinfo",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "taskinfo",
              emptyDir: {},
            },
          ],
        },
      },
      this.#namespace
    );
  }

  async delete(opts: { runId: string }) {
    await this.#deletePod({
      runId: opts.runId,
      namespace: this.#namespace,
    });
  }

  async get(opts: { runId: string }) {
    await this.#getPod(opts.runId, this.#namespace);
  }

  async prePullDeployment(opts: TaskOperationsPrePullDeploymentOptions) {
    const metaName = this.#getPrePullContainerName(opts.shortCode);

    const metaLabels = {
      ...this.#getSharedLabels(opts),
      app: "task-prepull",
      "app.kubernetes.io/part-of": "trigger-worker",
      "app.kubernetes.io/component": "prepull",
      deployment: opts.deploymentId,
      name: metaName,
    } satisfies k8s.V1ObjectMeta["labels"];

    await this.#createDaemonSet(
      {
        metadata: {
          name: metaName,
          namespace: this.#namespace.metadata.name,
          labels: metaLabels,
        },
        spec: {
          selector: {
            matchLabels: {
              name: metaName,
            },
          },
          template: {
            metadata: {
              labels: metaLabels,
            },
            spec: {
              ...this.#defaultPodSpec,
              restartPolicy: "Always",
              initContainers: [
                {
                  name: "prepull",
                  image: opts.imageRef,
                  command: ["/usr/bin/true"],
                  resources: {
                    limits: {
                      cpu: "0.25",
                      memory: "100Mi",
                      "ephemeral-storage": "1Gi",
                    },
                  },
                },
              ],
              containers: [
                {
                  name: "pause",
                  image: "registry.k8s.io/pause:3.9",
                  resources: {
                    limits: {
                      cpu: "1m",
                      memory: "12Mi",
                    },
                  },
                },
              ],
            },
          },
        },
      },
      this.#namespace
    );
  }

  #envTypeToLabelValue(type: EnvironmentType) {
    switch (type) {
      case "PRODUCTION":
        return "prod";
      case "STAGING":
        return "stg";
      case "DEVELOPMENT":
        return "dev";
      case "PREVIEW":
        return "preview";
    }
  }

  get #defaultPodSpec(): Omit<k8s.V1PodSpec, "containers"> {
    return {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      imagePullSecrets: [
        {
          name: "registry-trigger",
        },
        {
          name: "registry-trigger-failover",
        },
      ],
      nodeSelector: {
        nodetype: "worker",
      },
    };
  }

  get #defaultResourceRequests(): ComputeResources {
    return {
      "ephemeral-storage": "2Gi",
    };
  }

  get #defaultResourceLimits(): ComputeResources {
    return {
      "ephemeral-storage": "10Gi",
    };
  }

  #getSharedEnv(envId: string): k8s.V1EnvVar[] {
    return [
      {
        name: "TRIGGER_ENV_ID",
        value: envId,
      },
      {
        name: "DEBUG",
        value: process.env.DEBUG ? "1" : "0",
      },
      {
        name: "HTTP_SERVER_PORT",
        value: "8000",
      },
      {
        name: "OTEL_EXPORTER_OTLP_ENDPOINT",
        value: OTEL_EXPORTER_OTLP_ENDPOINT,
      },
      {
        name: "POD_NAME",
        valueFrom: {
          fieldRef: {
            fieldPath: "metadata.name",
          },
        },
      },
      {
        name: "COORDINATOR_HOST",
        valueFrom: {
          fieldRef: {
            fieldPath: "status.hostIP",
          },
        },
      },
      {
        name: "MACHINE_NAME",
        valueFrom: {
          fieldRef: {
            fieldPath: "spec.nodeName",
          },
        },
      },
    ];
  }

  #getSharedLabels(
    opts:
      | TaskOperationsIndexOptions
      | TaskOperationsCreateOptions
      | TaskOperationsRestoreOptions
      | TaskOperationsPrePullDeploymentOptions
  ): Record<string, string> {
    return {
      env: opts.envId,
      envtype: this.#envTypeToLabelValue(opts.envType),
      org: opts.orgId,
      project: opts.projectId,
    };
  }

  #getResourcesFromMachineConfig(preset: MachinePreset): ComputeResources {
    return {
      cpu: `${preset.cpu}`,
      memory: `${preset.memory}G`,
    };
  }

  #getLifecycleCommand<THookType extends "postStart" | "preStop">(
    type: THookType,
    cause: THookType extends "postStart" ? PostStartCauses : PreStopCauses
  ) {
    const retries = 5;

    // This will retry sending the lifecycle hook up to `retries` times
    // The sleep is required as this may start running before the HTTP server is up
    const exec = [
      "/bin/sh",
      "-c",
      `for i in $(seq ${retries}); do sleep 1; busybox wget -q -O- 127.0.0.1:8000/${type}?cause=${cause} && break; done`,
    ];

    logger.debug("getLifecycleCommand()", { exec });

    return exec;
  }

  #getIndexContainerName(suffix: string) {
    return `task-index-${suffix}`;
  }

  #getRunContainerName(suffix: string) {
    return `task-run-${suffix}`;
  }

  #getPrePullContainerName(suffix: string) {
    return `task-prepull-${suffix}`;
  }

  #createK8sApi() {
    const kubeConfig = new k8s.KubeConfig();

    if (RUNTIME_ENV === "local") {
      kubeConfig.loadFromDefault();
    } else if (RUNTIME_ENV === "kubernetes") {
      kubeConfig.loadFromCluster();
    } else {
      throw new Error(`Unsupported runtime environment: ${RUNTIME_ENV}`);
    }

    return {
      core: kubeConfig.makeApiClient(k8s.CoreV1Api),
      batch: kubeConfig.makeApiClient(k8s.BatchV1Api),
      apps: kubeConfig.makeApiClient(k8s.AppsV1Api),
    };
  }

  async #createPod(pod: k8s.V1Pod, namespace: Namespace) {
    try {
      const res = await this.#k8sApi.core.createNamespacedPod(namespace.metadata.name, pod);
      logger.debug(res.body);
    } catch (err: unknown) {
      this.#handleK8sError(err);
    }
  }

  async #deletePod(opts: { runId: string; namespace: Namespace }) {
    try {
      const res = await this.#k8sApi.core.deleteNamespacedPod(
        opts.runId,
        opts.namespace.metadata.name
      );
      logger.debug(res.body);
    } catch (err: unknown) {
      this.#handleK8sError(err);
    }
  }

  async #getPod(runId: string, namespace: Namespace) {
    try {
      const res = await this.#k8sApi.core.readNamespacedPod(runId, namespace.metadata.name);
      logger.debug(res.body);
      return res.body;
    } catch (err: unknown) {
      this.#handleK8sError(err);
    }
  }

  async #createJob(job: k8s.V1Job, namespace: Namespace) {
    try {
      const res = await this.#k8sApi.batch.createNamespacedJob(namespace.metadata.name, job);
      logger.debug(res.body);
    } catch (err: unknown) {
      this.#handleK8sError(err);
    }
  }

  async #createDaemonSet(daemonSet: k8s.V1DaemonSet, namespace: Namespace) {
    try {
      const res = await this.#k8sApi.apps.createNamespacedDaemonSet(
        namespace.metadata.name,
        daemonSet
      );
      logger.debug(res.body);
    } catch (err: unknown) {
      this.#handleK8sError(err);
    }
  }

  #throwUnlessRecord(candidate: unknown): asserts candidate is Record<string, unknown> {
    if (typeof candidate !== "object" || candidate === null) {
      throw candidate;
    }
  }

  #handleK8sError(err: unknown) {
    this.#throwUnlessRecord(err);

    if ("body" in err && err.body) {
      logger.error(err.body);
      this.#throwUnlessRecord(err.body);

      if (typeof err.body.message === "string") {
        throw new Error(err.body?.message);
      } else {
        throw err.body;
      }
    } else {
      logger.error(err);
      throw err;
    }
  }
}

const provider = new ProviderShell({
  tasks: new KubernetesTaskOperations(),
  type: "kubernetes",
});

provider.listen();

const taskMonitor = new TaskMonitor({
  runtimeEnv: RUNTIME_ENV,
  onIndexFailure: async (deploymentId, details) => {
    logger.log("Indexing failed", { deploymentId, details });

    try {
      provider.platformSocket.send("INDEXING_FAILED", {
        deploymentId,
        error: {
          name: `Crashed with exit code ${details.exitCode}`,
          message: details.reason,
          stack: details.logs,
        },
        overrideCompletion: details.overrideCompletion,
      });
    } catch (error) {
      logger.error(error);
    }
  },
  onRunFailure: async (runId, details) => {
    logger.log("Run failed:", { runId, details });

    try {
      provider.platformSocket.send("WORKER_CRASHED", { runId, ...details });
    } catch (error) {
      logger.error(error);
    }
  },
});

taskMonitor.start();

const podCleaner = new PodCleaner({
  runtimeEnv: RUNTIME_ENV,
  namespace: "default",
  intervalInSeconds: POD_CLEANER_INTERVAL_SECONDS,
});

podCleaner.start();

if (UPTIME_HEARTBEAT_URL) {
  const uptimeHeartbeat = new UptimeHeartbeat({
    runtimeEnv: RUNTIME_ENV,
    namespace: "default",
    intervalInSeconds: UPTIME_INTERVAL_SECONDS,
    pingUrl: UPTIME_HEARTBEAT_URL,
    maxPendingRuns: UPTIME_MAX_PENDING_RUNS,
    maxPendingIndeces: UPTIME_MAX_PENDING_INDECES,
    maxPendingErrors: UPTIME_MAX_PENDING_ERRORS,
  });

  uptimeHeartbeat.start();
} else {
  logger.log("Uptime heartbeat is disabled, set UPTIME_HEARTBEAT_URL to enable.");
}
