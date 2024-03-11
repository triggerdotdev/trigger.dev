import { randomUUID } from "node:crypto";
import k8s, { BatchV1Api, CoreV1Api, V1Job, V1Pod } from "@kubernetes/client-node";
import { Machine } from "@trigger.dev/core/v3";
import { ProviderShell, SimpleLogger, TaskOperations } from "@trigger.dev/core-apps";

const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";
const NODE_NAME = process.env.NODE_NAME || "some-node";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318";

const REGISTRY_FQDN = process.env.REGISTRY_FQDN || "localhost:5000";
const REPO_NAME = process.env.REPO_NAME || "test";

const logger = new SimpleLogger(`[${NODE_NAME}]`);

type Namespace = {
  metadata: {
    name: string;
  };
};

class KubernetesTaskOperations implements TaskOperations {
  #namespace: Namespace;
  #k8sApi: {
    core: CoreV1Api;
    batch: BatchV1Api;
  };

  constructor(namespace = "default") {
    this.#namespace = {
      metadata: {
        name: namespace,
      },
    };

    this.#k8sApi = this.#createK8sApi();
  }

  async index(opts: { contentHash: string; imageTag: string; envId: string }) {
    await this.#createJob(
      {
        metadata: {
          name: `task-index-${opts.contentHash}`,
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
                  image: opts.imageTag,
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

  async create(opts: { attemptId: string; image: string; machine: Machine; envId: string }) {
    await this.#createPod(
      {
        metadata: {
          name: `task-run-${opts.attemptId}-${randomUUID().slice(0, 5)}`,
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

  async restore(opts: {
    attemptId: string;
    runId: string;
    image: string;
    name: string;
    checkpointId: string;
    machine: Machine;
  }) {
    await this.#createPod(
      {
        metadata: {
          name: opts.name,
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
              image: this.#getRestoreImage(opts.runId, opts.checkpointId),
              command: ["sleep", "0"],
            },
          ],
          containers: [
            {
              name: opts.runId,
              image: this.#getImageFromRunId(opts.runId),
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
              env: [
                {
                  name: "DEBUG",
                  value: "true",
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

  async delete(opts: { runId: string }) {
    await this.#deletePod({
      podName: opts.runId,
      namespace: this.#namespace,
    });
  }

  async get(opts: { runId: string }) {
    await this.#getPod(opts.runId, this.#namespace);
  }

  #getImageFromRunId(runId: string) {
    return `${REGISTRY_FQDN}/${REPO_NAME}:${runId}`;
  }

  #getRestoreImage(runId: string, checkpointId: string) {
    return `${REGISTRY_FQDN}/${REPO_NAME}:${checkpointId}`;
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

  async #createPod(pod: V1Pod, namespace: Namespace) {
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

  async #createJob(job: V1Job, namespace: Namespace) {
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
