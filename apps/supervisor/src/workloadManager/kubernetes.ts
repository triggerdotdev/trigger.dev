import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import type { EnvironmentType, MachinePreset, PlacementTag } from "@trigger.dev/core/v3";
import { PlacementTagProcessor } from "@trigger.dev/core/v3/serverOnly";
import { env } from "../env.js";
import { type K8sApi, createK8sApi, type k8s } from "../clients/kubernetes.js";
import { getRunnerId } from "../util.js";

type ResourceQuantities = {
  [K in "cpu" | "memory" | "ephemeral-storage"]?: string;
};

export class KubernetesWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("kubernetes-workload-provider");
  private k8s: K8sApi;
  private namespace = env.KUBERNETES_NAMESPACE;
  private placementTagProcessor: PlacementTagProcessor;

  // Resource settings
  private readonly cpuRequestMinCores = env.KUBERNETES_CPU_REQUEST_MIN_CORES;
  private readonly cpuRequestRatio = env.KUBERNETES_CPU_REQUEST_RATIO;
  private readonly memoryRequestMinGb = env.KUBERNETES_MEMORY_REQUEST_MIN_GB;
  private readonly memoryRequestRatio = env.KUBERNETES_MEMORY_REQUEST_RATIO;
  private readonly memoryOverheadGb = env.KUBERNETES_MEMORY_OVERHEAD_GB;

  constructor(private opts: WorkloadManagerOptions) {
    this.k8s = createK8sApi();
    this.placementTagProcessor = new PlacementTagProcessor({
      enabled: env.PLACEMENT_TAGS_ENABLED,
      prefix: env.PLACEMENT_TAGS_PREFIX,
    });

    if (opts.workloadApiDomain) {
      this.logger.warn("[KubernetesWorkloadManager] ⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }
  }

  private addPlacementTags(
    podSpec: Omit<k8s.V1PodSpec, "containers">,
    placementTags?: PlacementTag[]
  ): Omit<k8s.V1PodSpec, "containers"> {
    const nodeSelector = this.placementTagProcessor.convertToNodeSelector(
      placementTags,
      podSpec.nodeSelector
    );

    return {
      ...podSpec,
      nodeSelector,
    };
  }

  private stripImageDigest(imageRef: string): string {
    if (!env.KUBERNETES_STRIP_IMAGE_DIGEST) {
      return imageRef;
    }

    const atIndex = imageRef.lastIndexOf("@");

    if (atIndex === -1) {
      return imageRef;
    }

    return imageRef.substring(0, atIndex);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  async create(opts: WorkloadManagerCreateOptions) {
    this.logger.log("[KubernetesWorkloadManager] Creating container", { opts });

    const runnerId = getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber);

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
            ...this.addPlacementTags(this.#defaultPodSpec, opts.placementTags),
            terminationGracePeriodSeconds: 60 * 60,
            containers: [
              {
                name: "run-controller",
                image: this.stripImageDigest(opts.image),
                ports: [
                  {
                    containerPort: 8000,
                  },
                ],
                resources: this.#getResourcesForMachine(opts.machine),
                env: [
                  {
                    name: "TRIGGER_DEQUEUED_AT_MS",
                    value: opts.dequeuedAt.getTime().toString(),
                  },
                  {
                    name: "TRIGGER_POD_SCHEDULED_AT_MS",
                    value: Date.now().toString(),
                  },
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
                    valueFrom: {
                      fieldRef: {
                        fieldPath: "spec.nodeName",
                      },
                    },
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
                  ...(this.opts.metadataUrl
                    ? [{ name: "TRIGGER_METADATA_URL", value: this.opts.metadataUrl }]
                    : []),
                  ...(this.opts.heartbeatIntervalSeconds
                    ? [
                        {
                          name: "TRIGGER_HEARTBEAT_INTERVAL_SECONDS",
                          value: `${this.opts.heartbeatIntervalSeconds}`,
                        },
                      ]
                    : []),
                  ...(this.opts.snapshotPollIntervalSeconds
                    ? [
                        {
                          name: "TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS",
                          value: `${this.opts.snapshotPollIntervalSeconds}`,
                        },
                      ]
                    : []),
                  ...(this.opts.additionalEnvVars
                    ? Object.entries(this.opts.additionalEnvVars).map(([key, value]) => ({
                        name: key,
                        value: value,
                      }))
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

  private getImagePullSecrets(): k8s.V1LocalObjectReference[] | undefined {
    return this.opts.imagePullSecrets?.map((name) => ({ name }));
  }

  get #defaultPodSpec(): Omit<k8s.V1PodSpec, "containers"> {
    return {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      imagePullSecrets: this.getImagePullSecrets(),
      ...(env.KUBERNETES_SCHEDULER_NAME
        ? {
            schedulerName: env.KUBERNETES_SCHEDULER_NAME,
          }
        : {}),
      ...(env.KUBERNETES_WORKER_NODETYPE_LABEL
        ? {
            nodeSelector: {
              nodetype: env.KUBERNETES_WORKER_NODETYPE_LABEL,
            },
          }
        : {}),
    };
  }

  get #defaultResourceRequests(): ResourceQuantities {
    return {
      "ephemeral-storage": env.KUBERNETES_EPHEMERAL_STORAGE_SIZE_REQUEST,
    };
  }

  get #defaultResourceLimits(): ResourceQuantities {
    return {
      "ephemeral-storage": env.KUBERNETES_EPHEMERAL_STORAGE_SIZE_LIMIT,
    };
  }

  #getSharedLabels(opts: WorkloadManagerCreateOptions): Record<string, string> {
    return {
      env: opts.envId,
      envtype: this.#envTypeToLabelValue(opts.envType),
      org: opts.orgId,
      project: opts.projectId,
      machine: opts.machine.name,
    };
  }

  #getResourceRequestsForMachine(preset: MachinePreset): ResourceQuantities {
    const cpuRequest = preset.cpu * this.cpuRequestRatio;
    const memoryRequest = preset.memory * this.memoryRequestRatio;

    // Clamp between min and max
    const clampedCpu = this.clamp(cpuRequest, this.cpuRequestMinCores, preset.cpu);
    const clampedMemory = this.clamp(memoryRequest, this.memoryRequestMinGb, preset.memory);

    return {
      cpu: `${clampedCpu}`,
      memory: `${clampedMemory}G`,
    };
  }

  #getResourceLimitsForMachine(preset: MachinePreset): ResourceQuantities {
    const memoryLimit = this.memoryOverheadGb
      ? preset.memory + this.memoryOverheadGb
      : preset.memory;

    return {
      cpu: `${preset.cpu}`,
      memory: `${memoryLimit}G`,
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
