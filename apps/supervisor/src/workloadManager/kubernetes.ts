import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { RunnerId } from "@trigger.dev/core/v3/isomorphic";
import type { EnvironmentType, MachinePreset } from "@trigger.dev/core/v3";
import { env } from "../env.js";
import { type K8sApi, createK8sApi, type k8s } from "../clients/kubernetes.js";

const POD_EPHEMERAL_STORAGE_SIZE_LIMIT = process.env.POD_EPHEMERAL_STORAGE_SIZE_LIMIT || "10Gi";
const POD_EPHEMERAL_STORAGE_SIZE_REQUEST = process.env.POD_EPHEMERAL_STORAGE_SIZE_REQUEST || "2Gi";

type ResourceQuantities = {
  [K in "cpu" | "memory" | "ephemeral-storage"]?: string;
};

export class KubernetesWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("kubernetes-workload-provider");
  private k8s: K8sApi;
  private namespace = "default";

  constructor(private opts: WorkloadManagerOptions) {
    this.k8s = createK8sApi();

    if (opts.workloadApiDomain) {
      this.logger.warn("[KubernetesWorkloadManager] ⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }
  }

  async create(opts: WorkloadManagerCreateOptions) {
    this.logger.log("[KubernetesWorkloadManager] Creating container", { opts });

    const runnerId = RunnerId.generate().replace(/_/g, "-");

    try {
      await this.k8s.core.createNamespacedPod({
        namespace: this.namespace,
        body: {
          metadata: {
            name: runnerId,
            namespace: this.namespace,
            labels: {
              ...this.#getSharedLabels(opts),
              app: "task-run",
              "app.kubernetes.io/part-of": "trigger-worker",
              "app.kubernetes.io/component": "create",
            },
          },
          spec: {
            ...this.#defaultPodSpec,
            terminationGracePeriodSeconds: 60 * 60,
            containers: [
              {
                name: "run-controller",
                image: opts.image,
                ports: [
                  {
                    containerPort: 8000,
                  },
                ],
                resources: this.#getResourcesForMachine(opts.machine),
                env: [
                  {
                    name: "TRIGGER_RUN_ID",
                    value: opts.runFriendlyId,
                  },
                  {
                    name: "TRIGGER_ENV_ID",
                    value: opts.envId,
                  },
                  {
                    name: "TRIGGER_SNAPSHOT_ID",
                    value: opts.snapshotFriendlyId,
                  },
                  {
                    name: "TRIGGER_SUPERVISOR_API_PROTOCOL",
                    value: this.opts.workloadApiProtocol,
                  },
                  {
                    name: "TRIGGER_SUPERVISOR_API_PORT",
                    value: `${this.opts.workloadApiPort}`,
                  },
                  {
                    name: "TRIGGER_SUPERVISOR_API_DOMAIN",
                    ...(this.opts.workloadApiDomain
                      ? {
                          value: this.opts.workloadApiDomain,
                        }
                      : {
                          valueFrom: {
                            fieldRef: {
                              fieldPath: "status.hostIP",
                            },
                          },
                        }),
                  },
                  {
                    name: "TRIGGER_WORKER_INSTANCE_NAME",
                    value: env.TRIGGER_WORKER_INSTANCE_NAME,
                  },
                  {
                    name: "OTEL_EXPORTER_OTLP_ENDPOINT",
                    value: env.OTEL_EXPORTER_OTLP_ENDPOINT,
                  },
                  {
                    name: "TRIGGER_RUNNER_ID",
                    value: runnerId,
                  },
                  {
                    name: "TRIGGER_MACHINE_CPU",
                    value: `${opts.machine.cpu}`,
                  },
                  {
                    name: "TRIGGER_MACHINE_MEMORY",
                    value: `${opts.machine.memory}`,
                  },
                  {
                    name: "LIMITS_CPU",
                    valueFrom: {
                      resourceFieldRef: {
                        resource: "limits.cpu",
                      },
                    },
                  },
                  {
                    name: "LIMITS_MEMORY",
                    valueFrom: {
                      resourceFieldRef: {
                        resource: "limits.memory",
                      },
                    },
                  },
                  ...(this.opts.warmStartUrl
                    ? [{ name: "TRIGGER_WARM_START_URL", value: this.opts.warmStartUrl }]
                    : []),
                ],
              },
            ],
          },
        },
      });
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
      this.logger.error("[KubernetesWorkloadManager] Create failed", { rawError: err.body });
      this.#throwUnlessRecord(err.body);

      if (typeof err.body.message === "string") {
        throw new Error(err.body?.message);
      } else {
        throw err.body;
      }
    } else {
      this.logger.error("[KubernetesWorkloadManager] Create failed", { rawError: err });
      throw err;
    }
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
        nodetype: "worker-re2",
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

  #getSharedLabels(opts: WorkloadManagerCreateOptions): Record<string, string> {
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
}
