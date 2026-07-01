import { Logger } from "@trigger.dev/core/logger";
import type { MollifierBuffer } from "./buffer.js";
import type { BufferEntry } from "./schemas.js";
import { deserialiseSnapshot } from "./schemas.js";

export type MollifierDrainerHandler<TPayload> = (input: {
  runId: string;
  envId: string;
  orgId: string;
  payload: TPayload;
  attempts: number;
  createdAt: Date;
}) => Promise<void>;

// Invoked once per entry before `buffer.fail()` on any terminal path —
// non-retryable error OR retryable error after maxAttempts. Lets the caller
// land a SYSTEM_FAILURE PG row so the customer sees the run instead of it
// silently disappearing alongside the buffer entry. Throwing a retryable
// error from the callback causes the drainer to requeue rather than fail
// (so the PG write itself gets another chance once PG recovers); throwing
// anything else falls through to `buffer.fail()` to avoid an infinite loop
// on a genuinely bad payload.
export type MollifierDrainerTerminalFailureCause = "non-retryable" | "max-attempts-exhausted";
export type MollifierDrainerTerminalFailureHandler<TPayload> = (input: {
  runId: string;
  envId: string;
  orgId: string;
  payload: TPayload;
  attempts: number;
  createdAt: Date;
  error: { code: string; message: string };
  cause: MollifierDrainerTerminalFailureCause;
}) => Promise<void>;

export type MollifierDrainerOptions<TPayload> = {
  buffer: MollifierBuffer;
  handler: MollifierDrainerHandler<TPayload>;
  onTerminalFailure?: MollifierDrainerTerminalFailureHandler<TPayload>;
  concurrency: number;
  maxAttempts: number;
  isRetryable: (err: unknown) => boolean;
  pollIntervalMs?: number;
  // Cap on how many ORGS `runOnce` processes per tick. The drainer rotates
  // through orgs at the top level and picks one env per org per tick, so
  // the actual per-tick pop count is at most `maxOrgsPerTick`. Tune for
  // "typical orgs with pending entries" rather than total system org
  // count. Defaults to 500.
  //
  // The buffer maintains `mollifier:orgs` and `mollifier:org-envs:${orgId}`
  // atomically with per-env queues, so the drainer can walk orgs → envs
  // directly. An org with N envs gets the same per-tick scheduling slot
  // as an org with 1 env — tenant-level drainage throughput is determined
  // by org count, not env count.
  maxOrgsPerTick?: number;
  // Per-env per-tick pop cap. Default 1 preserves the original
  // one-pop-per-env-per-tick behaviour. Setting it higher lets a single
  // env drain at handler-parallelism speed: each tick the drainer pops
  // up to `drainBatchSize` entries from the env's queue, then dispatches
  // them all through the shared `concurrency`-bounded pLimit. For a
  // single-env burst this turns N sequential ticks into one tick of N
  // parallel handler calls, capped by `concurrency`. Org/env fairness
  // still holds — each org still contributes exactly one env per tick.
  //
  // Memory: per-tick in-flight entries ≤ `maxOrgsPerTick × drainBatchSize`.
  // Operators sizing this should ensure their PG pool / engine handler
  // can sustain `concurrency` parallel writes; popping more than the
  // handler can process per tick just queues entries in JS waiting on
  // pLimit.
  drainBatchSize?: number;
  // Cap on the exponential backoff applied after consecutive `runOnce`
  // errors. Defaults to 5000ms. The backoff base is `max(pollIntervalMs,
  // backoffFloorMs)` and doubles per consecutive error up to this cap.
  maxBackoffMs?: number;
  // Floor for the exponential-backoff base, so a tiny `pollIntervalMs`
  // doesn't collapse the backoff to near-zero on a sustained outage.
  // Defaults to 100ms.
  backoffFloorMs?: number;
  logger?: Logger;
};

export type DrainResult = {
  drained: number;
  failed: number;
};

