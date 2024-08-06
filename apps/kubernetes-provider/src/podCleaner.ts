import * as k8s from "@kubernetes/client-node";
import { SimpleLogger } from "@trigger.dev/core/v3/apps";

type PodCleanerOptions = {
  runtimeEnv: "local" | "kubernetes";
  namespace?: string;
  intervalInSeconds?: number;
};

export class PodCleaner {
  private enabled = false;
  private namespace = "default";
  private intervalInSeconds = 300;

  private logger = new SimpleLogger("[PodCleaner]");
  private k8sClient: {
    core: k8s.CoreV1Api;
    apps: k8s.AppsV1Api;
    kubeConfig: k8s.KubeConfig;
  };

  constructor(private opts: PodCleanerOptions) {
    if (opts.namespace) {
      this.namespace = opts.namespace;
    }

    if (opts.intervalInSeconds) {
      this.intervalInSeconds = opts.intervalInSeconds;
    }

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
      apps: kubeConfig.makeApiClient(k8s.AppsV1Api),
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

  async #deletePods(opts: {
    namespace: string;
    dryRun?: boolean;
    fieldSelector?: string;
    labelSelector?: string;
  }) {
    return await this.k8sClient.core
      .deleteCollectionNamespacedPod(
        opts.namespace,
        undefined, // pretty
        undefined, // continue
        opts.dryRun ? "All" : undefined,
        opts.fieldSelector,
        undefined, // gracePeriodSeconds
        opts.labelSelector
      )
      .catch(this.#handleK8sError.bind(this));
  }

  async #deleteDaemonSets(opts: {
    namespace: string;
    dryRun?: boolean;
    fieldSelector?: string;
    labelSelector?: string;
  }) {
    return await this.k8sClient.apps
      .deleteCollectionNamespacedDaemonSet(
        opts.namespace,
        undefined, // pretty
        undefined, // continue
        opts.dryRun ? "All" : undefined,
        opts.fieldSelector,
        undefined, // gracePeriodSeconds
        opts.labelSelector
      )
      .catch(this.#handleK8sError.bind(this));
  }

  async #deleteCompletedRuns() {
    this.logger.log("Deleting completed runs");

    const start = Date.now();

    const result = await this.#deletePods({
      namespace: this.namespace,
      fieldSelector: "status.phase=Succeeded",
      labelSelector: "app=task-run",
    });

    const elapsedMs = Date.now() - start;

    if (!result) {
      this.logger.log("Deleting completed runs: No delete result", { elapsedMs });
      return;
    }

    const total = (result.response as any)?.body?.items?.length ?? 0;

    this.logger.log("Deleting completed runs: Done", { total, elapsedMs });
  }

  async #deleteFailedRuns() {
    this.logger.log("Deleting failed runs");

    const start = Date.now();

    const result = await this.#deletePods({
      namespace: this.namespace,
      fieldSelector: "status.phase=Failed",
      labelSelector: "app=task-run",
    });

    const elapsedMs = Date.now() - start;

    if (!result) {
      this.logger.log("Deleting failed runs: No delete result", { elapsedMs });
      return;
    }

    const total = (result.response as any)?.body?.items?.length ?? 0;

    this.logger.log("Deleting failed runs: Done", { total, elapsedMs });
  }

  async #deleteUnrecoverableRuns() {
    await this.#deletePods({
      namespace: this.namespace,
      fieldSelector: "status.phase=?",
      labelSelector: "app=task-run",
    });
  }

  async #deleteCompletedPrePulls() {
    this.logger.log("Deleting completed pre-pulls");

    const start = Date.now();

    const result = await this.#deleteDaemonSets({
      namespace: this.namespace,
      labelSelector: "app=task-prepull",
    });

    const elapsedMs = Date.now() - start;

    if (!result) {
      this.logger.log("Deleting completed pre-pulls: No delete result", { elapsedMs });
      return;
    }

    const total = (result.response as any)?.body?.items?.length ?? 0;

    this.logger.log("Deleting completed pre-pulls: Done", { total, elapsedMs });
  }

  async start() {
    this.enabled = true;
    this.logger.log("Starting");

    const completedInterval = setInterval(async () => {
      if (!this.enabled) {
        clearInterval(completedInterval);
        return;
      }

      try {
        await this.#deleteCompletedRuns();
      } catch (error) {
        this.logger.error("Error deleting completed runs", error);
      }
    }, this.intervalInSeconds * 1000);

    const failedInterval = setInterval(
      async () => {
        if (!this.enabled) {
          clearInterval(failedInterval);
          return;
        }

        try {
          await this.#deleteFailedRuns();
        } catch (error) {
          this.logger.error("Error deleting completed runs", error);
        }
      },
      // Use a longer interval for failed runs. This is only a backup in case the task monitor fails.
      2 * this.intervalInSeconds * 1000
    );

    const completedPrePullInterval = setInterval(
      async () => {
        if (!this.enabled) {
          clearInterval(completedPrePullInterval);
          return;
        }

        try {
          await this.#deleteCompletedPrePulls();
        } catch (error) {
          this.logger.error("Error deleting completed pre-pulls", error);
        }
      },
      2 * this.intervalInSeconds * 1000
    );

    // this.#launchTests();
  }

  async stop() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.logger.log("Shutting down..");
  }

  async #launchTests() {
    const createPod = async (
      container: k8s.V1Container,
      name: string,
      labels?: Record<string, string>
    ) => {
      this.logger.log("Creating pod:", name);

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

      await this.k8sClient.core
        .createNamespacedPod(this.namespace, pod)
        .catch(this.#handleK8sError.bind(this));
    };

    const createIdlePod = async (name: string, labels?: Record<string, string>) => {
      const container = {
        name,
        image: "docker.io/library/busybox",
        command: ["sh"],
        args: ["-c", "sleep infinity"],
      } satisfies k8s.V1Container;

      await createPod(container, name, labels);
    };

    const createCompletedPod = async (name: string, labels?: Record<string, string>) => {
      const container = {
        name,
        image: "docker.io/library/busybox",
        command: ["sh"],
        args: ["-c", "true"],
      } satisfies k8s.V1Container;

      await createPod(container, name, labels);
    };

    const createFailedPod = async (name: string, labels?: Record<string, string>) => {
      const container = {
        name,
        image: "docker.io/library/busybox",
        command: ["sh"],
        args: ["-c", "false"],
      } satisfies k8s.V1Container;

      await createPod(container, name, labels);
    };

    await createIdlePod("test-idle-1", { app: "task-run" });
    await createFailedPod("test-failed-1", { app: "task-run" });
    await createCompletedPod("test-completed-1", { app: "task-run" });
  }
}
