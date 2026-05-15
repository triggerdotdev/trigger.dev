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

export type MollifierDrainerOptions<TPayload> = {
  buffer: MollifierBuffer;
  handler: MollifierDrainerHandler<TPayload>;
  concurrency: number;
  maxAttempts: number;
  isRetryable: (err: unknown) => boolean;
  pollIntervalMs?: number;
  // Cap on how many ORGS `runOnce` processes per tick. The drainer rotates
  // through orgs at the top level and picks one env per org per tick, so
  // the actual per-tick env count is at most `maxOrgsPerTick`. Tune for
  // "typical worst-case orgs-with-pending-entries" rather than total
  // system org count. Defaults to 500.
  //
  // Why orgs, not envs: an org with N envs would otherwise dominate
  // drainer throughput proportionally (each env is its own rotation
  // slot). Capping at the org level means a tenant with one busy env
  // and a tenant with a hundred busy envs get the same drainage share.
  maxOrgsPerTick?: number;
  logger?: Logger;
};

export type DrainResult = {
  drained: number;
  failed: number;
};

// Sentinel prefix for envs we haven't seen popped yet — they don't know
// their orgId at scheduling time, so they're treated as their own
// pseudo-org for that tick. Once a pop completes for the env, we cache
// its real orgId and subsequent ticks bucket it under that org.
const UNCACHED_ORG_PREFIX = "__uncached_org_for_env__:";

