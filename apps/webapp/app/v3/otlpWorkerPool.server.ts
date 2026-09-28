import { Worker } from "node:worker_threads";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
  /** Monotonic stamps (performance.now) drive every deadline decision so a wall-clock step can't shed or reap. */
  enqueuedAtMono: number;
  dispatchedAtMono?: number;
};

type ReapReason = "error" | "exit" | "timeout";

export type ReapEvent = {
  reason: ReapReason;
  taskAgeMs?: number;
  sinceDispatchMs?: number;
  queueDepth: number;
  aliveWorkers: number;
};

export type OtlpWorkerPoolOptions = {
  taskTimeoutMs?: number;
  respawnBaseMs?: number;
  respawnMaxMs?: number;
  /**
   * Observer for every reap, carrying the same fields as the warn log. It must not affect pool
   * liveness: it runs after the worker is terminated and the respawn is scheduled, and any
   * exception it throws or promise it rejects is logged and swallowed.
   */
  onReap?: (event: ReapEvent) => void | Promise<void>;
};

const TASK_TIMEOUT_MS = 30_000;
const MAX_QUEUE_DEPTH = 2_000;
const RESPAWN_BASE_MS = 500;
const RESPAWN_MAX_MS = 30_000;
const SHUTDOWN_DRAIN_MS = 5_000;
const STALE_FLOOR_MAX_MS = 1_000;
const SHED_LOG_INTERVAL_MS = 1_000;

