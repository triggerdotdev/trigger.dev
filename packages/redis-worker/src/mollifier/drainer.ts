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
  logger?: Logger;
};

export type DrainResult = {
  drained: number;
  failed: number;
};

export class MollifierDrainer<TPayload = unknown> {
  private readonly buffer: MollifierBuffer;
  private readonly handler: MollifierDrainerHandler<TPayload>;
  private readonly maxAttempts: number;
  private readonly isRetryable: (err: unknown) => boolean;
  private readonly pollIntervalMs: number;
  private readonly maxOrgsPerTick: number;
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
    this.maxAttempts = options.maxAttempts;
    this.isRetryable = options.isRetryable;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxOrgsPerTick = options.maxOrgsPerTick ?? 500;
    this.logger = options.logger ?? new Logger("MollifierDrainer", "debug");
    this.limit = pLimit(options.concurrency);
  }

  async runOnce(): Promise<DrainResult> {
    const orgs = await this.buffer.listOrgs();
    if (orgs.length === 0) return { drained: 0, failed: 0 };

    const orgSlice = this.takeOrgSlice(orgs);

    // For each picked org, pick one env from its active-envs set. The
    // listEnvsForOrg calls are independent and could be parallelised; we
    // do them sequentially for simplicity since they're each a fast
    // SMEMBERS. The actual pops happen concurrently below.
    const targets: string[] = [];
    for (const orgId of orgSlice) {
      const envsForOrg = await this.buffer.listEnvsForOrg(orgId);
      if (envsForOrg.length === 0) continue;
      const envId = this.pickEnvForOrg(orgId, envsForOrg);
      targets.push(envId);
    }

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
