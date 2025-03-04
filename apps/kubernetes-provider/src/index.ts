import * as k8s from "@kubernetes/client-node";
import {
  EnvironmentType,
  MachinePreset,
  PostStartCauses,
  PreStopCauses,
} from "@trigger.dev/core/v3";
import {
  ProviderShell,
  SimpleLogger,
  TaskOperations,
  TaskOperationsCreateOptions,
  TaskOperationsIndexOptions,
  TaskOperationsPrePullDeploymentOptions,
  TaskOperationsRestoreOptions,
} from "@trigger.dev/core/v3/apps";
import { PodCleaner } from "./podCleaner";
import { TaskMonitor } from "./taskMonitor";
import { UptimeHeartbeat } from "./uptimeHeartbeat";
import { assertExhaustive } from "@trigger.dev/core";
import { CustomLabelHelper } from "./labelHelper";

const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";
const NODE_NAME = process.env.NODE_NAME || "local";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318";
const COORDINATOR_HOST = process.env.COORDINATOR_HOST ?? undefined;
const COORDINATOR_PORT = process.env.COORDINATOR_PORT ?? undefined;
const KUBERNETES_NAMESPACE = process.env.KUBERNETES_NAMESPACE ?? "default";

const POD_CLEANER_INTERVAL_SECONDS = Number(process.env.POD_CLEANER_INTERVAL_SECONDS || "300");

const UPTIME_HEARTBEAT_URL = process.env.UPTIME_HEARTBEAT_URL;
const UPTIME_INTERVAL_SECONDS = Number(process.env.UPTIME_INTERVAL_SECONDS || "60");
const UPTIME_MAX_PENDING_RUNS = Number(process.env.UPTIME_MAX_PENDING_RUNS || "25");
const UPTIME_MAX_PENDING_INDECES = Number(process.env.UPTIME_MAX_PENDING_INDECES || "10");
const UPTIME_MAX_PENDING_ERRORS = Number(process.env.UPTIME_MAX_PENDING_ERRORS || "10");

const POD_EPHEMERAL_STORAGE_SIZE_LIMIT = process.env.POD_EPHEMERAL_STORAGE_SIZE_LIMIT || "10Gi";
const POD_EPHEMERAL_STORAGE_SIZE_REQUEST = process.env.POD_EPHEMERAL_STORAGE_SIZE_REQUEST || "2Gi";

// Image config
const PRE_PULL_DISABLED = process.env.PRE_PULL_DISABLED === "true";
const ADDITIONAL_PULL_SECRETS = process.env.ADDITIONAL_PULL_SECRETS;
const PAUSE_IMAGE = process.env.PAUSE_IMAGE || "registry.k8s.io/pause:3.9";
const BUSYBOX_IMAGE = process.env.BUSYBOX_IMAGE || "registry.digitalocean.com/trigger/busybox";
const DEPLOYMENT_IMAGE_PREFIX = process.env.DEPLOYMENT_IMAGE_PREFIX;
const RESTORE_IMAGE_PREFIX = process.env.RESTORE_IMAGE_PREFIX;
const UTILITY_IMAGE_PREFIX = process.env.UTILITY_IMAGE_PREFIX;

const logger = new SimpleLogger(`[${NODE_NAME}]`);
logger.log(`running in ${RUNTIME_ENV} mode`);

type Namespace = {
  metadata: {
    name: string;
  };
};

type ResourceQuantities = {
  [K in "cpu" | "memory" | "ephemeral-storage"]?: string;
};

