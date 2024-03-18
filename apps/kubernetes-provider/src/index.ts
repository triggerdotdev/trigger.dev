import * as k8s from "@kubernetes/client-node";
import {
  ProviderShell,
  SimpleLogger,
  TaskOperations,
  TaskOperationsCreateOptions,
  TaskOperationsIndexOptions,
  TaskOperationsRestoreOptions,
} from "@trigger.dev/core-apps";

const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";
const NODE_NAME = process.env.NODE_NAME || "some-node";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318";

const logger = new SimpleLogger(`[${NODE_NAME}]`);

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
          name: this.#getIndexContainerName(opts.contentHash),
          namespace: this.#namespace.metadata.name,
        },
        spec: {
          completions: 1,
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
                  name: opts.contentHash,
                  image: opts.imageRef,
                  ports: [
                    {
                      containerPort: 8000,
                    },
                  ],
                  resources: {
                    limits: {
                      cpu: "100m",
                      memory: "50Mi",
                    },
                  },
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
          name: this.#getRunContainerName(opts.attemptId),
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
              name: opts.attemptId,
              image: opts.image,
              ports: [
                {
                  containerPort: 8000,
                },
              ],
              // resources: {
              //   limits: opts.machine,
              // },
              env: [
                {
                  name: "DEBUG",
                  value: "true",
                },
                {
                  name: "TRIGGER_ENV_ID",
                  value: opts.envId,
                },
                {
                  name: "TRIGGER_ATTEMPT_ID",
                  value: opts.attemptId,
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
          name: this.#getRunContainerName(opts.attemptId),
          namespace: this.#namespace.metadata.name,
        },
        spec: {
          imagePullSecrets: [
            {
              name: "regcred",
            },
          ],
          initContainers: [
            {
              name: "pull-base-image",
              image: opts.imageRef,
              command: ["sleep", "0"],
            },
          ],
          containers: [
            {
              name: opts.runId,
              image: opts.checkpointRef,
              ports: [
                {
                  containerPort: 8000,
                },
              ],
              // resources: {
              //   limits: opts.machine,
              // },
              lifecycle: {
                postStart: {
                  httpGet: {
                    path: "/connect",
                    port: 8000,
                  },
                },
              },
              // TODO: check we definitely don't need to specify these again
              // env: [
              //   {
              //     name: "DEBUG",
              //     value: "true",
              //   },
              //   {
              //     name: "POD_NAME",
              //     valueFrom: {
              //       fieldRef: {
              //         fieldPath: "metadata.name",
              //       },
              //     },
              //   },
              //   {
              //     name: "COORDINATOR_HOST",
              //     valueFrom: {
              //       fieldRef: {
              //         fieldPath: "status.hostIP",
              //       },
              //     },
              //   },
              //   {
              //     name: "NODE_NAME",
              //     valueFrom: {
              //       fieldRef: {
              //         fieldPath: "spec.nodeName",
              //       },
              //     },
              //   },
              // ],
            },
          ],
        },
      },
      this.#namespace
    );
  }

  async delete(opts: { runId: string }) {
    await this.#deletePod({
      podName: opts.runId,
      namespace: this.#namespace,
    });
  }

  async get(opts: { runId: string }) {
    await this.#getPod(opts.runId, this.#namespace);
  }

  #getIndexContainerName(contentHash: string) {
    return `task-index-${contentHash}`;
  }

  #getRunContainerName(attemptId: string) {
    return `task-run-${attemptId}`;
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
    } catch (err: any) {
      if ("body" in err) {
        logger.error(err.body);
      } else {
        logger.error(err);
      }
    }
  }

  async #deletePod(opts: { podName: string; namespace: Namespace }) {
    try {
      const res = await this.#k8sApi.core.deleteNamespacedPod(
        opts.podName,
        opts.namespace.metadata.name
      );
      logger.debug(res.body);
    } catch (err: any) {
      if ("body" in err) {
        logger.error(err.body);
      } else {
        logger.error(err);
      }
    }
  }

  async #getPod(podName: string, namespace: Namespace) {
    try {
      const res = await this.#k8sApi.core.readNamespacedPod(podName, namespace.metadata.name);
      logger.debug(res.body);
      return res.body;
    } catch (err: any) {
      if ("body" in err) {
        logger.error(err.body);
      } else {
        logger.error(err);
      }
    }
  }

  async #createJob(job: k8s.V1Job, namespace: Namespace) {
    try {
      const res = await this.#k8sApi.batch.createNamespacedJob(namespace.metadata.name, job);
      logger.debug(res.body);
    } catch (err: any) {
      if ("body" in err) {
        logger.error(err.body);
      } else {
        logger.error(err);
      }
    }
  }
}

const provider = new ProviderShell({
  tasks: new KubernetesTaskOperations(),
  type: "kubernetes",
});

provider.listen();
