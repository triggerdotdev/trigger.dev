import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import k8s, { BatchV1Api, CoreV1Api, V1Job, V1Pod } from "@kubernetes/client-node";
import { io, Socket } from "socket.io-client";
import {
  Machine,
  ProviderClientToServerEvents,
  ProviderServerToClientEvents,
} from "@trigger.dev/core/v3";
import { HttpReply, SimpleLogger, getTextBody } from "@trigger.dev/core-apps";

const RUNTIME_ENV = process.env.KUBERNETES_PORT ? "kubernetes" : "local";

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8000);
const NODE_NAME = process.env.NODE_NAME || "some-node";
const POD_NAME = process.env.POD_NAME || "k8s-provider";

const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 5080;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "provider-secret";

const REGISTRY_FQDN = process.env.REGISTRY_FQDN || "localhost:5000";
const REPO_NAME = process.env.REPO_NAME || "test";

const logger = new SimpleLogger(`[${NODE_NAME}]`);

type Namespace = {
  metadata: {
    name: string;
  };
};

interface TaskOperations {
  create: (...args: any[]) => Promise<any>;
  restore: (...args: any[]) => Promise<any>;
  delete: (...args: any[]) => Promise<any>;
  get: (...args: any[]) => Promise<any>;
  index: (...args: any[]) => Promise<any>;
}

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

  async index(opts: { contentHash: string; imageTag: string }) {
    await this.#createJob(
      {
        metadata: {
          name: `task-index-${opts.contentHash}`,
          namespace: this.#namespace.metadata.name,
        },
        spec: {
          completions: 1,
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

  async create(opts: { runId: string; image: string; machine: Machine }) {
    await this.#createPod(
      {
        metadata: {
          name: `${opts.runId}-${randomUUID().slice(0, 5)}`,
          namespace: this.#namespace.metadata.name,
        },
        spec: {
          restartPolicy: "Never",
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

  async restore(opts: {
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

interface Provider {
  tasks: TaskOperations;
}

type KubernetesProviderOptions = {
  tasks: KubernetesTaskOperations;
  host?: string;
  port: number;
};

class KubernetesProvider implements Provider {
  tasks: KubernetesTaskOperations;

  #httpServer: ReturnType<typeof createServer>;
  #platformSocket: Socket<ProviderServerToClientEvents, ProviderClientToServerEvents>;

  constructor(private options: KubernetesProviderOptions) {
    this.tasks = options.tasks;
    this.#httpServer = this.#createHttpServer();
    this.#platformSocket = this.#createPlatformSocket();
  }

  #createPlatformSocket() {
    const socket: Socket<ProviderServerToClientEvents, ProviderClientToServerEvents> = io(
      `ws://${PLATFORM_HOST}:${PLATFORM_WS_PORT}/provider`,
      {
        transports: ["websocket"],
        auth: {
          token: PLATFORM_SECRET,
        },
        extraHeaders: {
          "x-trigger-provider-type": "kubernetes",
        },
      }
    );

    const logger = new SimpleLogger(`[platform][${socket.id ?? "NO_ID"}]`);

    socket.on("connect_error", (err) => {
      logger.error(`connect_error: ${err.message}`);
    });

    socket.on("connect", () => {
      logger.log("connect");
    });

    socket.on("disconnect", () => {
      logger.log("disconnect");
    });

    socket.on("GET", async (message) => {
      logger.log("[GET]", message);
      this.tasks.get({ runId: message.name });
    });

    socket.on("DELETE", async (message, callback) => {
      logger.log("[DELETE]", message);

      callback({
        message: "delete request received",
      });

      this.tasks.delete({ runId: message.name });
    });

    socket.on("INDEX", async (message) => {
      logger.log("[INDEX]", message);

      await this.tasks.index({
        contentHash: message.contentHash,
        imageTag: message.imageTag,
      });
    });

    socket.on("INVOKE", async (message) => {
      logger.log("[INVOKE]", message);

      await this.tasks.create({
        runId: message.name,
        image: message.name,
        machine: message.machine,
      });
    });

    socket.on("RESTORE", async (message) => {
      logger.log("[RESTORE]", message);

      // await this.tasks.restore({});
    });

    socket.on("HEALTH", async (message) => {
      logger.log("[HEALTH]", message);
    });

    return socket;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, req.url);

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/health": {
          return reply.text("ok");
        }
        case "/whoami": {
          return reply.text(`${POD_NAME}`);
        }
        case "/close": {
          this.#platformSocket.close();
          return reply.text("platform socket closed");
        }
        case "/delete": {
          const body = await getTextBody(req);

          await this.tasks.delete({ runId: body });

          return reply.text(`sent delete request: ${body}`);
        }
        case "/invoke": {
          const body = await getTextBody(req);

          await this.tasks.create({
            runId: body,
            image: body,
            machine: {
              cpu: "1",
              memory: "100Mi",
            },
          });

          return reply.text(`sent restore request: ${body}`);
        }
        case "/restore": {
          const body = await getTextBody(req);

          const items = body.split("&");
          const image = items[0];
          const baseImageTag = items[1] ?? image;

          await this.tasks.restore({
            runId: image,
            name: `${image}-restore`,
            image,
            checkpointId: baseImageTag,
            machine: {
              cpu: "1",
              memory: "100Mi",
            },
          });

          return reply.text(`sent restore request: ${body}`);
        }
        default: {
          return reply.empty(404);
        }
      }
    });

    httpServer.on("clientError", (err, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    httpServer.on("listening", () => {
      logger.log("server listening on port", this.options.port);
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.options.port, this.options.host ?? "0.0.0.0");
  }
}

const provider = new KubernetesProvider({
  port: HTTP_SERVER_PORT,
  tasks: new KubernetesTaskOperations(),
});

provider.listen();
