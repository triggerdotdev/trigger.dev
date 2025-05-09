import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { K8sApi } from "../clients/kubernetes.js";
import { createK8sApi } from "../clients/kubernetes.js";
import { IntervalService } from "@trigger.dev/core/v3";
import { Counter, Gauge, Registry } from "prom-client";
import { register } from "../metrics.js";

export type PodCleanerOptions = {
  namespace: string;
  k8s?: K8sApi;
  register?: Registry;
  batchSize?: number;
  intervalMs?: number;
};

export class PodCleaner {
  private readonly logger = new SimpleStructuredLogger("pod-cleaner");
  private readonly k8s: K8sApi;
  private readonly namespace: string;

  private readonly batchSize: number;
  private readonly deletionInterval: IntervalService;

  // Metrics
  private readonly register: Registry;
  private readonly deletionCyclesTotal: Counter;
  private readonly lastDeletionTimestamp: Gauge;

  constructor(opts: PodCleanerOptions) {
    this.k8s = opts.k8s ?? createK8sApi();

    this.namespace = opts.namespace;
    this.batchSize = opts.batchSize ?? 500;

    this.deletionInterval = new IntervalService({
      intervalMs: opts.intervalMs ?? 10000,
      leadingEdge: true,
      onInterval: this.deleteCompletedPods.bind(this),
    });

    // Initialize metrics
    this.register = opts.register ?? register;

    this.deletionCyclesTotal = new Counter({
      name: "pod_cleaner_deletion_cycles_total",
      help: "Total number of pod deletion cycles run",
      labelNames: ["namespace", "status", "batch_size"],
      registers: [this.register],
    });

    this.lastDeletionTimestamp = new Gauge({
      name: "pod_cleaner_last_deletion_timestamp",
      help: "Timestamp of the last deletion cycle",
      labelNames: ["namespace"],
      registers: [this.register],
    });
  }

  async start() {
    this.deletionInterval.start();
  }

  async stop() {
    this.deletionInterval.stop();
  }

  private async deleteCompletedPods() {
    let continuationToken: string | undefined;

    do {
      try {
        const result = await this.k8s.core.deleteCollectionNamespacedPod({
          namespace: this.namespace,
          labelSelector: "app=task-run",
          fieldSelector: "status.phase=Succeeded",
          limit: this.batchSize,
          _continue: continuationToken,
          gracePeriodSeconds: 0,
          propagationPolicy: "Background",
          timeoutSeconds: 30,
        });

        // Update continuation token for next batch
        continuationToken = result.metadata?._continue;

        // Increment the deletion cycles counter
        this.deletionCyclesTotal.inc({
          namespace: this.namespace,
          batch_size: this.batchSize,
          status: "succeeded",
        });

        this.logger.info("Deleted batch of pods", { continuationToken });
      } catch (err) {
        this.logger.error("Failed to delete batch of pods", {
          err: err instanceof Error ? err.message : String(err),
        });

        this.deletionCyclesTotal.inc({
          namespace: this.namespace,
          batch_size: this.batchSize,
          status: "failed",
        });
        break;
      }
    } while (continuationToken);

    this.lastDeletionTimestamp.set({ namespace: this.namespace }, Date.now());
  }

  // Method to expose metrics for testing
  public getMetrics() {
    return {
      deletionCyclesTotal: this.deletionCyclesTotal,
      lastDeletionTimestamp: this.lastDeletionTimestamp,
    };
  }
}
