import * as k8s from "@kubernetes/client-node";
import { SimpleLogger } from "@trigger.dev/core/v3/apps";

type UptimeHeartbeatOptions = {
  runtimeEnv: "local" | "kubernetes";
  pingUrl: string;
  namespace?: string;
  intervalInSeconds?: number;
  maxPendingRuns?: number;
  maxPendingIndeces?: number;
  maxPendingErrors?: number;
  leadingEdge?: boolean;
};

export class UptimeHeartbeat {
  private enabled = false;
  private namespace: string;

  private intervalInSeconds: number;
  private maxPendingRuns: number;
  private maxPendingIndeces: number;
  private maxPendingErrors: number;

  private leadingEdge = true;

  private logger = new SimpleLogger("[UptimeHeartbeat]");
  private k8sClient: {
    core: k8s.CoreV1Api;
    kubeConfig: k8s.KubeConfig;
  };

  constructor(private opts: UptimeHeartbeatOptions) {
    this.namespace = opts.namespace ?? "default";

    this.intervalInSeconds = opts.intervalInSeconds ?? 60;
    this.maxPendingRuns = opts.maxPendingRuns ?? 25;
    this.maxPendingIndeces = opts.maxPendingIndeces ?? 10;
    this.maxPendingErrors = opts.maxPendingErrors ?? 10;

    this.k8sClient = this.#createK8sClient();
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
      this.logger.debug("K8s API Error", err);
    } else {
      this.logger.error("K8s API Error", err);
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

  async #getPods(opts: {
    namespace: string;
    fieldSelector?: string;
    labelSelector?: string;
  }): Promise<Array<k8s.V1Pod> | undefined> {
    const listReturn = await this.k8sClient.core
      .listNamespacedPod(
        opts.namespace,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // _continue
        opts.fieldSelector,
        opts.labelSelector,
        this.maxPendingRuns * 2, // limit
        undefined, // resourceVersion
        undefined, // resourceVersionMatch
        undefined, // sendInitialEvents
        this.intervalInSeconds, // timeoutSeconds,
        undefined // watch
      )
      .catch(this.#handleK8sError.bind(this));

    return listReturn?.body.items;
  }

  async #getPendingIndeces(): Promise<Array<k8s.V1Pod> | undefined> {
    return await this.#getPods({
      namespace: this.namespace,
      fieldSelector: "status.phase=Pending",
      labelSelector: "app=task-index",
    });
  }

  async #getPendingTasks(): Promise<Array<k8s.V1Pod> | undefined> {
    return await this.#getPods({
      namespace: this.namespace,
      fieldSelector: "status.phase=Pending",
      labelSelector: "app=task-run",
    });
  }

  #countPods(pods: Array<k8s.V1Pod>): number {
    return pods.length;
  }

  #filterPendingPods(
    pods: Array<k8s.V1Pod>,
    waitingReason: "CreateContainerError" | "RunContainerError"
  ): Array<k8s.V1Pod> {
    return pods.filter((pod) => {
      const containerStatus = pod.status?.containerStatuses?.[0];
      return containerStatus?.state?.waiting?.reason === waitingReason;
    });
  }

  async #sendPing() {
    this.logger.log("Sending ping");

    const start = Date.now();
    const controller = new AbortController();

    const timeoutMs = (this.intervalInSeconds * 1000) / 2;

    const fetchTimeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(this.opts.pingUrl, {
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.error("Failed to send ping, response not OK", {
          status: response.status,
        });
        return;
      }

      const elapsedMs = Date.now() - start;
      this.logger.log("Ping sent", { elapsedMs });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.logger.log("Ping timeout", { timeoutSeconds: timeoutMs });
        return;
      }

      this.logger.error("Failed to send ping", error);
    } finally {
      clearTimeout(fetchTimeout);
    }
  }

  async #heartbeat() {
    this.logger.log("Performing heartbeat");

    const start = Date.now();

    const pendingTasks = await this.#getPendingTasks();

    if (!pendingTasks) {
      this.logger.error("Failed to get pending tasks");
      return;
    }

    const totalPendingTasks = this.#countPods(pendingTasks);

    const pendingIndeces = await this.#getPendingIndeces();

    if (!pendingIndeces) {
      this.logger.error("Failed to get pending indeces");
      return;
    }

    const totalPendingIndeces = this.#countPods(pendingIndeces);

    const elapsedMs = Date.now() - start;

    this.logger.log("Finished heartbeat checks", { elapsedMs });

    if (totalPendingTasks > this.maxPendingRuns) {
      this.logger.log("Too many pending tasks, skipping heartbeat", { totalPendingTasks });
      return;
    }

    if (totalPendingIndeces > this.maxPendingIndeces) {
      this.logger.log("Too many pending indeces, skipping heartbeat", { totalPendingIndeces });
      return;
    }

    const totalCreateContainerErrors = this.#countPods(
      this.#filterPendingPods(pendingTasks, "CreateContainerError")
    );
    const totalRunContainerErrors = this.#countPods(
      this.#filterPendingPods(pendingTasks, "RunContainerError")
    );

    if (totalCreateContainerErrors + totalRunContainerErrors > this.maxPendingErrors) {
      this.logger.log("Too many pending tasks with errors, skipping heartbeat", {
        totalRunContainerErrors,
        totalCreateContainerErrors,
      });
      return;
    }

    await this.#sendPing();

    this.logger.log("Heartbeat done", { totalPendingTasks, elapsedMs });
  }

  async start() {
    this.enabled = true;
    this.logger.log("Starting");

    if (this.leadingEdge) {
      await this.#heartbeat();
    }

    const heartbeat = setInterval(async () => {
      if (!this.enabled) {
        clearInterval(heartbeat);
        return;
      }

      try {
        await this.#heartbeat();
      } catch (error) {
        this.logger.error("Error while heartbeating", error);
      }
    }, this.intervalInSeconds * 1000);
  }

  async stop() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.logger.log("Shutting down..");
  }
}