class KubernetesTaskOperations implements TaskOperations {
  #namespace: Namespace = {
    metadata: {
      name: "default",
    },
  };

  #k8sApi: {
    core: k8s.CoreV1Api;
    batch: k8s.BatchV1Api;
    apps: k8s.AppsV1Api;
  };

  #labelHelper = new CustomLabelHelper();

  constructor(opts: { namespace?: string } = {}) {
    if (opts.namespace) {
      this.#namespace.metadata.name = opts.namespace;
    }

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
                  image: getImageRef("deployment", opts.imageRef),
                  ports: [
                    {
                      containerPort: 8000,
                    },
                  ],
                  resources: {
                    limits: {
                      cpu: "1",
                      memory: "2G",
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
    const containerName = this.#getRunContainerName(opts.runId, opts.nextAttemptNumber);

    await this.#createPod(
      {
        metadata: {
          name: containerName,
          namespace: this.#namespace.metadata.name,
          labels: {
            ...this.#labelHelper.getAdditionalLabels("create"),
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
              name: containerName,
              image: getImageRef("deployment", opts.image),
              ports: [
                {
                  containerPort: 8000,
                },
              ],
              resources: this.#getResourcesForMachine(opts.machine),
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
                ...(opts.dequeuedAt
                  ? [{ name: "TRIGGER_RUN_DEQUEUED_AT_MS", value: String(opts.dequeuedAt) }]
                  : []),
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
            ...this.#labelHelper.getAdditionalLabels("restore"),
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
              image: getImageRef("deployment", opts.imageRef),
              command: ["sleep", "0"],
            },
            {
              name: "populate-taskinfo",
              image: getImageRef("utility", BUSYBOX_IMAGE),
              imagePullPolicy: "IfNotPresent",
              command: ["/bin/sh", "-c"],
              args: ["printenv COORDINATOR_HOST | tee /etc/taskinfo/coordinator-host"],
              env: this.#coordinatorEnvVars,
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
              image: getImageRef("restore", opts.checkpointRef),
              ports: [
                {
                  containerPort: 8000,
                },
              ],
              resources: this.#getResourcesForMachine(opts.machine),
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
    if (PRE_PULL_DISABLED) {
      logger.debug("Pre-pull is disabled, skipping.", { opts });
      return;
    }

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
              affinity: {
                nodeAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: {
                    nodeSelectorTerms: [
                      {
                        matchExpressions: [
                          {
                            key: "trigger.dev/pre-pull-disabled",
                            operator: "DoesNotExist",
                          },
                        ],
                      },
                    ],
                  },
                },
              },
              initContainers: [
                {
                  name: "prepull",
                  image: getImageRef("deployment", opts.imageRef),
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
                  image: getImageRef("utility", PAUSE_IMAGE),
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
    const pullSecrets = ["registry-trigger", "registry-trigger-failover"];

    if (ADDITIONAL_PULL_SECRETS) {
      pullSecrets.push(...ADDITIONAL_PULL_SECRETS.split(","));
    }

    const imagePullSecrets = pullSecrets.map(
      (name) => ({ name }) satisfies k8s.V1LocalObjectReference
    );

    return {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      imagePullSecrets,
      nodeSelector: {
        nodetype: "worker",
      },
    };
  }

  get #defaultResourceRequests(): ResourceQuantities {
    return {
      "ephemeral-storage": POD_EPHEMERAL_STORAGE_SIZE_REQUEST,
    };
  }

  get #defaultResourceLimits(): ResourceQuantities {
    return {
      "ephemeral-storage": POD_EPHEMERAL_STORAGE_SIZE_LIMIT,
    };
  }

  get #coordinatorHostEnvVar(): k8s.V1EnvVar {
    return COORDINATOR_HOST
      ? {
          name: "COORDINATOR_HOST",
          value: COORDINATOR_HOST,
        }
      : {
          name: "COORDINATOR_HOST",
          valueFrom: {
            fieldRef: {
              fieldPath: "status.hostIP",
            },
          },
        };
  }

  get #coordinatorPortEnvVar(): k8s.V1EnvVar | undefined {
    if (COORDINATOR_PORT) {
      return {
        name: "COORDINATOR_PORT",
        value: COORDINATOR_PORT,
      };
    }
  }

  get #coordinatorEnvVars(): k8s.V1EnvVar[] {
    const envVars = [this.#coordinatorHostEnvVar];

    if (this.#coordinatorPortEnvVar) {
      envVars.push(this.#coordinatorPortEnvVar);
    }

    return envVars;
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
        name: "MACHINE_NAME",
        valueFrom: {
          fieldRef: {
            fieldPath: "spec.nodeName",
          },
        },
      },
      {
        name: "TRIGGER_POD_SCHEDULED_AT_MS",
        value: Date.now().toString(),
      },
      ...this.#coordinatorEnvVars,
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

  #getResourceRequestsForMachine(preset: MachinePreset): ResourceQuantities {
    return {
      cpu: `${preset.cpu * 0.75}`,
      memory: `${preset.memory}G`,
    };
  }

  #getResourceLimitsForMachine(preset: MachinePreset): ResourceQuantities {
    return {
      cpu: `${preset.cpu}`,
      memory: `${preset.memory}G`,
    };
  }

  #getResourcesForMachine(preset: MachinePreset): k8s.V1ResourceRequirements {
    return {
      requests: {
        ...this.#defaultResourceRequests,
        ...this.#getResourceRequestsForMachine(preset),
      },
      limits: {
        ...this.#defaultResourceLimits,
        ...this.#getResourceLimitsForMachine(preset),
      },
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

  #getRunContainerName(suffix: string, attemptNumber?: number) {
    return `task-run-${suffix}${attemptNumber && attemptNumber > 1 ? `-att${attemptNumber}` : ""}`;
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

type ImageType = "deployment" | "restore" | "utility";

function getImagePrefix(type: ImageType) {
  switch (type) {
    case "deployment":
      return DEPLOYMENT_IMAGE_PREFIX;
    case "restore":
      return RESTORE_IMAGE_PREFIX;
    case "utility":
      return UTILITY_IMAGE_PREFIX;
    default:
      assertExhaustive(type);
  }
}

function getImageRef(type: ImageType, ref: string) {
  const prefix = getImagePrefix(type);
  return prefix ? `${prefix}/${ref}` : ref;
}

const provider = new ProviderShell({
  tasks: new KubernetesTaskOperations({
    namespace: KUBERNETES_NAMESPACE,
  }),
  type: "kubernetes",
});

provider.listen();

const taskMonitor = new TaskMonitor({
  runtimeEnv: RUNTIME_ENV,
  namespace: KUBERNETES_NAMESPACE,
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
  namespace: KUBERNETES_NAMESPACE,
  intervalInSeconds: POD_CLEANER_INTERVAL_SECONDS,
});

podCleaner.start();

if (UPTIME_HEARTBEAT_URL) {
  const uptimeHeartbeat = new UptimeHeartbeat({
    runtimeEnv: RUNTIME_ENV,
    namespace: KUBERNETES_NAMESPACE,
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
