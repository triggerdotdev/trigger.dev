import { Worker } from "node:worker_threads";
import path from "node:path";
import { logger } from "~/services/logger.server";

export type TransformKind = "traces" | "logs" | "metrics";

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };

type QueueItem = {
  message: {
    id: number;
    kind: TransformKind;
    payload: Uint8Array;
    spanAttributeValueLengthLimit: number;
    defaultEventStore: string;
  };
  transfer: ArrayBuffer[];
  pending: Pending;
};

// Hand-rolled worker_threads pool: one in-flight task per worker so CPU-bound transforms run
// fully in parallel. The main thread stays the only DB reader and broadcasts pricing to workers.
export class OtlpWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: QueueItem[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly busyByWorker = new Map<Worker, number>();
  private nextId = 1;
  private latestPricingModels: unknown[];

  constructor(
    private readonly size: number,
    private readonly workerPath: string,
    pricingModels: unknown[]
  ) {
    this.latestPricingModels = pricingModels;
    for (let i = 0; i < size; i++) {
      this.spawn();
    }
    logger.info("OtlpWorkerPool started", { size, workerPath });
  }

  private spawn() {
    const worker = new Worker(this.workerPath, {
      workerData: { pricingModels: this.latestPricingModels },
    });

    worker.on("message", (msg: { id: number; ok: boolean; result?: any; error?: string }) => {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      this.busyByWorker.delete(worker);
      if (pending) {
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error ?? "otlp worker error"));
      }
      this.release(worker);
    });

    worker.on("error", (error) => {
      logger.error("OtlpWorkerPool worker error", { error: error.message });
      this.reap(worker, error);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        this.reap(worker, new Error(`otlp worker exited with code ${code}`));
      }
    });

    this.workers.push(worker);
    this.idle.push(worker);
  }

  // On crash: fail its in-flight task, drop it, and spawn a replacement.
  private reap(worker: Worker, error: Error) {
    const inFlightId = this.busyByWorker.get(worker);
    if (inFlightId !== undefined) {
      const pending = this.pending.get(inFlightId);
      this.pending.delete(inFlightId);
      this.busyByWorker.delete(worker);
      pending?.reject(error);
    }
    const wi = this.workers.indexOf(worker);
    if (wi !== -1) this.workers.splice(wi, 1);
    const ii = this.idle.indexOf(worker);
    if (ii !== -1) this.idle.splice(ii, 1);
    void worker.terminate().catch(() => {});
    if (this.workers.length < this.size) this.spawn();
    this.drain();
  }

  private release(worker: Worker) {
    this.idle.push(worker);
    this.drain();
  }

  private drain() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const worker = this.idle.pop()!;
      const item = this.queue.shift()!;
      this.pending.set(item.message.id, item.pending);
      this.busyByWorker.set(worker, item.message.id);
      worker.postMessage(item.message, item.transfer);
    }
  }

  runTransform(
    kind: TransformKind,
    payload: Uint8Array,
    config: { spanAttributeValueLengthLimit: number; defaultEventStore: string }
  ): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.queue.push({
        message: {
          id,
          kind,
          payload,
          spanAttributeValueLengthLimit: config.spanAttributeValueLengthLimit,
          defaultEventStore: config.defaultEventStore,
        },
        // Zero-copy the payload into the worker; the request owns a fresh ArrayBuffer.
        transfer: [payload.buffer as ArrayBuffer],
        pending: { resolve, reject },
      });
      this.drain();
    });
  }

  broadcastPricing(models: unknown[]) {
    this.latestPricingModels = models;
    for (const worker of this.workers) {
      worker.postMessage({ type: "pricing", models });
    }
    logger.info("OtlpWorkerPool broadcast pricing", {
      models: models.length,
      workers: this.workers.length,
    });
  }

  get queueDepth() {
    return this.queue.length;
  }
}

let pool: OtlpWorkerPool | undefined;

export function getOtlpWorkerPool(size: number, pricingModels: unknown[]): OtlpWorkerPool {
  if (!pool) {
    const workerPath =
      process.env.OTEL_TRANSFORM_WORKER_PATH ??
      path.join(process.cwd(), "build", "otlpTransformWorker.cjs");
    pool = new OtlpWorkerPool(size, workerPath, pricingModels);
  }
  return pool;
}

export function broadcastPricingToPool(models: unknown[]) {
  pool?.broadcastPricing(models);
}