export class MollifierDrainer<TPayload = unknown> {
  private readonly buffer: MollifierBuffer;
  private readonly handler: MollifierDrainerHandler<TPayload>;
  private readonly onTerminalFailure?: MollifierDrainerTerminalFailureHandler<TPayload>;
  private readonly maxAttempts: number;
  private readonly isRetryable: (err: unknown) => boolean;
  private readonly pollIntervalMs: number;
  private readonly maxOrgsPerTick: number;
  private readonly drainBatchSize: number;
  private readonly concurrency: number;
  private readonly maxBackoffMs: number;
  private readonly backoffFloorMs: number;
  private readonly logger: Logger;
  // Rotation state. `orgCursor` advances through the active-orgs list.
  // Each org has its own internal cursor in `perOrgEnvCursors` for
  // cycling through that org's envs. Both reset on `start()`.
  private orgCursor = 0;
  private perOrgEnvCursors = new Map<string, number>();
  private isRunning = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: MollifierDrainerOptions<TPayload>) {
    this.buffer = options.buffer;
    this.handler = options.handler;
    this.onTerminalFailure = options.onTerminalFailure;
    this.maxAttempts = options.maxAttempts;
    this.isRetryable = options.isRetryable;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxOrgsPerTick = options.maxOrgsPerTick ?? 500;
    this.drainBatchSize = Math.max(1, options.drainBatchSize ?? 1);
    this.concurrency = Math.max(1, options.concurrency);
    this.maxBackoffMs = options.maxBackoffMs ?? 5_000;
    this.backoffFloorMs = Math.max(1, options.backoffFloorMs ?? 100);
    this.logger = options.logger ?? new Logger("MollifierDrainer", "debug");
  }

  async runOnce(): Promise<DrainResult> {
    const orgs = await this.buffer.listOrgs();
    if (orgs.length === 0) return { drained: 0, failed: 0 };

    const orgSlice = this.takeOrgSlice(orgs);

    // Fan the per-org SMEMBERS out in a single pipelined round-trip. Serial
    // awaits would otherwise add `orgSlice.length × RTT` of dead time before
    // pops start — at the default `maxOrgsPerTick=500` and a ~1ms ElastiCache
    // RTT that's a ~500ms per-tick floor. ioredis auto-pipelines concurrent
    // commands into one batch, so the burst is cheap; SMEMBERS on a small set
    // is O(N) per org and trivial at this scale. `Promise.all` preserves
    // order, so the org→envs pairing below stays deterministic.
    const envsByOrg = await Promise.all(orgSlice.map((orgId) => this.buffer.listEnvsForOrg(orgId)));
    const targets: string[] = [];
    for (let i = 0; i < orgSlice.length; i++) {
      const orgId = orgSlice[i]!;
      const envsForOrg = envsByOrg[i]!;
      if (envsForOrg.length === 0) continue;
      const envId = this.pickEnvForOrg(orgId, envsForOrg);
      targets.push(envId);
    }

    if (targets.length === 0) return { drained: 0, failed: 0 };

    // Worker-pool draining. We spawn up to `concurrency` workers; each
    // worker repeatedly:
    //   1. Picks the next env with budget remaining (round-robin),
    //      atomically claiming one slot of that env's per-tick budget.
    //   2. Pops one entry and processes it.
    //   3. Repeats until pickNextEnv returns null.
    //
    // This pattern gives us both invariants the prior two designs traded
    // off:
    //   - Single-env bursts use the full `concurrency` budget. All
    //     workers can pull from one env, processing `concurrency` entries
    //     in parallel.
    //   - The number of entries in "popped-but-not-acked" (DRAINING)
    //     state at any moment is bounded by the worker count, i.e.
    //     `concurrency` — same blast radius as the pre-batch
    //     one-pop-per-env model. A process crash mid-tick strands at
    //     most `concurrency` entries for stale-sweep to recover, not
    //     `maxOrgsPerTick × drainBatchSize`.
    //
    // Fairness: pickNextEnv advances a cursor by 1 each successful pick,
    // so workers round-robin across envs at the entry level. Combined
    // with the per-env budget cap, an env contributes at most
    // `drainBatchSize` entries per tick regardless of how many workers
    // are free — a heavy env can't starve siblings within a tick.
    const remaining = new Map<string, number>();
    const skip = new Set<string>(); // envs with empty queue or pop failure this tick
    for (const envId of targets) remaining.set(envId, this.drainBatchSize);

    let cursor = 0;
    const pickNextEnv = (): string | null => {
      for (let i = 0; i < targets.length; i++) {
        const idx = (cursor + i) % targets.length;
        const envId = targets[idx]!;
        if (skip.has(envId)) continue;
        const r = remaining.get(envId) ?? 0;
        if (r > 0) {
          remaining.set(envId, r - 1);
          cursor = (idx + 1) % targets.length;
          return envId;
        }
      }
      return null;
    };

    let drained = 0;
    let failed = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const envId = pickNextEnv();
        if (envId === null) return;
        let entry: BufferEntry | null;
        try {
          entry = await this.buffer.pop(envId);
        } catch (err) {
          // A pop failure on one env aborts that env's batch for this
          // tick (don't keep hammering a broken Redis) and counts as
          // exactly one failure — same as the pre-batch path on a pop
          // blowup. Other envs continue.
          //
          // `pickNextEnv` decrements `remaining` before the pop settles,
          // so multiple workers can race into the same env and all hit
          // a throwing pop before the first catch lands. Guarding the
          // failure increment on `!skip.has(envId)` keeps the per-env
          // failure count at exactly one even under that race —
          // matching the documented contract.
          this.logger.error("MollifierDrainer.pop failed", { envId, err });
          if (!skip.has(envId)) {
            skip.add(envId);
            failed += 1;
          }
          continue;
        }
        if (!entry) {
          // Queue exhausted between scheduling and this pop. Mark the
          // env skipped so siblings aren't held up by repeated empty pops.
          skip.add(envId);
          continue;
        }
        try {
          const outcome = await this.processEntry(entry);
          if (outcome === "drained") drained += 1;
          else failed += 1;
        } catch (err) {
          this.logger.error("MollifierDrainer.processEntry failed", {
            envId,
            runId: entry.runId,
            err,
          });
          failed += 1;
        }
      }
    };

    const totalBudget = targets.length * this.drainBatchSize;
    const workerCount = Math.min(this.concurrency, totalBudget);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { drained, failed };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopping = false;
    // Reset rotation state on each (re)start. A stop+start cycle means
    // operator intent to "begin clean" — between-restart cursor drift
    // would otherwise carry implicit state across what should look like
    // a fresh boot.
    this.orgCursor = 0;
    this.perOrgEnvCursors = new Map();
    this.loopPromise = this.loop();
  }

  // Signal the loop to exit (`stopping = true`) and wait for it. With no
  // timeout, wait indefinitely for the in-flight `runOnce` and its handlers
  // to settle — same semantic as FairQueue / BatchQueue's `stop()`. With a
  // timeout, race the loop promise against a deadline so a hung handler
  // can't wedge the process past its termination grace period.
  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.isRunning || !this.loopPromise) return;
    this.stopping = true;
    if (options.timeoutMs == null) {
      await this.loopPromise;
      return;
    }
    // Hold the timer handle so we can clearTimeout() it after the race.
    // Without this, when the loop wins the race, the discarded timer is
    // still ref'd and pins the Node event loop for up to `timeoutMs`,
    // delaying process shutdown by exactly the slack we were trying to
    // bound. try/finally clears the handle in every exit path (loop-won,
    // timeout-won, or exception).
    const timeoutSentinel = Symbol("mollifier.stop.timeout");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutSentinel), options.timeoutMs);
    });
    try {
      const winner = await Promise.race([
        this.loopPromise.then(() => "done" as const),
        timeoutPromise,
      ]);
      if (winner === timeoutSentinel) {
        this.logger.warn(
          "MollifierDrainer.stop: deadline exceeded; returning while loop iteration is in flight",
          { timeoutMs: options.timeoutMs }
        );
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // Transient Redis errors (e.g. a connection blip in `listOrgs` /
  // `listEnvsForOrg` / `pop`) must not kill the polling loop permanently.
  // We log each `runOnce` failure, back off so we don't spin tight on a
  // sustained outage, and resume. The loop only exits when `stop()` flips
  // `stopping`.
  private async loop(): Promise<void> {
    try {
      let consecutiveErrors = 0;
      while (!this.stopping) {
        try {
          const result = await this.runOnce();
          consecutiveErrors = 0;
          if (result.drained === 0 && result.failed === 0) {
            await this.delay(this.pollIntervalMs);
          }
        } catch (err) {
          consecutiveErrors += 1;
          this.logger.error("MollifierDrainer.runOnce failed; backing off", {
            err,
            consecutiveErrors,
          });
          await this.delay(this.backoffMs(consecutiveErrors));
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  // Exponential backoff capped at 5s. Keeps the loop responsive after a
  // brief blip while preventing a tight retry loop during a long Redis
  // outage. 1 → 200ms, 2 → 400ms, 3 → 800ms, 4 → 1.6s, 5 → 3.2s, 6+ → 5s.
  private backoffMs(consecutiveErrors: number): number {
    const base = Math.max(this.pollIntervalMs, this.backoffFloorMs);
    const capped = Math.min(base * 2 ** (consecutiveErrors - 1), this.maxBackoffMs);
    return capped;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Take up to `maxOrgsPerTick` orgs starting at the current cursor, with
  // wrap-around. Cursor advances by 1 each tick so every org reaches
  // every slot position (0..sliceSize-1) over a full cycle — no
  // head-of-line bias within the slice. Orgs are sorted before slicing
  // so rotation is deterministic regardless of Redis SET iteration order.
  private takeOrgSlice(orgs: string[]): string[] {
    const sorted = [...orgs].sort();
    const n = sorted.length;
    const sliceSize = Math.min(this.maxOrgsPerTick, n);
    const start = this.orgCursor % n;
    this.orgCursor = (this.orgCursor + 1) % Math.max(n, 1);
    const end = start + sliceSize;
    if (end <= n) return sorted.slice(start, end);
    return [...sorted.slice(start), ...sorted.slice(0, end - n)];
  }

  // Pick one env from the org's active-envs list, rotating per org via
  // the per-org cursor. Each org's cursor advances by 1 each visit, so
  // an org with N envs cycles through them across N visits.
  private pickEnvForOrg(orgId: string, envsForOrg: string[]): string {
    const sorted = [...envsForOrg].sort();
    const cursor = this.perOrgEnvCursors.get(orgId) ?? 0;
    const idx = cursor % sorted.length;
    this.perOrgEnvCursors.set(orgId, (cursor + 1) % sorted.length);
    return sorted[idx]!;
  }

  private async processEntry(entry: BufferEntry): Promise<"drained" | "failed"> {
    try {
      const payload = deserialiseSnapshot<TPayload>(entry.payload);
      await this.handler({
        runId: entry.runId,
        envId: entry.envId,
        orgId: entry.orgId,
        payload,
        attempts: entry.attempts,
        createdAt: entry.createdAt,
      });
      await this.buffer.ack(entry.runId);
      return "drained";
    } catch (err) {
      const nextAttempts = entry.attempts + 1;
      if (this.isRetryable(err) && nextAttempts < this.maxAttempts) {
        await this.buffer.requeue(entry.runId);
        this.logger.warn("MollifierDrainer: retryable error, requeued", {
          runId: entry.runId,
          attempts: nextAttempts,
        });
        return "failed";
      }
      const cause: MollifierDrainerTerminalFailureCause = this.isRetryable(err)
        ? "max-attempts-exhausted"
        : "non-retryable";
      const code = err instanceof Error ? err.name : "Unknown";
      const message = err instanceof Error ? err.message : String(err);
      // Run the terminal-failure callback BEFORE buffer.fail() so a
      // SYSTEM_FAILURE PG row can land while the entry is still around to
      // read from (and so we don't lose the run if the callback's own
      // write itself needs a retry). If the callback throws a retryable
      // error, requeue the entry instead of fail()ing — PG is still
      // unreachable, give it another tick. Any other callback failure
      // falls through to buffer.fail() so a genuinely bad snapshot
      // doesn't loop forever.
      if (this.onTerminalFailure) {
        try {
          await this.onTerminalFailure({
            runId: entry.runId,
            envId: entry.envId,
            orgId: entry.orgId,
            payload: deserialiseSnapshot<TPayload>(entry.payload),
            attempts: nextAttempts,
            createdAt: entry.createdAt,
            error: { code, message },
            cause,
          });
        } catch (writeErr) {
          if (this.isRetryable(writeErr)) {
            await this.buffer.requeue(entry.runId);
            this.logger.warn("MollifierDrainer: terminal-failure callback retryable; requeued", {
              runId: entry.runId,
              attempts: nextAttempts,
              writeErr,
            });
            return "failed";
          }
          this.logger.error("MollifierDrainer: terminal-failure callback failed", {
            runId: entry.runId,
            writeErr,
          });
        }
      }
      await this.buffer.fail(entry.runId, { code, message });
      this.logger.error("MollifierDrainer: terminal failure", {
        runId: entry.runId,
        code,
        message,
        cause,
      });
      return "failed";
    }
  }
}
