import { Worker } from "node:worker_threads";
import path from "node:path";
import {
  getMeter,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from "@internal/tracing";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";

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
  // Wall-clock stamp at enqueue; the task-duration histogram measures enqueue -> terminal state
  // (queue wait + worker compute), so the gap from the worker-reported compute time is queue wait.
  enqueuedAt: number;
};

type ReapReason = "error" | "exit" | "timeout";

const TASK_TIMEOUT_MS = 30_000;
const MAX_QUEUE_DEPTH = 2_000;
const RESPAWN_BASE_MS = 500;
const RESPAWN_MAX_MS = 30_000;
const SHUTDOWN_DRAIN_MS = 5_000;

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
  private isShuttingDown = false;
  private latestPricingModels: unknown[];

  // Pre-allocated per-kind {kind} attribute objects so the per-task record path never allocates.
  private readonly _kindAttrs: Record<TransformKind, { kind: TransformKind }> = {
    traces: { kind: "traces" },
    logs: { kind: "logs" },
    metrics: { kind: "metrics" },
  };
  private _taskDurationHistogram?: Histogram;
  private _computeDurationHistogram?: Histogram;
  private _tasksCounter?: Counter;
  private _respawnsCounter?: Counter;

  constructor(
    private readonly size: number,
    private readonly workerPath: string,
    pricingModels: unknown[],
    meter?: Meter
  ) {
    this.latestPricingModels = pricingModels;
    this.#setupOtelMetrics(meter);
    for (let i = 0; i < size; i++) this.spawn();
    logger.info("OtlpWorkerPool started", { size, workerPath });
  }

  #setupOtelMetrics(meterOverride: Meter | undefined): void {
    const meter = meterOverride ?? getMeter("ingest");

    this._taskDurationHistogram = meter.createHistogram("ingest.worker_pool.task.duration", {
      description: "Enqueue-to-completion time for a transform task (queue wait + worker compute)",
      unit: "ms",
    });
    this._computeDurationHistogram = meter.createHistogram("ingest.worker_pool.compute.duration", {
      description: "Worker-reported compute time (decode + convert + enrich)",
      unit: "ms",
    });
    this._tasksCounter = meter.createCounter("ingest.worker_pool.tasks", {
      description: "Transform tasks by terminal outcome",
      unit: "tasks",
    });
    this._respawnsCounter = meter.createCounter("ingest.worker_pool.respawns", {
      description: "Worker respawns by reason",
      unit: "respawns",
    });

    // Pull-based gauges: read at export time only, zero hot-path cost.
    const queueDepthGauge: ObservableGauge = meter.createObservableGauge(
      "ingest.worker_pool.queue_depth",
      { description: "Tasks queued and awaiting a free worker", unit: "tasks" }
    );
    const workersGauge: ObservableGauge = meter.createObservableGauge(
      "ingest.worker_pool.workers",
      {
        description: "Pool workers by state (alive workers, idle workers)",
        unit: "workers",
      }
    );

    meter.addBatchObservableCallback(
      (result) => {
        result.observe(queueDepthGauge, this.queue.length);
        result.observe(workersGauge, this.workers.length, { state: "alive" });
        result.observe(workersGauge, this.idle.length, { state: "idle" });
      },
      [queueDepthGauge, workersGauge]
    );
  }

  #recordTaskEnd(task: Task, outcome: string, computeMs?: number): void {
    this._taskDurationHistogram?.record(
      Date.now() - task.enqueuedAt,
      this._kindAttrs[task.message.kind]
    );
    this._tasksCounter?.add(1, { kind: task.message.kind, outcome });
    if (computeMs !== undefined) {
      this._computeDurationHistogram?.record(computeMs, this._kindAttrs[task.message.kind]);
    }
  }

  private spawn() {
    const worker = new Worker(this.workerPath, {
      workerData: { pricingModels: this.latestPricingModels },
    });

    worker.on(
      "message",
      (msg: { id: number; ok: boolean; result?: any; error?: string; computeMs?: number }) => {
        if (this.workers.indexOf(worker) === -1) return; // late message from an already-reaped worker
        this.consecutiveFailures = 0;
        this.busyByWorker.delete(worker);
        const task = this.tasks.get(msg.id);
        if (task) {
          clearTimeout(task.timer);
          this.tasks.delete(msg.id);
          if (msg.ok) {
            this.#recordTaskEnd(task, "ok", msg.computeMs);
            task.resolve(msg.result);
          } else {
            this.#recordTaskEnd(task, "error", msg.computeMs);
            task.reject(new Error(msg.error ?? "otlp worker error"));
          }
        }
        this.release(worker);
      }
    );

    worker.on("error", (error) => {
      logger.error("OtlpWorkerPool worker error", { error: error.message });
      this.reap(worker, error, "error");
    });

    worker.on("exit", (code) => {
      // Any exit means this worker is gone, including a clean exit while it held a task; reap()
      // no-ops if the worker was already removed (e.g. error fired first).
      this.reap(worker, new Error(`otlp worker exited with code ${code}`), "exit");
    });

    this.workers.push(worker);
    this.idle.push(worker);
  }

  // On crash/timeout: fail the worker's in-flight task (if still pending), drop the worker, and
  // respawn with exponential backoff so a persistently failing worker can't tight-loop.
  private reap(worker: Worker, error: Error, reason: ReapReason) {
    const wi = this.workers.indexOf(worker);
    if (wi === -1) return; // already reaped (error + exit can both fire for one crash)
    this.workers.splice(wi, 1);

    const ii = this.idle.indexOf(worker);
    if (ii !== -1) this.idle.splice(ii, 1);

    const inFlightId = this.busyByWorker.get(worker);
    this.busyByWorker.delete(worker);
    if (inFlightId !== undefined) {
      const task = this.tasks.get(inFlightId);
      if (task) {
        clearTimeout(task.timer);
        this.tasks.delete(inFlightId);
        // A timed-out task already recorded its own end + was removed from the map, so this only
        // fires for a crash that killed a task mid-flight.
        this.#recordTaskEnd(task, "crash");
        task.reject(error);
      }
    }

    this._respawnsCounter?.add(1, { reason });
    void worker.terminate().catch(() => {});
    this.scheduleRespawn();
  }

  private scheduleRespawn() {
    if (this.isShuttingDown) return;
    if (this.workers.length >= this.size) return;
    const delay = Math.min(RESPAWN_BASE_MS * 2 ** this.consecutiveFailures, RESPAWN_MAX_MS);
    this.consecutiveFailures++;
    setTimeout(() => {
      if (this.isShuttingDown) return;
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
    this.#recordTaskEnd(task, "timeout");
    const err = new Error(`otlp worker task timed out after ${TASK_TIMEOUT_MS}ms`);
    if (task.worker) {
      // Dispatched to a stuck worker: reap it. The task is already removed, so reap won't
      // double-reject.
      this.reap(task.worker, err, "timeout");
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
    if (this.isShuttingDown) {
      return Promise.reject(new Error("otlp worker pool is shutting down"));
    }
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      this._tasksCounter?.add(1, { kind, outcome: "rejected" });
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
        enqueuedAt: Date.now(),
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

  // Stop taking new work, let in-flight tasks finish (bounded), then terminate every worker.
  // Terminated workers fire "exit", but reap() no-ops on an already-removed worker, and the
  // isShuttingDown guard stops any pending respawn, so shutdown is quiet.
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info("OtlpWorkerPool shutting down", {
      workers: this.workers.length,
      inFlight: this.tasks.size,
    });

    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while (this.tasks.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const workers = this.workers.splice(0);
    this.idle.length = 0;
    this.queue.length = 0;
    this.busyByWorker.clear();
    // Reject anything that didn't drain within the deadline.
    for (const [, task] of this.tasks) {
      clearTimeout(task.timer);
      task.reject(new Error("otlp worker pool shutting down"));
    }
    this.tasks.clear();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
  }
}

export function getOtlpWorkerPool(
  size: number,
  pricingModels: unknown[],
  workerPath?: string,
  meter?: Meter
): OtlpWorkerPool {
  // singleton() stores on globalThis so the pool (and its worker threads) survive Remix HMR in dev
  // rather than leaking an orphaned pool + workers on every reload.
  return singleton("otlpWorkerPool", () => {
    const resolvedPath = workerPath ?? path.join(process.cwd(), "build", "otlpTransformWorker.cjs");
    const created = new OtlpWorkerPool(size, resolvedPath, pricingModels, meter);
    // Drain + terminate workers on shutdown so they aren't force-killed mid-task (which would
    // churn respawns). The main thread stays the only DB writer, so inserts are unaffected.
    signalsEmitter.on("SIGTERM", () => void created.shutdown());
    signalsEmitter.on("SIGINT", () => void created.shutdown());
    return created;
  });
}