// Hand-rolled worker_threads pool: one in-flight task per worker so CPU-bound transforms run
// fully in parallel. The main thread stays the only DB reader and broadcasts pricing to workers.
export class OtlpWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: number[] = [];
  private readonly tasks = new Map<number, Task>();
  private readonly busyByWorker = new Map<Worker, Task>();
  private readonly computeTimers = new Map<Worker, NodeJS.Timeout>();
  private nextId = 1;
  private consecutiveFailures = 0;
  private isShuttingDown = false;
  private latestPricingModels: unknown[];
  private readonly taskTimeoutMs: number;
  private readonly respawnBaseMs: number;
  private readonly respawnMaxMs: number;
  private readonly staleFloorMs: number;
  private readonly onReap?: (event: ReapEvent) => void | Promise<void>;
  private shedInWindow = 0;
  private shedWindowStartMono = 0;
  private lastShedMono = 0;
  private shedFlushTimer?: NodeJS.Timeout;

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
    meter?: Meter,
    options?: OtlpWorkerPoolOptions
  ) {
    this.latestPricingModels = pricingModels;
    this.taskTimeoutMs = options?.taskTimeoutMs ?? TASK_TIMEOUT_MS;
    this.respawnBaseMs = options?.respawnBaseMs ?? RESPAWN_BASE_MS;
    this.respawnMaxMs = options?.respawnMaxMs ?? RESPAWN_MAX_MS;
    this.staleFloorMs = Math.min(STALE_FLOOR_MAX_MS, this.taskTimeoutMs / 10);
    this.onReap = options?.onReap;
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

  /**
   * A task that already timed out for its caller recorded its outcome and duration then; its
   * compute time only becomes known when the worker finally replies, and skipping it would drop
   * exactly the slow samples from the compute histogram.
   */
  #recordLateCompute(task: Task, computeMs: number): void {
    this._computeDurationHistogram?.record(computeMs, this._kindAttrs[task.message.kind]);
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
        const inFlight = this.busyByWorker.get(worker);
        this.busyByWorker.delete(worker);
        this.#clearComputeTimer(worker);
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
        } else if (inFlight?.message.id === msg.id && msg.computeMs !== undefined) {
          this.#recordLateCompute(inFlight, msg.computeMs);
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
    this.#clearComputeTimer(worker);

    const now = performance.now();
    const inFlight = this.busyByWorker.get(worker);
    this.busyByWorker.delete(worker);
    if (inFlight !== undefined && this.tasks.has(inFlight.message.id)) {
      clearTimeout(inFlight.timer);
      this.tasks.delete(inFlight.message.id);
      this.#recordTaskEnd(inFlight, "crash");
      inFlight.reject(error);
    }

    this._respawnsCounter?.add(1, { reason });
    const event: ReapEvent = {
      reason,
      queueDepth: this.queue.length,
      aliveWorkers: this.workers.length,
      taskAgeMs: inFlight === undefined ? undefined : Math.round(now - inFlight.enqueuedAtMono),
      sinceDispatchMs:
        inFlight?.dispatchedAtMono === undefined
          ? undefined
          : Math.round(now - inFlight.dispatchedAtMono),
    };
    logger.warn("OtlpWorkerPool reaped worker", { ...event, error: error.message });
    void worker.terminate().catch(() => {});
    this.scheduleRespawn();
    this.#notifyReap(event);
  }

  #notifyReap(event: ReapEvent): void {
    if (this.onReap === undefined) return;
    try {
      const result = this.onReap(event);
      if (result !== undefined && typeof result.then === "function") {
        result.then(undefined, (thrown) => this.#logObserverError(thrown));
      }
    } catch (thrown) {
      this.#logObserverError(thrown);
    }
  }

  #logObserverError(thrown: unknown): void {
    logger.error("OtlpWorkerPool onReap observer threw", {
      error: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }

  #clearComputeTimer(worker: Worker) {
    const timer = this.computeTimers.get(worker);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.computeTimers.delete(worker);
  }

  /**
   * A dispatched task whose caller deadline passed is not evidence the worker is stuck: it may
   * have sat in the queue for most of its budget. Give the worker the rest of a full compute
   * budget for it, and only reap if it still hasn't replied by then. The worker's reply (or a
   * crash reap) clears this timer.
   */
  #armComputeTimer(worker: Worker, task: Task, delayMs: number) {
    this.#clearComputeTimer(worker);
    const timer = setTimeout(
      () => {
        this.computeTimers.delete(worker);
        if (this.busyByWorker.get(worker) !== task) return;
        const remainingMs = this.taskTimeoutMs - (performance.now() - task.dispatchedAtMono!);
        if (remainingMs > 0) {
          this.#armComputeTimer(worker, task, remainingMs);
          return;
        }
        this.reap(
          worker,
          new Error(`otlp worker stuck for ${this.taskTimeoutMs}ms on a single task`),
          "timeout"
        );
      },
      Math.max(1, Math.ceil(delayMs))
    );
    this.computeTimers.set(worker, timer);
  }

  private scheduleRespawn() {
    if (this.isShuttingDown) return;
    if (this.workers.length >= this.size) return;
    const delay = Math.min(this.respawnBaseMs * 2 ** this.consecutiveFailures, this.respawnMaxMs);
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

  /**
   * Hand queued tasks to idle workers in FIFO order, shedding any task whose remaining budget is
   * below the stale floor so a free worker starts on something it can still finish. The floor is
   * a small fraction of the timeout, so only tasks whose deadline is effectively already here are
   * dropped; everything else keeps its FIFO turn.
   */
  private drain() {
    const now = performance.now();
    while (this.queue.length > 0 && this.idle.length > 0) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task) continue;
      const remainingMs = task.enqueuedAtMono + this.taskTimeoutMs - now;
      if (remainingMs < this.staleFloorMs) {
        this.#shed(task, remainingMs, now);
        continue;
      }
      const worker = this.idle.pop()!;
      task.worker = worker;
      task.dispatchedAtMono = now;
      this.busyByWorker.set(worker, task);
      worker.postMessage(task.message, task.transfer);
    }
  }

  /**
   * Sheds are aggregated into at most one debug line per second; each line carries the count and
   * the span between the first and last shed it covers.
   */
  #shed(task: Task, remainingMs: number, now: number) {
    clearTimeout(task.timer);
    this.tasks.delete(task.message.id);
    this.#recordTaskEnd(task, "stale");
    task.reject(
      new Error(
        `otlp worker task shed after ${Math.round(now - task.enqueuedAtMono)}ms in queue with ${Math.max(
          0,
          Math.round(remainingMs)
        )}ms of ${this.taskTimeoutMs}ms budget left`
      )
    );
    if (this.shedInWindow === 0) this.shedWindowStartMono = now;
    this.lastShedMono = now;
    this.shedInWindow++;
    if (this.shedFlushTimer !== undefined) return;
    this.shedFlushTimer = setTimeout(() => {
      this.shedFlushTimer = undefined;
      logger.debug("OtlpWorkerPool shed stale tasks", {
        shed: this.shedInWindow,
        windowMs: Math.round(this.lastShedMono - this.shedWindowStartMono),
        queueDepth: this.queue.length,
        aliveWorkers: this.workers.length,
      });
      this.shedInWindow = 0;
    }, SHED_LOG_INTERVAL_MS);
    this.shedFlushTimer.unref();
  }

  /**
   * The caller's budget (queue wait + compute) is spent, so reject it now. Whether the worker is
   * at fault depends on how long it has held the task: reap only once it has had a full timeout
   * of compute time on this one task, otherwise let it finish via the compute timer and return to
   * the idle set on reply. The task is removed here, so neither path can double-reject.
   */
  private onTimeout(id: number) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.delete(id);
    this.#recordTaskEnd(task, "timeout");
    const err = new Error(`otlp worker task timed out after ${this.taskTimeoutMs}ms`);
    if (task.worker !== undefined && task.dispatchedAtMono !== undefined) {
      const remainingComputeMs = this.taskTimeoutMs - (performance.now() - task.dispatchedAtMono);
      if (remainingComputeMs <= 0) {
        this.reap(task.worker, err, "timeout");
      } else {
        this.#armComputeTimer(task.worker, task, remainingComputeMs);
      }
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
      const timer = setTimeout(() => this.onTimeout(id), this.taskTimeoutMs);
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
        enqueuedAtMono: performance.now(),
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
    for (const timer of this.computeTimers.values()) clearTimeout(timer);
    this.computeTimers.clear();
    clearTimeout(this.shedFlushTimer);
    this.shedFlushTimer = undefined;
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
