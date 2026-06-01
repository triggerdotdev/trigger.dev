import { Logger } from "@trigger.dev/core/logger";
import pLimit from "p-limit";
import { MollifierBuffer } from "./buffer.js";
import { BufferEntry, deserialiseSnapshot } from "./schemas.js";

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
  private readonly logger: Logger;
  private readonly limit: ReturnType<typeof pLimit>;
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
    this.logger = options.logger ?? new Logger("MollifierDrainer", "debug");
    this.limit = pLimit(options.concurrency);
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
    const envsByOrg = await Promise.all(
      orgSlice.map((orgId) => this.buffer.listEnvsForOrg(orgId)),
    );
    const targets: string[] = [];
    for (let i = 0; i < orgSlice.length; i++) {
      const orgId = orgSlice[i]!;
      const envsForOrg = envsByOrg[i]!;
      if (envsForOrg.length === 0) continue;
      const envId = this.pickEnvForOrg(orgId, envsForOrg);
      targets.push(envId);
    }

    // Pop a batch from each target env in parallel. Within an env we pop
    // sequentially (each Lua `pop` is atomic; back-to-back pops on the
    // same env can't be concurrent without a `popBatch` Lua, and Redis
    // RTT × drainBatchSize is cheap compared to the engine.trigger work
    // that follows). A pop failure mid-batch aborts only that env's
    // batch and counts as one failure — same semantics as the previous
    // one-pop-per-env path, generalised.
    const envBatches = await Promise.all(
      targets.map(async (envId) => {
        const entries: BufferEntry[] = [];
        let popFailed = false;
        for (let i = 0; i < this.drainBatchSize; i++) {
          let entry: BufferEntry | null;
          try {
            entry = await this.buffer.pop(envId);
          } catch (err) {
            this.logger.error("MollifierDrainer.pop failed", { envId, err });
            popFailed = true;
            break;
          }
          if (!entry) break;
          entries.push(entry);
        }
        return { entries, popFailed };
      }),
    );

    const popFailures = envBatches.reduce((n, b) => n + (b.popFailed ? 1 : 0), 0);
    const allEntries = envBatches.flatMap((b) => b.entries);
    if (allEntries.length === 0) {
      return { drained: 0, failed: popFailures };
    }

    // Dispatch every popped entry through the shared pLimit so the
    // global in-flight cap is `concurrency` regardless of how many envs
    // contributed entries this tick. Per-entry errors are caught inside
    // the closure so a single bad entry can't poison the tick — same
    // safety net the old `processOneFromEnv` provided.
    const inflight = allEntries.map((entry) =>
      this.limit(async () => {
        try {
          return await this.processEntry(entry);
        } catch (err) {
          this.logger.error("MollifierDrainer.processEntry failed", {
            envId: entry.envId,
            runId: entry.runId,
            err,
          });
          return "failed" as const;
        }
      }),
    );

    const results = await Promise.all(inflight);
    return {
      drained: results.filter((r) => r === "drained").length,
      failed: results.filter((r) => r === "failed").length + popFailures,
    };
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
          { timeoutMs: options.timeoutMs },
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
    const base = Math.max(this.pollIntervalMs, 100);
    const capped = Math.min(base * 2 ** (consecutiveErrors - 1), 5_000);
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
            this.logger.warn(
              "MollifierDrainer: terminal-failure callback retryable; requeued",
              {
                runId: entry.runId,
                attempts: nextAttempts,
                writeErr,
              },
            );
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
