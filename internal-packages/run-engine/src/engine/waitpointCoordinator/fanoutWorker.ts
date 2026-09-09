import type { Counter, Histogram, Meter, ObservableGauge } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { nanoid } from "nanoid";
import pMap from "p-map";
import {
  acknowledgeablePrefix,
  assertFanoutWorkerLimits,
  DEFAULT_FANOUT_RETRY_POLICY,
  effectiveDeliveryConcurrency,
  type FanoutRetryPolicy,
  type WatcherDeliveryOutcome,
} from "./fanoutPolicy.js";
import { FANOUT_PARTITION_COUNT } from "./keys.js";
import { encodeCompletionForDelivery } from "./storeCoordinator.js";
import type {
  EncodedWaitpointCompletion,
  FanoutPageEntry,
  WaitpointStoreCoordinator,
} from "./storeCoordinator.js";

/**
 * Deterministic interception points, in the spirit of `RaceSimulationSystem`.
 *
 * Present so that "the worker died before delivering", "after delivering but before
 * acknowledging" and "while another worker reclaimed the entry" are expressible as a
 * barrier or a throw rather than as a sleep racing the poll interval. Nothing sets them in
 * production; an unset hook is not called.
 */
export type FanoutWorkerHooks = {
  /** Outside the delivery guard: a throw here models the process dying after claiming. */
  onPageClaimed?: (ctx: {
    waitpointId: string;
    pageSize: number;
    attempts: number;
  }) => Promise<void>;
  /** Inside the delivery guard: a throw here models one delivery failing and retrying. */
  beforeDeliver?: (ctx: { waitpointId: string; runId: string; index: number }) => Promise<void>;
  afterDeliver?: (ctx: {
    waitpointId: string;
    runId: string;
    index: number;
    outcome: WatcherDeliveryOutcome;
  }) => Promise<void>;
  /** Outside the delivery guard: a throw here models dying after delivering, before acking. */
  beforeAck?: (ctx: { waitpointId: string; count: number }) => Promise<void>;
};

export type WaitpointFanoutWorkerOptions = {
  coordinator: WaitpointStoreCoordinator;
  /**
   * Defaults to FALSE. The store coordinator has no live caller while store-resident
   * waitpoint minting is off, so a worker that started itself would be the only moving part in an
   * otherwise inert subsystem. `start()` is a no-op until a rollout explicitly enables it.
   */
  enabled?: boolean;
  /** Identifies this worker's claims. Distinct per process. */
  workerId?: string;
  /** Watchers delivered per claimed page. */
  pageSize?: number;
  /** How long a claim survives without progress before another worker may take it. */
  leaseMs?: number;
  pollIntervalMs?: number;
  /** Pages one visit will drain before yielding the waitpoint back to the index. */
  maxPagesPerVisit?: number;
  /** Waitpoints taken from one partition's due index per tick. */
  dueBatchSize?: number;
  /**
   * How far to defer a hint whose record is still PENDING. Bounds how long an abandoned
   * pre-flip hint can occupy a slot in the bounded sweep, and is the most a completion
   * racing that deferral can be delayed by.
   */
  hintGraceMs?: number;
  /** Concurrent run-shard deliveries within one page. */
  deliveryConcurrency?: number;
  retryPolicy?: Partial<FanoutRetryPolicy>;
  logger?: Logger;
  meter?: Meter;
  clock?: () => number;
  hooks?: FanoutWorkerHooks;
};

/**
 * Derived from the meter rather than imported: `@internal/tracing` does not re-export the
 * OTel callback type, and disposal has to hold the callback at exactly the type
 * `removeBatchObservableCallback` expects for identity-based removal to typecheck.
 */
type BatchObservableCallback = Parameters<Meter["addBatchObservableCallback"]>[0];

export type FanoutVisitSummary = {
  waitpointId: string;
  pages: number;
  delivered: number;
  duplicates: number;
  staleWatchers: number;
  rejected: number;
  failures: number;
  outcome:
    | "drained"
    | "more"
    | "released"
    | "quarantined"
    | "absent"
    | "pending-record"
    | "notdue"
    | "busy"
    | "done"
    | "lost";
  /** Set when the visit was refused as `notdue`: the authoritative earliest claim time. */
  notBefore?: number;
  /**
   * Set when the STORED envelope could not be encoded for delivery — over a size limit this
   * worker enforces. The outcome is an ordinary failure release, so the entry backs off and
   * quarantines; this flag says a retry cannot help.
   */
  undeliverable?: boolean;
};

