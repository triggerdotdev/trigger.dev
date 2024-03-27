import * as k8s from "@kubernetes/client-node";
import {
  ProviderShell,
  SimpleLogger,
  TaskOperations,
  TaskOperationsCreateOptions,
  TaskOperationsIndexOptions,
  TaskOperationsRestoreOptions,
} from "@trigger.dev/core-apps";
import { Machine } from "@trigger.dev/core/v3";
import { randomUUID } from "crypto";

const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";
const NODE_NAME = process.env.NODE_NAME || "local";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318";

const logger = new SimpleLogger(`[${NODE_NAME}]`);
logger.log(`running in ${RUNTIME_ENV} mode`);

type Namespace = {
  metadata: {
    name: string;
  };
};

class KubernetesTaskOperations implements TaskOperations {
  #namespace: Namespace;
  #k8sApi: {
    core: k8s.CoreV1Api;
    batch: k8s.BatchV1Api;
  };

  constructor(namespace = "default") {
    this.#namespace = {
      metadata: {
        name: namespace,
      },
    };

    this.#k8sApi = this.#createK8sApi();
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
                app: "task-index",
              },
            },
            spec: {
              restartPolicy: "Never",
              imagePullSecrets: [
                {
                  name: "registry-trigger",
                },
              ],
              containers: [
                {
                  name: this.#getIndexContainerName(opts.shortCode),
                  image: opts.imageRef,
                  ports: [
                    {
                      containerPort: 8000,
                    },
                  ],
                  // resources: {
                  //   limits: {
                  //     cpu: "100m",
                  //     memory: "50Mi",
                  //   },
                  // },
                  env: [
                    {
                      name: "DEBUG",
                      value: "true",
                    },
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
                    {
                      name: "TRIGGER_ENV_ID",
                      value: opts.envId,
                    },
                    {
                      name: "OTEL_EXPORTER_OTLP_ENDPOINT",
                      value: OTEL_EXPORTER_OTLP_ENDPOINT,
                    },
                    {
                      name: "HTTP_SERVER_PORT",
                      value: "8000",
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
            app: "task-run",
          },
        },
        spec: {
          restartPolicy: "Never",
          imagePullSecrets: [
            {
              name: "registry-trigger",
            },
          ],
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
                limits: this.#getResourcesFromMachineConfig(opts.machine),
              },
              lifecycle: {
                postStart: {
                  exec: {
                    command: this.#getLifecycleCommand("postStart", "create"),
                  },
                },
                preStop: {
                  exec: {
                    command: this.#getLifecycleCommand("preStop", "create"),
                  },
                },
              },
              env: [
                {
                  name: "DEBUG",
                  value: "true",
                },
                {
                  name: "HTTP_SERVER_PORT",
                  value: "8000",
                },
                {
                  name: "TRIGGER_ENV_ID",
                  value: opts.envId,
                },
                {
                  name: "TRIGGER_RUN_ID",
                  value: opts.runId,
                },
                {
                  name: "TRIGGER_WORKER_VERSION",
                  value: opts.version,
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
                  name: "NODE_NAME",
                  valueFrom: {
                    fieldRef: {
                      fieldPath: "spec.nodeName",
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
          name: `${this.#getRunContainerName(opts.runId)}-${randomUUID().slice(0, 8)}`,
          namespace: this.#namespace.metadata.name,
          labels: {
            app: "task-run",
          },
        },
        spec: {
          restartPolicy: "Never",
          imagePullSecrets: [
            {
              name: "registry-trigger",
            },
          ],
          initContainers: [
            {
              name: "pull-base-image",
              image: opts.imageRef,
              command: ["sleep", "0"],
            },
            {
              name: "populate-taskinfo",
              image: "busybox",
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
                limits: this.#getResourcesFromMachineConfig(opts.machine),
              },
              lifecycle: {
                postStart: {
                  exec: {
                    command: this.#getLifecycleCommand("postStart", "restore"),
                  },
                },
                preStop: {
                  exec: {
                    command: this.#getLifecycleCommand("preStop", "restore"),
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

  #getResourcesFromMachineConfig(config: Machine) {
    return {
      cpu: `${config.cpu}`,
      memory: `${config.memory}G`,
    };
  }

  #getLifecycleCommand(type: "postStart" | "preStop", cause: "index" | "create" | "restore") {
    return ["/bin/sh", "-c", `sleep 1; wget -q -O- 127.0.0.1:8000/${type}?cause=${cause}`];
  }

  #getIndexContainerName(suffix: string) {
    return `task-index-${suffix}`;
  }

  #getRunContainerName(suffix: string) {
    return `task-run-${suffix}`;
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
