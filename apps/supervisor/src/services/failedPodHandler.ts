import { LogLevel, SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { K8sApi } from "../clients/kubernetes.js";
import { createK8sApi } from "../clients/kubernetes.js";
import { Informer, V1Pod } from "@kubernetes/client-node";
import { Counter, Registry, Histogram } from "prom-client";
import { register } from "../metrics.js";
import { setTimeout } from "timers/promises";

type PodStatus = "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown" | "GracefulShutdown";

export type FailedPodHandlerOptions = {
  namespace: string;
  reconnectIntervalMs?: number;
  k8s?: K8sApi;
  register?: Registry;
};

export class FailedPodHandler {
  private readonly id: string;
  private readonly logger: SimpleStructuredLogger;
  private readonly k8s: K8sApi;
  private readonly namespace: string;

  private isRunning = false;

  private readonly informer: Informer<V1Pod>;
  private readonly reconnectIntervalMs: number;
  private reconnecting = false;

  // Metrics
  private readonly register: Registry;
  private readonly processedPodsTotal: Counter;
  private readonly deletedPodsTotal: Counter;
  private readonly deletionErrorsTotal: Counter;
  private readonly processingDurationSeconds: Histogram<string>;
  private readonly informerEventsTotal: Counter;

  static readonly GRACEFUL_SHUTDOWN_EXIT_CODE = 200;

  constructor(opts: FailedPodHandlerOptions) {
    this.id = Math.random().toString(36).substring(2, 15);
    this.logger = new SimpleStructuredLogger("failed-pod-handler", LogLevel.debug, {
      id: this.id,
    });

    this.k8s = opts.k8s ?? createK8sApi();

    this.namespace = opts.namespace;
    this.reconnectIntervalMs = opts.reconnectIntervalMs ?? 1000;

    this.informer = this.k8s.makeInformer(
      `/api/v1/namespaces/${this.namespace}/pods`,
      () =>
        this.k8s.core.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: "app=task-run",
          fieldSelector: "status.phase=Failed",
        }),
      "app=task-run",
      "status.phase=Failed"
    );

    // Whenever a matching pod is added to the informer cache
    this.informer.on("add", this.onPodCompleted.bind(this));

    // Informer events
    this.informer.on("connect", this.makeOnConnect("failed-pod-informer").bind(this));
    this.informer.on("error", this.makeOnError("failed-pod-informer").bind(this));

    // Initialize metrics
    this.register = opts.register ?? register;

    this.processedPodsTotal = new Counter({
      name: "failed_pod_handler_processed_pods_total",
      help: "Total number of failed pods processed",
      labelNames: ["namespace", "status"],
      registers: [this.register],
    });

    this.deletedPodsTotal = new Counter({
      name: "failed_pod_handler_deleted_pods_total",
      help: "Total number of pods deleted",
      labelNames: ["namespace", "status"],
      registers: [this.register],
    });

    this.deletionErrorsTotal = new Counter({
      name: "failed_pod_handler_deletion_errors_total",
      help: "Total number of errors encountered while deleting pods",
      labelNames: ["namespace", "error_type"],
      registers: [this.register],
    });

    this.processingDurationSeconds = new Histogram({
      name: "failed_pod_handler_processing_duration_seconds",
      help: "The duration of pod processing",
      labelNames: ["namespace", "status"],
      registers: [this.register],
    });

    this.informerEventsTotal = new Counter({
      name: "failed_pod_handler_informer_events_total",
      help: "Total number of informer events",
      labelNames: ["namespace", "verb"],
      registers: [this.register],
    });
  }

  async start() {
    if (this.isRunning) {
      this.logger.warn("failed pod handler already running");
      return;
    }

    this.isRunning = true;

    this.logger.info("starting failed pod handler");
    await this.informer.start();
  }

  async stop() {
    if (!this.isRunning) {
      this.logger.warn("failed pod handler not running");
      return;
    }

    this.isRunning = false;

    this.logger.info("stopping failed pod handler");
    await this.informer.stop();
  }

  private async withHistogram<T>(
    histogram: Histogram<string>,
    promise: Promise<T>,
    labels?: Record<string, string>
  ): Promise<T> {
    const end = histogram.startTimer({ namespace: this.namespace, ...labels });
    try {
      return await promise;
    } finally {
      end();
    }
  }

  /**
   * Returns the non-nullable status of a pod
   */
  private podStatus(pod: V1Pod): PodStatus {
    return (pod.status?.phase ?? "Unknown") as PodStatus;
  }

  private async onPodCompleted(pod: V1Pod) {
    this.logger.info("pod-completed", this.podSummary(pod));
    this.informerEventsTotal.inc({ namespace: this.namespace, verb: "add" });

    if (!pod.metadata?.name) {
      this.logger.error("pod-completed: no name", this.podSummary(pod));
      return;
    }

    if (!pod.status) {
      this.logger.error("pod-completed: no status", this.podSummary(pod));
      return;
    }

    if (pod.metadata?.deletionTimestamp) {
      this.logger.info("pod-completed: pod is being deleted", this.podSummary(pod));
      return;
    }

    const podStatus = this.podStatus(pod);

    switch (podStatus) {
      case "Succeeded":
        await this.withHistogram(this.processingDurationSeconds, this.onPodSucceeded(pod), {
          status: podStatus,
        });
        break;
      case "Failed":
        await this.withHistogram(this.processingDurationSeconds, this.onPodFailed(pod), {
          status: podStatus,
        });
        break;
      default:
        this.logger.error("pod-completed: unknown phase", this.podSummary(pod));
    }
  }

  private async onPodSucceeded(pod: V1Pod) {
    this.logger.info("pod-succeeded", this.podSummary(pod));
    this.processedPodsTotal.inc({
      namespace: this.namespace,
      status: this.podStatus(pod),
    });
  }

  private async onPodFailed(pod: V1Pod) {
    this.logger.info("pod-failed", this.podSummary(pod));

    try {
      await this.processFailedPod(pod);
    } catch (error) {
      this.logger.error("pod-failed: error processing pod", this.podSummary(pod), { error });
    } finally {
      await this.deletePod(pod);
    }
  }

  private async processFailedPod(pod: V1Pod) {
    this.logger.info("pod-failed: processing pod", this.podSummary(pod));

    const mainContainer = pod.status?.containerStatuses?.find((c) => c.name === "run-controller");

    // If it's our special "graceful shutdown" exit code, don't process it further, just delete it
    if (
      mainContainer?.state?.terminated?.exitCode === FailedPodHandler.GRACEFUL_SHUTDOWN_EXIT_CODE
    ) {
      this.logger.debug("pod-failed: graceful shutdown detected", this.podSummary(pod));
      this.processedPodsTotal.inc({
        namespace: this.namespace,
        status: "GracefulShutdown",
      });
      return;
    }

    this.processedPodsTotal.inc({
      namespace: this.namespace,
      status: this.podStatus(pod),
    });
  }

  private async deletePod(pod: V1Pod) {
    this.logger.info("pod-failed: deleting pod", this.podSummary(pod));
    try {
      await this.k8s.core.deleteNamespacedPod({
        name: pod.metadata!.name!,
        namespace: this.namespace,
      });
      this.deletedPodsTotal.inc({
        namespace: this.namespace,
        status: this.podStatus(pod),
      });
    } catch (error) {
      this.logger.error("pod-failed: error deleting pod", this.podSummary(pod), { error });
      this.deletionErrorsTotal.inc({
        namespace: this.namespace,
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private makeOnError(informerName: string) {
    return (err?: unknown) => this.onError(informerName, err);
  }

  private async onError(informerName: string, err?: unknown) {
    if (!this.isRunning) {
      this.logger.warn("onError: informer not running");
      return;
    }

    // Guard against multiple simultaneous reconnections
    if (this.reconnecting) {
      this.logger.debug("onError: reconnection already in progress, skipping", {
        informerName,
      });
      return;
    }

    this.reconnecting = true;

    try {
      const error = err instanceof Error ? err : undefined;
      this.logger.error("error event fired", {
        informerName,
        error: error?.message,
        errorType: error?.name,
        errorStack: error?.stack,
      });
      this.informerEventsTotal.inc({ namespace: this.namespace, verb: "error" });

      // Reconnect on errors
      await setTimeout(this.reconnectIntervalMs);
      await this.informer.start();
    } finally {
      this.reconnecting = false;
    }
  }

  private makeOnConnect(informerName: string) {
    return () => this.onConnect(informerName);
  }

  private async onConnect(informerName: string) {
    this.logger.info(`informer connected: ${informerName}`);
    this.informerEventsTotal.inc({ namespace: this.namespace, verb: "connect" });
  }

  private podSummary(pod: V1Pod) {
    return {
      name: pod.metadata?.name,
      namespace: pod.metadata?.namespace,
      status: pod.status?.phase,
      deletionTimestamp: pod.metadata?.deletionTimestamp,
    };
  }

  // Method to expose metrics for testing
  public getMetrics() {
    return {
      processedPodsTotal: this.processedPodsTotal,
      deletedPodsTotal: this.deletedPodsTotal,
      deletionErrorsTotal: this.deletionErrorsTotal,
      informerEventsTotal: this.informerEventsTotal,
      processingDurationSeconds: this.processingDurationSeconds,
    };
  }
}