export type FanoutTickSummary = {
  visits: FanoutVisitSummary[];
  scanned: number;
};

const DEFAULTS = {
  pageSize: 100,
  leaseMs: 30_000,
  pollIntervalMs: 1_000,
  maxPagesPerVisit: 10,
  dueBatchSize: 50,
  hintGraceMs: 5_000,
  deliveryConcurrency: 10,
};

/**
 * Delivers frozen waitpoint completions to the shards of the runs watching them, in bounded
 * pages, at least once.
 *
 * The durable record of owed work is the fanout entry on the waitpoint's own partition,
 * written atomically with the completion. This worker discovers entries through the
 * partitioned due index, claims one at a time under a lease, delivers a page, and only then
 * retires that page from the queue. Every step is therefore replayable: a worker that dies
 * anywhere costs at most a duplicate delivery, whose run-side effect is idempotent.
 *
 * Cross-shard work is deliberately here and not in Lua — each delivery lands on a different
 * run's slot.
 */
export class WaitpointFanoutWorker {
  private readonly coordinator: WaitpointStoreCoordinator;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly hooks: FanoutWorkerHooks;
  private readonly retryPolicy: FanoutRetryPolicy;
  private readonly options: Required<
    Pick<
      WaitpointFanoutWorkerOptions,
      | "pageSize"
      | "leaseMs"
      | "pollIntervalMs"
      | "maxPagesPerVisit"
      | "dueBatchSize"
      | "hintGraceMs"
      | "deliveryConcurrency"
    >
  >;

  readonly enabled: boolean;
  readonly workerId: string;

  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private draining = false;
  /** The single stop operation; also what makes start() refuse mid-drain. */
  private stopping?: Promise<void>;
  private disposed = false;
  /** The single disposal operation every caller of `dispose()` awaits. */
  private disposal?: Promise<void>;
  /**
   * Metric collections that have begun their asynchronous backlog read. `dispose()` awaits
   * these, so a caller following the documented dispose-then-close order cannot close the
   * coordinator under a live read.
   */
  private readonly activeCollections = new Set<Promise<void>>();
  /** Direct-drive runOnce()/visit() calls already admitted; dispose() awaits these too. */
  private readonly activeWork = new Set<Promise<void>>();
  // Held so disposal can unregister the EXACT pair it registered. An OTel meter keys removal
  // on callback identity plus the observable set, so neither may be reconstructed.
  private metricsRegistration?: {
    meter: Meter;
    callback: BatchObservableCallback;
    observables: ObservableGauge[];
  };

  private readonly metrics: {
    watchersDelivered?: Counter;
    pagesProcessed?: Counter;
    entriesReclaimed?: Counter;
    retries?: Counter;
    staleWatchers?: Counter;
    deliveryFailures?: Counter;
    quarantined?: Counter;
    deliveryLatency?: Histogram;
    backlog?: ObservableGauge;
    backlogAge?: ObservableGauge;
    quarantineDepth?: ObservableGauge;
  } = {};

  constructor(options: WaitpointFanoutWorkerOptions) {
    this.coordinator = options.coordinator;
    this.enabled = options.enabled ?? false;
    this.workerId = options.workerId ?? `wpfan_${nanoid(10)}`;
    this.logger = options.logger ?? new Logger("WaitpointFanoutWorker", "debug");
    this.clock = options.clock ?? Date.now;
    this.hooks = options.hooks ?? {};
    this.retryPolicy = { ...DEFAULT_FANOUT_RETRY_POLICY, ...options.retryPolicy };
    this.options = {
      pageSize: options.pageSize ?? DEFAULTS.pageSize,
      leaseMs: options.leaseMs ?? DEFAULTS.leaseMs,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      maxPagesPerVisit: options.maxPagesPerVisit ?? DEFAULTS.maxPagesPerVisit,
      dueBatchSize: options.dueBatchSize ?? DEFAULTS.dueBatchSize,
      hintGraceMs: options.hintGraceMs ?? DEFAULTS.hintGraceMs,
      deliveryConcurrency: options.deliveryConcurrency ?? DEFAULTS.deliveryConcurrency,
    };

    assertFanoutWorkerLimits({ ...this.options, ...this.retryPolicy });

    if (options.meter) {
      this.#initializeMetrics(options.meter);
    }
  }

