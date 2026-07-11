import { Worker } from "node:worker_threads";
import path from "node:path";
import { logger } from "~/services/logger.server";

export type TransformKind = "traces" | "logs" | "metrics";

type TaskMessage = {
  id: number;
  kind: TransformKind;
  payload: Uint8Array;
  spanAttributeValueLengthLimit: number;
  defaultEventStore: string;
};

type Task = {
  message: TaskMessage;
  transfer: ArrayBuffer[];
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  worker?: Worker;
};

const TASK_TIMEOUT_MS = 30_000;
const MAX_QUEUE_DEPTH = 2_000;
const RESPAWN_BASE_MS = 500;
const RESPAWN_MAX_MS = 30_000;

// Hand-rolled worker_threads pool: one in-flight task per worker so CPU-bound transforms run
// fully in parallel. The main thread stays the only DB reader and broadcasts pricing to workers.
export class OtlpWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: number[] = [];
  private readonly tasks = new Map<number, Task>();
  private readonly busyByWorker = new Map<Worker, number>();
  private nextId = 1;
  private consecutiveFailures = 0;
  private latestPricingModels: unknown[];

  constructor(
    private readonly size: number,
    private readonly workerPath: string,
    pricingModels: unknown[]
  ) {
    this.latestPricingModels = pricingModels;
    for (let i = 0; i < size; i++) this.spawn();
    logger.info("OtlpWorkerPool started", { size, workerPath });
  }

  private spawn() {
    const worker = new Worker(this.workerPath, {
      workerData: { pricingModels: this.latestPricingModels },
    });

    worker.on("message", (msg: { id: number; ok: boolean; result?: any; error?: string }) => {
      this.consecutiveFailures = 0;
      this.busyByWorker.delete(worker);
      const task = this.tasks.get(msg.id);
      if (task) {
        clearTimeout(task.timer);
        this.tasks.delete(msg.id);
        if (msg.ok) task.resolve(msg.result);
        else task.reject(new Error(msg.error ?? "otlp worker error"));
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

  // On crash/timeout: fail the worker's in-flight task (if still pending), drop the worker, and
  // respawn with exponential backoff so a persistently failing worker can't tight-loop.
  private reap(worker: Worker, error: Error) {
    const inFlightId = this.busyByWorker.get(worker);
    this.busyByWorker.delete(worker);
    if (inFlightId !== undefined) {
      const task = this.tasks.get(inFlightId);
      if (task) {
        clearTimeout(task.timer);
        this.tasks.delete(inFlightId);
        task.reject(error);
      }
    }
    const wi = this.workers.indexOf(worker);
    if (wi !== -1) this.workers.splice(wi, 1);
    const ii = this.idle.indexOf(worker);
    if (ii !== -1) this.idle.splice(ii, 1);
    void worker.terminate().catch(() => {});
    this.scheduleRespawn();
  }

  private scheduleRespawn() {
    if (this.workers.length >= this.size) return;
    const delay = Math.min(RESPAWN_BASE_MS * 2 ** this.consecutiveFailures, RESPAWN_MAX_MS);
    this.consecutiveFailures++;
    setTimeout(() => {
      if (this.workers.length < this.size) this.spawn();
      this.drain();
    }, delay);
  }

  private release(worker: Worker) {
    this.idle.push(worker);
    this.drain();
  }

  private drain() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const worker = this.idle.pop()!;
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task) continue;
      task.worker = worker;
      this.busyByWorker.set(worker, id);
      worker.postMessage(task.message, task.transfer);
    }
  }

  private onTimeout(id: number) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.delete(id);
    const err = new Error(`otlp worker task timed out after ${TASK_TIMEOUT_MS}ms`);
    if (task.worker) {
      // Dispatched to a stuck worker: reap it. The task is already removed, so reap won't
      // double-reject.
      this.reap(task.worker, err);
    } else {
      const qi = this.queue.indexOf(id);
      if (qi !== -1) this.queue.splice(qi, 1);
    }
    task.reject(err);
  }

  runTransform(
    kind: TransformKind,
    payload: Uint8Array,
    config: { spanAttributeValueLengthLimit: number; defaultEventStore: string }
  ): Promise<any> {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      return Promise.reject(new Error("otlp worker pool queue is full"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(id), TASK_TIMEOUT_MS);
      this.tasks.set(id, {
        message: {
          id,
          kind,
          payload,
          spanAttributeValueLengthLimit: config.spanAttributeValueLengthLimit,
          defaultEventStore: config.defaultEventStore,
        },
        // Zero-copy the payload into the worker; the request owns a fresh ArrayBuffer.
        transfer: [payload.buffer as ArrayBuffer],
        resolve,
        reject,
        timer,
      });
      this.queue.push(id);
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

export function getOtlpWorkerPool(
  size: number,
  pricingModels: unknown[],
  workerPath?: string
): OtlpWorkerPool {
  if (!pool) {
    const resolvedPath = workerPath ?? path.join(process.cwd(), "build", "otlpTransformWorker.cjs");
    pool = new OtlpWorkerPool(size, resolvedPath, pricingModels);
  }
  return pool;
}

export function broadcastPricingToPool(models: unknown[]) {
  pool?.broadcastPricing(models);
}