export class MollifierDrainer<TPayload = unknown> {
  private readonly buffer: MollifierBuffer;
  private readonly handler: MollifierDrainerHandler<TPayload>;
  private readonly maxAttempts: number;
  private readonly isRetryable: (err: unknown) => boolean;
  private readonly pollIntervalMs: number;
  private readonly maxOrgsPerTick: number;
  private readonly logger: Logger;
  private readonly limit: ReturnType<typeof pLimit>;
  // Rotation state. `orgCursor` advances through the org list; each org
  // has its own internal cursor in `perOrgEnvCursors` for cycling through
  // that org's envs. Reset on `start()`.
  private orgCursor = 0;
  private perOrgEnvCursors = new Map<string, number>();
  // envId → orgId learned from popped entries. Survives across runOnce
  // calls so subsequent ticks can bucket envs by org. Reset on `start()`.
  // Cross-process restarts naturally rebuild the cache within one full
  // tick — uncached envs cold-start as their own pseudo-orgs.
  private envOrgCache = new Map<string, string>();
  private isRunning = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: MollifierDrainerOptions<TPayload>) {
    this.buffer = options.buffer;
    this.handler = options.handler;
    this.maxAttempts = options.maxAttempts;
    this.isRetryable = options.isRetryable;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxOrgsPerTick = options.maxOrgsPerTick ?? 500;
    this.logger = options.logger ?? new Logger("MollifierDrainer", "debug");
    this.limit = pLimit(options.concurrency);
  }

  async runOnce(): Promise<DrainResult> {
    const envs = await this.buffer.listEnvs();
    if (envs.length === 0) return { drained: 0, failed: 0 };

    const targets = this.selectEnvsThisTick(envs);

    const inflight: Promise<"drained" | "failed" | "empty">[] = [];
    for (const envId of targets) {
      inflight.push(this.limit(() => this.processOneFromEnv(envId)));
    }

    const results = await Promise.all(inflight);
    return {
      drained: results.filter((r) => r === "drained").length,
      failed: results.filter((r) => r === "failed").length,
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopping = false;
    // Reset rotation state on each (re)start. A stop+start cycle means
    // operator intent to "begin clean" — between-restart cursor drift
    // would otherwise carry implicit state across what should look like
    // a fresh boot. The env→org cache is also reset; it'll rebuild
    // within one tick as pops populate it.
    this.orgCursor = 0;
    this.perOrgEnvCursors = new Map();
    this.envOrgCache = new Map();
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
    const timeoutSentinel = Symbol("mollifier.stop.timeout");
    const winner = await Promise.race([
      this.loopPromise.then(() => "done" as const),
      this.delay(options.timeoutMs).then(() => timeoutSentinel),
    ]);
    if (winner === timeoutSentinel) {
      this.logger.warn(
        "MollifierDrainer.stop: deadline exceeded; returning while loop iteration is in flight",
        { timeoutMs: options.timeoutMs },
      );
    }
  }

  // Transient Redis errors (e.g. a connection blip in `listEnvs` or `pop`)
  // must not kill the polling loop permanently. We log each `runOnce`
  // failure, back off so we don't spin tight on a sustained outage, and
  // resume. The loop only exits when `stop()` flips `stopping`.
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

  // Two-level rotation for org:env fairness:
  //
  //   1. Bucket envs by cached orgId. Envs we haven't seen popped yet get
  //      their own pseudo-org (`__uncached_org_for_env__:envId`) so cold
  //      start behaves like the original per-env rotation; once a pop
  //      populates the cache, the env joins its real org's bucket.
  //   2. Rotate through buckets (orgs + pseudo-orgs) using `orgCursor`,
  //      taking up to `maxOrgsPerTick` of them. Cursor advances by 1 each
  //      tick so every bucket experiences every slot position over a full
  //      cycle (no head-of-line bias within the slice).
  //   3. For each picked bucket, pick one env using that bucket's own
  //      cursor in `perOrgEnvCursors`. This makes a tenant with N envs
  //      drain its envs round-robin at 1/N the rate per env, but the
  //      tenant overall gets the same per-tick slot as a tenant with 1
  //      env. That's the org:env fairness contract.
  private selectEnvsThisTick(envs: string[]): string[] {
    const buckets = new Map<string, string[]>();
    for (const envId of envs) {
      const orgKey = this.envOrgCache.get(envId) ?? `${UNCACHED_ORG_PREFIX}${envId}`;
      const list = buckets.get(orgKey) ?? [];
      list.push(envId);
      buckets.set(orgKey, list);
    }
    // Stable bucket order for deterministic rotation. Sorting is O(B log B)
    // where B = orgs + uncached envs; bounded by `envs.length`, fine.
    const orgs = [...buckets.keys()].sort();
    const n = orgs.length;
    const sliceSize = Math.min(this.maxOrgsPerTick, n);
    const start = this.orgCursor % n;
    this.orgCursor = (this.orgCursor + 1) % Math.max(n, 1);

    const orgSlice: string[] =
      start + sliceSize <= n
        ? orgs.slice(start, start + sliceSize)
        : [...orgs.slice(start), ...orgs.slice(0, start + sliceSize - n)];

    const targets: string[] = [];
    for (const orgKey of orgSlice) {
      const envsInOrg = buckets.get(orgKey)!;
      const cursor = this.perOrgEnvCursors.get(orgKey) ?? 0;
      const idx = cursor % envsInOrg.length;
      this.perOrgEnvCursors.set(orgKey, (cursor + 1) % envsInOrg.length);
      targets.push(envsInOrg[idx]!);
    }
    return targets;
  }

  // A `pop()` failure for one env (e.g. a Redis hiccup mid-batch) must not
  // poison the rest of the batch — `Promise.all` would otherwise reject and
  // bubble all the way to `loop()`. Catch here so the failed env is just
  // counted as "failed" for this tick and we move on.
  private async processOneFromEnv(envId: string): Promise<"drained" | "failed" | "empty"> {
    let entry: BufferEntry | null;
    try {
      entry = await this.buffer.pop(envId);
    } catch (err) {
      this.logger.error("MollifierDrainer.pop failed", { envId, err });
      return "failed";
    }
    if (!entry) return "empty";
    // Learn this env's orgId from the popped entry so subsequent ticks
    // bucket it correctly. Survives across runOnce calls; reset on
    // `start()` along with the rotation cursors.
    this.envOrgCache.set(entry.envId, entry.orgId);
    return this.processEntry(entry);
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
      const code = err instanceof Error ? err.name : "Unknown";
      const message = err instanceof Error ? err.message : String(err);
      await this.buffer.fail(entry.runId, { code, message });
      this.logger.error("MollifierDrainer: terminal failure", {
        runId: entry.runId,
        code,
        message,
      });
      return "failed";
    }
  }
}