  /**
   * Begin sweeping on a timer. Idempotent, and restartable after `stop()`.
   *
   * A no-op when the worker is disabled — that flag governs SELF-scheduling only, never the
   * direct-drive methods below.
   */
  start(): void {
    this.#assertNotDisposed("start");
    // Loudly, not silently: a caller that believes it restarted while a stop is draining
    // would be running against a worker that is about to finish stopping.
    if (this.stopping) {
      throw new Error(
        `WaitpointFanoutWorker: start() called while stop() is in progress (worker ${this.workerId})`
      );
    }
    if (!this.enabled) {
      this.logger.debug("Waitpoint fanout worker is disabled; not starting", {
        workerId: this.workerId,
      });
      return;
    }
    if (this.timer) {
      return;
    }

    // Cleared here rather than at the end of stop(), so a stop still in flight cannot be
    // overtaken: an interval only exists again once this method has claimed the slot below,
    // and every tick reads `draining` at the moment it fires.
    this.draining = false;

    const tick = async () => {
      // One tick at a time. Overlapping sweeps would contend on their own claims and read
      // the same due page twice for no gain.
      if (this.inFlight || this.draining) {
        return;
      }
      this.inFlight = this.runOnce()
        .then(() => undefined)
        .catch((error) => {
          this.logger.error("Waitpoint fanout tick failed", { workerId: this.workerId, error });
        })
        .finally(() => {
          this.inFlight = undefined;
        });
      await this.inFlight;
    };

    this.timer = setInterval(() => void tick(), this.options.pollIntervalMs);
    // Long-lived interval on a background worker: keep it off the event loop's ref count so
    // it never holds a process open on shutdown.
    this.timer.unref();
  }

  /**
   * Stop sweeping and wait for the tick in flight to finish.
   *
   * Awaiting it matters: a tick abandoned mid-page leaves a claim held until its lease
   * lapses, which delays every watcher behind it by the lease duration for no reason.
   */
  async stop(): Promise<void> {
    // One shared stop, memoised like disposal. `start()` refuses while this is outstanding,
    // so a restart cannot clear `draining` and install a new timer underneath a stop that is
    // still awaiting the active tick — which used to let that stop return while fanout work
    // carried on, and the caller then close the coordinator under it.
    if (this.stopping) {
      return this.stopping;
    }

    // Synchronous, before any await: the tick reads `draining` when it fires, and no new
    // timer can appear because `start()` now sees `stopping`.
    this.draining = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.stopping = (async () => {
      try {
        await this.inFlight;
      } finally {
        // Cleared only once the tick has settled, which is what makes a later `start()`
        // legal again. In a finally so a thrown tick cannot wedge the worker stopped.
        this.stopping = undefined;
      }
    })();

    return this.stopping;
  }

  /**
   * Terminal shutdown: stop sweeping and unregister the metrics callback.
   *
   * Separate from `stop()` on purpose, because `stop()` has to stay restartable. The batch
   * observable callback closes over this worker and its coordinator, so a meter that still
   * holds it will call `fanoutBacklog()` on the next collection — against a Redis client the
   * caller has since closed. Disposal is the only point at which that reference can be
   * given up, so it has to be its own step rather than a side effect of stopping.
   *
   * Idempotent, and terminal: `start`, `runOnce` and `visit` all refuse afterwards, so a
   * disposed worker cannot be revived into doing work with no metrics attached.
   *
   * Call it BEFORE closing the coordinator.
   */
  async dispose(): Promise<void> {
    // ONE shared operation, not a flag plus a partial re-run. A second caller that only
    // drained collections could return while the first was still inside stop() awaiting the
    // worker tick, and then close the coordinator under it. Memoising the whole operation
    // means every caller waits for the same completion.
    this.disposal ??= this.#dispose();
    return this.disposal;
  }

