import * as k8s from "@kubernetes/client-node";
import { SimpleLogger } from "@trigger.dev/core/v3/apps";
import { EXIT_CODE_ALREADY_HANDLED, EXIT_CODE_CHILD_NONZERO } from "@trigger.dev/core/v3/apps";
import { setTimeout } from "timers/promises";
import PQueue from "p-queue";
import { TaskRunErrorCodes, type Prettify, type TaskRunInternalError } from "@trigger.dev/core/v3";

type FailureDetails = Prettify<{
  exitCode: number;
  reason: string;
  logs: string;
  overrideCompletion: boolean;
  errorCode: TaskRunInternalError["code"];
}>;

type IndexFailureHandler = (deploymentId: string, details: FailureDetails) => Promise<any>;

type RunFailureHandler = (runId: string, details: FailureDetails) => Promise<any>;

type TaskMonitorOptions = {
  runtimeEnv: "local" | "kubernetes";
  onIndexFailure?: IndexFailureHandler;
  onRunFailure?: RunFailureHandler;
  namespace?: string;
};

export class TaskMonitor {
  #enabled = false;

  #logger = new SimpleLogger("[TaskMonitor]");
  #taskInformer: ReturnType<typeof k8s.makeInformer<k8s.V1Pod>>;
  #processedPods = new Map<string, number>();
  #queue = new PQueue({ concurrency: 10 });