  async #dispose(): Promise<void> {
    // Synchronous, before the first await, so start/runOnce/visit refuse from the moment
    // dispose() is called rather than from whenever this resumes.
    this.disposed = true;

    // Unregister BEFORE waiting, so no new collection can start while we do.
    const registration = this.metricsRegistration;
    if (registration) {
      this.metricsRegistration = undefined;
      registration.meter.removeBatchObservableCallback(
        registration.callback,
        registration.observables
      );
    }

    await this.stop();
    await this.#drain();
  }

  /**
   * Track one direct-drive operation for the lifetime of its Redis work.
   *
   * `#assertNotDisposed` guards ENTRY only, so an operation already past it kept running
   * while `dispose()` returned — and `stop()` awaits `inFlight`, which only timer-started
   * ticks ever set. A direct `runOnce()` or `visit()` therefore had nothing holding disposal
   * open, and its caller could close the coordinator mid-page, abandoning a held claim until
   * the lease lapsed.
   */
  #track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.then(
      () => undefined,
      () => undefined
    );
    this.activeWork.add(tracked);
    // Removed on both paths: a rejected operation left in the set would make every later
    // dispose() await a promise nobody settles again.
    void tracked.finally(() => this.activeWork.delete(tracked));
    return operation;
  }

  async #drain(): Promise<void> {
    // Snapshotted and looped: settling one entry cannot admit another — `disposed` is set and
    // the metric callback is unregistered — but one in flight when the snapshot was taken may
    // still be mid-await, so drain until both sets are empty. `allSettled`, so a
    // caller-owned rejection cannot prevent safe disposal.
    while (this.activeCollections.size > 0 || this.activeWork.size > 0) {
      await Promise.allSettled([...this.activeCollections, ...this.activeWork]);
    }
  }

  #assertNotDisposed(operation: string): void {
    if (this.disposed) {
      throw new Error(
        `WaitpointFanoutWorker: ${operation}() called after dispose() (worker ${this.workerId})`
      );
    }
  }

  /**
   * One complete pass: sweep every partition's due index and visit what it names.
   *
   * The unit of determinism for tests, and the direct-drive entry point. Nothing here waits
   * on a clock, so a caller drives the worker by invoking this rather than by sleeping past
   * a poll interval.
   *
   * Deliberately NOT gated on `enabled`, and this is a contract rather than an oversight.
   * `enabled` governs one thing: whether `start()` puts this worker on a timer and lets it
   * sweep on its own. A direct call is the opposite of that — an explicit, deterministic
   * execution by a test, the harness, or an operator running a one-off drain — and it is the
   * only way any of them can drive the worker at all, since none of them may wait on a poll
   * interval. Gating it would leave those callers no entry point and would make a disabled
   * worker's behaviour depend on which method you reached for.
   *
   * Inertness in production therefore comes from nothing constructing a worker, not from
   * this flag. The engine-level keyspace test asserts that directly.
   */
  async runOnce(now = this.clock()): Promise<FanoutTickSummary> {
    this.#assertNotDisposed("runOnce");
    return this.#track(this.#runOnce(now));
  }

  async #runOnce(now: number): Promise<FanoutTickSummary> {
    const visits: FanoutVisitSummary[] = [];
    let scanned = 0;

    for (let partition = 0; partition < FANOUT_PARTITION_COUNT; partition++) {
      const due = await this.coordinator.dueFanoutEntries({
        partition,
        limit: this.options.dueBatchSize,
        now,
      });
      scanned += due.length;

      for (const waitpointId of due) {
        // The captured `now` selects what is due; the visit itself re-samples, because a
        // multi-page drain can outlive the instant it started. The PRIVATE implementation,
        // so a tick's visits are not tracked a second time inside the tick's own entry.
        visits.push(await this.#visit(waitpointId));
      }
    }

    return { visits, scanned };
  }

  /**
   * Drive one waitpoint's fanout as far as this visit is allowed to.
   *
   * Direct-drive, like `runOnce`, and ungated on `enabled` for the same reason.
   *
   * Bounded twice over: each page is at most `pageSize` watchers, and a visit drains at
   * most `maxPagesPerVisit` pages before handing the waitpoint back to the index. Neither
   * bound is advisory — a waitpoint with a million watchers occupies the worker for
   * `pageSize * maxPagesPerVisit` deliveries and then yields.
   */
  async visit(waitpointId: string): Promise<FanoutVisitSummary> {
    this.#assertNotDisposed("visit");
    return this.#track(this.#visit(waitpointId));
  }

  async #visit(waitpointId: string): Promise<FanoutVisitSummary> {
    const summary: FanoutVisitSummary = {
      waitpointId,
      pages: 0,
      delivered: 0,
      duplicates: 0,
      staleWatchers: 0,
      rejected: 0,
      failures: 0,
      outcome: "absent",
    };
    let lastEpoch: string | undefined;

    for (let page = 0; page < this.options.maxPagesPerVisit; page++) {
      const claimedAt = this.clock();
      const claim = await this.coordinator.claimFanoutPage({
        waitpointId,
        workerId: this.workerId,
        pageSize: this.options.pageSize,
        leaseMs: this.options.leaseMs,
        now: claimedAt,
      });

      if (claim.outcome === "absent" || claim.outcome === "done") {
        // Either the hint outlived its work or nothing was ever owed. Retiring the hint is
        // how a spurious one — the price of filing it before the completion flip — is
        // reclaimed.
        summary.outcome = claim.outcome;
        await this.coordinator.dropFanoutHint(waitpointId);
        return summary;
      }

      if (claim.outcome === "pending-record") {
        // A completion filed this hint and has not flipped the record yet. Never RETIRE it —
        // that would strand the entry the flip is about to create. But leaving the score
        // alone lets an abandoned hint, from a completion that filed one and then failed,
        // sit at the head of every bounded sweep forever and starve real fanout behind it.
        //
        // So it is deferred by a bounded grace, with update-only semantics so the deferral
        // cannot resurrect an entry another worker retired. A completion racing this either
        // wins — its post-flip schedule is unconditional and lands on `now` — or loses and
        // pays the grace once.
        summary.outcome = "pending-record";
        await this.coordinator.rescheduleFanoutVisit(
          waitpointId,
          this.clock() + this.options.hintGraceMs
        );
        return summary;
      }

      if (claim.outcome === "notdue") {
        // Backing off. The refusal came from the entry itself, so this is the authoritative
        // time; repairing the index to it keeps sweeps from probing early, and a stale index
        // score could never have produced an early CLAIM in any case.
        summary.outcome = "notdue";
        summary.notBefore = claim.notBefore;
        await this.coordinator.repairFanoutSchedule(waitpointId, claim.notBefore);
        return summary;
      }

      if (claim.outcome === "busy") {
        // Another worker holds a live claim. Defer this entry to the moment that claim
        // lapses, which is the earliest it could become actionable. Leaving its old score
        // in place lets a full page of busy entries sit at the head of the bounded due
        // query and hide runnable entries behind them.
        summary.outcome = "busy";
        await this.coordinator.rescheduleFanoutVisit(
          waitpointId,
          Math.max(claim.leaseExpiresAt, this.clock() + 1)
        );
        return summary;
      }

      if (claim.outcome === "quarantined") {
        summary.outcome = "quarantined";
        await this.coordinator.quarantineFanoutEntry(waitpointId, this.clock());
        return summary;
      }

      if (claim.reclaimed) {
        this.metrics.entriesReclaimed?.add(1);
        this.logger.warn("Reclaimed an abandoned waitpoint fanout entry", {
          waitpointId,
          workerId: this.workerId,
          attempts: claim.attempts,
        });
      }

      lastEpoch = claim.epoch;
      summary.pages++;
      this.metrics.pagesProcessed?.add(1);
      await this.hooks.onPageClaimed?.({
        waitpointId,
        pageSize: claim.page.length,
        attempts: claim.attempts,
      });

      // A COMPLETED record with no envelope is legitimate — see the FINISHED-healing path —
      // so an absent completion is delivered as an absent one, not skipped.
      const completion = claim.completion ?? {
        completedAt: new Date(claim.completedAtMs || claimedAt).toISOString(),
        outputType: "application/json",
        outputIsError: false,
        output: null,
      };

      // Serialized ONCE per claimed page, then reused for every watcher on it. The envelope
      // each run receives is byte-identical to before; what is gone is one full
      // `JSON.stringify` of the completion per delivery, which on a wide page was `pageSize`
      // serializations of the same object.
      //
      // The catch is the POISON-ROW path, and it has to be here rather than left to escape.
      // A stored envelope can fail this check without any caller doing anything wrong: an
      // older worker wrote it under a higher ceiling, or the ceiling was lowered under a
      // rolling deploy. Letting the throw escape `visit` left the claim held to lease expiry
      // with the failure streak untouched, so the same record was re-claimed forever and
      // never reached quarantine — an unbounded loop for the newer worker.
      //
      // Counted as a delivery failure instead, which puts it on the existing machinery: the
      // streak increments, the backoff grows, and at `maxFailures` the entry is quarantined
      // out of the due index. `undeliverable` marks WHY for an operator, because a backoff
      // that will never succeed is worth telling apart from one that might.
      let encoded: EncodedWaitpointCompletion;
      try {
        encoded = encodeCompletionForDelivery(completion, `fanout:${waitpointId}`);
      } catch (error) {
        this.logger.error("Waitpoint fanout completion is undeliverable", {
          waitpointId,
          workerId: this.workerId,
          error,
        });
        this.metrics.deliveryFailures?.add(1);
        summary.failures += 1;
        summary.undeliverable = true;
        summary.outcome = await this.#backOff(waitpointId, claim.epoch, this.clock());
        return summary;
      }

      const outcomes = await this.#deliverPage(waitpointId, claim.page, encoded);
      this.#tally(summary, outcomes);

      if (claim.completedAtMs > 0 && this.metrics.deliveryLatency) {
        const latency = Math.max(0, this.clock() - claim.completedAtMs);
        for (const outcome of outcomes) {
          if (outcome === "delivered") {
            this.metrics.deliveryLatency.record(latency);
          }
        }
      }

      const ackCount = acknowledgeablePrefix(outcomes);
      const failed = ackCount < outcomes.length;

      // A zero-count acknowledgement is still worth making when the page came back empty:
      // an empty page means the queue is drained, and the ack is what records that. Skipping
      // it would hand the entry back to the index on every tick, forever.
      if (ackCount > 0 || claim.page.length === 0) {
        await this.hooks.beforeAck?.({ waitpointId, count: ackCount });
        // Sampled after the deliveries, which is the point: the ack renews nothing, but the
        // drain it may perform stamps a terminal window that must reflect now, not the
        // instant this visit began.
        const ack = await this.coordinator.acknowledgeFanoutPage({
          waitpointId,
          workerId: this.workerId,
          epoch: claim.epoch,
          count: ackCount,
          now: this.clock(),
        });

        if (ack.outcome === "lost") {
          // The lease lapsed and someone else owns the entry. Their claim redelivers this
          // page; stopping here is what keeps the two workers from trimming each other's
          // progress.
          summary.outcome = "lost";
          return summary;
        }
        if (ack.outcome === "absent") {
          summary.outcome = "absent";
          await this.coordinator.dropFanoutHint(waitpointId);
          return summary;
        }
        if (ack.outcome === "drained" && !failed) {
          summary.outcome = "drained";
          await this.coordinator.dropFanoutHint(waitpointId);
          return summary;
        }
      }

      if (failed) {
        // The claim's own fence, not the entry's current state: the ack above has already
        // released the claim, so the epoch is what still authorises this transition.
        summary.outcome = await this.#backOff(waitpointId, claim.epoch, this.clock());
        return summary;
      }
    }

    // Page budget spent with work left. Hand it straight back so another tick — or another
    // worker — picks up where this one stopped. A yield is not a failure, so it does not
    // count towards the give-up threshold.
    summary.outcome = "more";
    const yieldedAt = this.clock();
    if (lastEpoch) {
      await this.coordinator.releaseFanout({
        waitpointId,
        workerId: this.workerId,
        epoch: lastEpoch,
        action: "yield",
        now: yieldedAt,
      });
    }
    // Fenced: a yield wants prompt continuation, but not at the cost of undoing a backoff
    // another worker installed in the gap, and not by resurrecting an entry it drained.
    await this.coordinator.rescheduleFanoutVisit(waitpointId, yieldedAt);
    return summary;
  }

  async #deliverPage(
    waitpointId: string,
    page: FanoutPageEntry[],
    encoded: EncodedWaitpointCompletion
  ): Promise<WatcherDeliveryOutcome[]> {
    return pMap(
      page,
      async (entry, index): Promise<WatcherDeliveryOutcome> => {
        if (!entry.watcher) {
          this.metrics.staleWatchers?.add(1);
          return "stale-watcher";
        }

        const { runId, blockId } = entry.watcher;

        let outcome: WatcherDeliveryOutcome;
        try {
          // Inside the try, so a hook that throws models a delivery that FAILED and will be
          // retried. A hook that models the process dying belongs outside one — see
          // onPageClaimed and beforeAck.
          await this.hooks.beforeDeliver?.({ waitpointId, runId, index });

          const result = await this.coordinator.deliverEncodedCompletion({
            runId,
            blockId,
            waitpointId,
            encoded,
          });
          // `stale`, `terminal` and `acked` all mean the run's shard will refuse a
          // redelivery identically, so the watcher is retired rather than retried.
          outcome =
            result.outcome === "delivered"
              ? "delivered"
              : result.outcome === "duplicate"
                ? "duplicate"
                : "rejected";
        } catch (error) {
          this.metrics.deliveryFailures?.add(1);
          this.logger.warn("Waitpoint fanout delivery failed", { waitpointId, runId, error });
          outcome = "failed";
        }

        if (outcome === "delivered" || outcome === "duplicate") {
          this.metrics.watchersDelivered?.add(1, { outcome });
        }
        await this.hooks.afterDeliver?.({ waitpointId, runId, index, outcome });
        return outcome;
      },
      // Derived from the encoded size, not taken straight from the option: ioredis buffers the
      // completion once per in-flight command, so a wide page of large completions is a memory
      // and event-loop burst the configured number alone does not describe. Small and { ref }
      // completions keep the configured value exactly.
      { concurrency: effectiveDeliveryConcurrency(this.options.deliveryConcurrency, encoded.bytes) }
    );
  }

  /**
   * Release the claim, counting the stall, and act on what that single atomic call decided.
   *
   * The threshold is measured against the CONSECUTIVE failure streak, not the claim count:
   * a wide fan-out legitimately takes many pages, and any acknowledged progress resets the
   * streak.
   *
   * One call, not two. Releasing and then quarantining left a window in which another
   * worker could claim the entry, so the quarantine landed on state someone else owned
   * while this worker moved the entry out of the due index regardless — leaving a live
   * fanout with nothing to rediscover it. The index is now touched only when the script
   * itself reports the transition, and `lost` means another worker owns the entry and this
   * one must leave both the state and the index alone.
   *
   * The call is fenced by the claim's epoch, so it is safe both after a partial
   * acknowledgement — which has already released the claim — and on a resend whose first
   * reply was lost.
   */
  async #backOff(
    waitpointId: string,
    epoch: string,
    now: number
  ): Promise<"released" | "quarantined" | "lost"> {
    const released = await this.coordinator.releaseFanout({
      waitpointId,
      workerId: this.workerId,
      epoch,
      action: "fail",
      maxFailures: this.retryPolicy.maxFailures,
      retryPolicy: this.retryPolicy,
      now,
    });

    if (released.outcome === "quarantined") {
      await this.coordinator.quarantineFanoutEntry(waitpointId, now);
      this.metrics.quarantined?.add(1);
      this.logger.error("Quarantined a waitpoint fanout entry after repeated failures", {
        waitpointId,
        failures: released.failures,
        workerId: this.workerId,
      });
      return "quarantined";
    }

    if (released.outcome !== "released") {
      // `lost` — reclaimed by another worker, whose visit owns the retry. `absent` — the
      // entry is gone entirely. Either way this worker must not reschedule or move it.
      return "lost";
    }

    // The script computed and stored the backoff atomically with the increment, so the
    // index is only being brought into line with it. A crash before this point leaves an
    // index score that is early, which costs a probe — the claim refuses until the stored
    // time, so it can never cost an early claim, a second failure or early quarantine.
    await this.coordinator.repairFanoutSchedule(waitpointId, released.notBefore);
    this.metrics.retries?.add(1);
    return "released";
  }

  #tally(summary: FanoutVisitSummary, outcomes: WatcherDeliveryOutcome[]): void {
    for (const outcome of outcomes) {
      switch (outcome) {
        case "delivered":
          summary.delivered++;
          break;
        case "duplicate":
          summary.duplicates++;
          break;
        case "stale-watcher":
          summary.staleWatchers++;
          break;
        case "rejected":
          summary.rejected++;
          break;
        case "failed":
          summary.failures++;
          break;
      }
    }
  }

  #initializeMetrics(meter: Meter): void {
    this.metrics.watchersDelivered = meter.createCounter("waitpoint.fanout.watchers_delivered", {
      description: "Watchers delivered by the fanout worker, split by fresh versus duplicate",
    });
    this.metrics.pagesProcessed = meter.createCounter("waitpoint.fanout.pages_processed", {
      description: "Bounded watcher pages claimed and processed",
    });
    this.metrics.entriesReclaimed = meter.createCounter("waitpoint.fanout.entries_reclaimed", {
      description: "Fanout entries taken over from a worker whose lease had lapsed",
    });
    this.metrics.retries = meter.createCounter("waitpoint.fanout.retries", {
      description: "Fanout entries rescheduled after a stalled delivery",
    });
    this.metrics.staleWatchers = meter.createCounter("waitpoint.fanout.stale_watchers", {
      description: "Queued watchers skipped because their registration was withdrawn",
    });
    this.metrics.deliveryFailures = meter.createCounter("waitpoint.fanout.delivery_failures", {
      description: "Run-shard delivery attempts that errored and will be retried",
    });
    this.metrics.quarantined = meter.createCounter("waitpoint.fanout.quarantined", {
      description: "Fanout entries parked for intervention after exhausting retries",
    });
    this.metrics.deliveryLatency = meter.createHistogram("waitpoint.fanout.delivery_latency", {
      description: "Completion-to-delivery latency",
      unit: "ms",
    });

    this.metrics.backlog = meter.createObservableGauge("waitpoint.fanout.backlog", {
      description: "Waitpoints with fanout work due",
    });
    this.metrics.backlogAge = meter.createObservableGauge("waitpoint.fanout.backlog_oldest_age", {
      description: "Age of the oldest due fanout entry",
      unit: "ms",
    });
    this.metrics.quarantineDepth = meter.createObservableGauge(
      "waitpoint.fanout.quarantine_depth",
      {
        description: "Fanout entries awaiting intervention",
      }
    );

    // A BATCH callback, so one backlog read serves all three gauges. Three separate
    // callbacks would triple the index reads per collection interval for the same numbers.
    const observables = [
      this.metrics.backlog,
      this.metrics.backlogAge,
      this.metrics.quarantineDepth,
    ];
    const callback: BatchObservableCallback = async (result) => {
      // Guarded as well as unregistered, but the guard alone is NOT enough: it is checked once,
      // and the backlog read after it is a sequence of awaits across every partition. A
      // collection that passed this line before `dispose()` ran would still be reading when the
      // caller closed the coordinator. So the work is also TRACKED, and `dispose()` awaits it.
      if (this.disposed) {
        return;
      }

      const collection = this.#collect(result);
      this.activeCollections.add(collection);
      try {
        await collection;
      } finally {
        // Always, including on failure: a rejected collection that stayed in the set would make
        // every later dispose() await a promise nobody will settle again.
        this.activeCollections.delete(collection);
      }
    };

    meter.addBatchObservableCallback(callback, observables);
    this.metricsRegistration = { meter, callback, observables };
  }

  async #collect(result: Parameters<BatchObservableCallback>[0]): Promise<void> {
    const backlog = this.metrics.backlog;
    const backlogAge = this.metrics.backlogAge;
    const quarantineDepth = this.metrics.quarantineDepth;
    if (!backlog || !backlogAge || !quarantineDepth) {
      return;
    }

    const snapshot = await this.coordinator.fanoutBacklog();
    result.observe(backlog, snapshot.due);
    result.observe(
      backlogAge,
      snapshot.oldestDueAtMs ? Math.max(0, this.clock() - snapshot.oldestDueAtMs) : 0
    );
    result.observe(quarantineDepth, snapshot.quarantined);
  }
}