  #k8sClient: {
    core: k8s.CoreV1Api;
    kubeConfig: k8s.KubeConfig;
  };

  private namespace = "default";
  private fieldSelector = "status.phase=Failed";
  private labelSelector = "app in (task-index, task-run)";

  constructor(private opts: TaskMonitorOptions) {
    if (opts.namespace) {
      this.namespace = opts.namespace;
    }

    this.#k8sClient = this.#createK8sClient();

    this.#taskInformer = this.#createTaskInformer();
    this.#taskInformer.on("connect", this.#onInformerConnected.bind(this));
    this.#taskInformer.on("error", this.#onInformerError.bind(this));
    this.#taskInformer.on("update", this.#enqueueOnPodUpdated.bind(this));
  }

  #createTaskInformer() {
    const listTasks = () =>
      this.#k8sClient.core.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        this.fieldSelector,
        this.labelSelector
      );

    // Uses watch with local caching
    // https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes
    const informer = k8s.makeInformer(
      this.#k8sClient.kubeConfig,
      `/api/v1/namespaces/${this.namespace}/pods`,
      listTasks,
      this.labelSelector,
      this.fieldSelector
    );

    return informer;
  }

  async #onInformerConnected() {
    this.#logger.log("Connected");
  }

  async #onInformerError(error: any) {
    this.#logger.error("Error:", error);

    // Automatic reconnect
    await setTimeout(2_000);
    this.#taskInformer.start();
  }

  #enqueueOnPodUpdated(pod: k8s.V1Pod) {
    this.#queue.add(async () => {
      try {
        // It would be better to only pass the cache key, but the pod may already be removed from the cache by the time we process it
        await this.#onPodUpdated(pod);
      } catch (error) {
        this.#logger.error("Caught onPodUpdated() error:", error);
      }
    });
  }

  async #onPodUpdated(pod: k8s.V1Pod) {
    this.#logger.debug(`Updated: ${pod.metadata?.name}`);
    this.#logger.debug("Updated", JSON.stringify(pod, null, 2));

    // We only care about failures
    if (pod.status?.phase !== "Failed") {
      return;
    }

    const podName = pod.metadata?.name;

    if (!podName) {
      this.#logger.error("Pod is nameless", { pod });
      return;
    }

    const containerStatus = pod.status.containerStatuses?.[0];

    if (!containerStatus?.state) {
      this.#logger.error("Pod failed, but container status doesn't have state", {
        status: pod.status,
      });
      return;
    }

    if (this.#processedPods.has(podName)) {
      this.#logger.debug("Pod update already processed", {
        podName,
        timestamp: this.#processedPods.get(podName),
      });
      return;
    }

    this.#processedPods.set(podName, Date.now());

    const podStatus = this.#getPodStatusSummary(pod.status);
    const containerState = this.#getContainerStateSummary(containerStatus.state);
    const exitCode = containerState.exitCode ?? -1;

    if (exitCode === EXIT_CODE_ALREADY_HANDLED) {
      this.#logger.debug("Ignoring pod failure, already handled by worker", {
        podName,
      });
      return;
    }

    const rawLogs = await this.#getLogTail(podName);

    this.#logger.log(`${podName} failed with:`, {
      podStatus,
      containerState,
      rawLogs,
    });

    const rawReason = podStatus.reason ?? containerState.reason ?? "";
    const message = podStatus.message ?? containerState.message ?? "";

    let reason = rawReason || "Unknown error";
    let logs = rawLogs || "";

    /** This will only override existing task errors. It will not crash the run.  */
    let onlyOverrideExistingError = exitCode === EXIT_CODE_CHILD_NONZERO;

    let errorCode: TaskRunInternalError["code"] = TaskRunErrorCodes.POD_UNKNOWN_ERROR;

    switch (rawReason) {
      case "Error":
        reason = "Unknown error.";
        errorCode = TaskRunErrorCodes.POD_UNKNOWN_ERROR;
        break;
      case "Evicted":
        if (message.startsWith("Pod ephemeral local storage usage")) {
          reason = "Storage limit exceeded.";
          errorCode = TaskRunErrorCodes.DISK_SPACE_EXCEEDED;
        } else if (message) {
          reason = `Evicted: ${message}`;
          errorCode = TaskRunErrorCodes.POD_EVICTED;
        } else {
          reason = "Evicted for unknown reason.";
          errorCode = TaskRunErrorCodes.POD_EVICTED;
        }

        if (logs.startsWith("failed to try resolving symlinks")) {
          logs = "";
        }
        break;
      case "OOMKilled":
        reason =
          "[TaskMonitor] Your task ran out of memory. Try increasing the machine specs. If this doesn't fix it there might be a memory leak.";
        errorCode = TaskRunErrorCodes.TASK_PROCESS_OOM_KILLED;
        break;
      default:
        break;
    }

    const failureInfo = {
      exitCode,
      reason,
      logs,
      overrideCompletion: onlyOverrideExistingError,
      errorCode,
    } satisfies FailureDetails;

    const app = pod.metadata?.labels?.app;

    switch (app) {
      case "task-index":
        const deploymentId = pod.metadata?.labels?.deployment;

        if (!deploymentId) {
          this.#logger.error("Index is missing ID", { pod });
          return;
        }

        if (this.opts.onIndexFailure) {
          await this.opts.onIndexFailure(deploymentId, failureInfo);
        }
        break;
      case "task-run":
        const runId = pod.metadata?.labels?.run;

        if (!runId) {
          this.#logger.error("Run is missing ID", { pod });
          return;
        }

        if (this.opts.onRunFailure) {
          await this.opts.onRunFailure(runId, failureInfo);
        }
        break;
      default:
        this.#logger.error("Pod has invalid app label", { pod });
        return;
    }

    await this.#deletePod(podName);
  }

  async #getLogTail(podName: string) {
    try {
      const logs = await this.#k8sClient.core.readNamespacedPodLog(
        podName,
        this.namespace,
        undefined,
        undefined,
        undefined,
        1024, // limitBytes
        undefined,
        undefined,
        undefined,
        20 // tailLines
      );

      const responseBody = logs.body ?? "";

      if (responseBody.startsWith("unable to retrieve container logs")) {
        return "";
      }

      // Type is wrong, body may be undefined
      return responseBody;
    } catch (error) {
      this.#logger.error("Log tail error:", error instanceof Error ? error.message : "unknown");
      return "";
    }
  }

  #getPodStatusSummary(status: k8s.V1PodStatus) {
    return {
      reason: status.reason,
      message: status.message,
    };
  }

  #getContainerStateSummary(state: k8s.V1ContainerState) {
    return {
      reason: state.terminated?.reason,
      exitCode: state.terminated?.exitCode,
      message: state.terminated?.message,
    };
  }

  #createK8sClient() {
    const kubeConfig = new k8s.KubeConfig();

    if (this.opts.runtimeEnv === "local") {
      kubeConfig.loadFromDefault();
    } else if (this.opts.runtimeEnv === "kubernetes") {
      kubeConfig.loadFromCluster();
    } else {
      throw new Error(`Unsupported runtime environment: ${this.opts.runtimeEnv}`);
    }

    return {
      core: kubeConfig.makeApiClient(k8s.CoreV1Api),
      kubeConfig: kubeConfig,
    };
  }

  #isRecord(candidate: unknown): candidate is Record<string, unknown> {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    } else {
      return true;
    }
  }

  #logK8sError(err: unknown, debugOnly = false) {
    if (debugOnly) {
      this.#logger.debug("K8s API Error", err);
    } else {
      this.#logger.error("K8s API Error", err);
    }
  }

  #handleK8sError(err: unknown) {
    if (!this.#isRecord(err) || !this.#isRecord(err.body)) {
      this.#logK8sError(err);
      return;
    }

    this.#logK8sError(err, true);

    if (typeof err.body.message === "string") {
      this.#logK8sError({ message: err.body.message });
      return;
    }

    this.#logK8sError({ body: err.body });
  }

  #printStats(includeMoreDetails = false) {
    this.#logger.log("Stats:", {
      cacheSize: this.#taskInformer.list().length,
      totalProcessed: this.#processedPods.size,
      ...(includeMoreDetails && {
        processedPods: this.#processedPods,
      }),
    });
  }

  async #deletePod(name: string) {
    this.#logger.debug("Deleting pod:", name);

    await this.#k8sClient.core
      .deleteNamespacedPod(name, this.namespace)
      .catch(this.#handleK8sError.bind(this));
  }

  async start() {
    this.#enabled = true;

    const interval = setInterval(() => {
      if (!this.#enabled) {
        clearInterval(interval);
        return;
      }

      this.#printStats();
    }, 300_000);

    await this.#taskInformer.start();

    // this.#launchTests();
  }

  async stop() {
    if (!this.#enabled) {
      return;
    }

    this.#enabled = false;
    this.#logger.log("Shutting down..");

    await this.#taskInformer.stop();

    this.#printStats(true);
  }

  async #launchTests() {
    const createPod = async (
      container: k8s.V1Container,
      name: string,
      labels?: Record<string, string>
    ) => {
      this.#logger.log("Creating pod:", name);

      const pod = {
        metadata: {
          name,
          labels,
        },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 1,
          containers: [container],
        },
      } satisfies k8s.V1Pod;

      await this.#k8sClient.core
        .createNamespacedPod(this.namespace, pod)
        .catch(this.#handleK8sError.bind(this));
    };

    const createOomPod = async (name: string, labels?: Record<string, string>) => {
      const container = {
        name,
        image: "polinux/stress",
        resources: {
          limits: {
            memory: "100Mi",
          },
        },
        command: ["stress"],
        args: ["--vm", "1", "--vm-bytes", "150M", "--vm-hang", "1"],
      } satisfies k8s.V1Container;

      await createPod(container, name, labels);
    };

    const createNonZeroExitPod = async (name: string, labels?: Record<string, string>) => {
      const container = {
        name,
        image: "docker.io/library/busybox",
        command: ["sh"],
        args: ["-c", "exit 1"],
      } satisfies k8s.V1Container;

      await createPod(container, name, labels);
    };

    const createOoDiskPod = async (name: string, labels?: Record<string, string>) => {
      const container = {
        name,
        image: "docker.io/library/busybox",
        command: ["sh"],
        args: [
          "-c",
          "echo creating huge-file..; head -c 1000m /dev/zero > huge-file; ls -lh huge-file; sleep infinity",
        ],
        resources: {
          limits: {
            "ephemeral-storage": "500Mi",
          },
        },
      } satisfies k8s.V1Container;

      await createPod(container, name, labels);
    };

    await createNonZeroExitPod("non-zero-exit-task", { app: "task-run", run: "123" });
    await createOomPod("oom-task", { app: "task-index", deployment: "456" });
    await createOoDiskPod("ood-task", { app: "task-run", run: "abc" });
  }
}
