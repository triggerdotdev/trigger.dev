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
  // Cap on how many envs `runOnce` processes per tick. When the
  // `mollifier:envs` SET grows large (e.g. an extended drainer outage left
  // entries piled up across thousands of envs), an uncapped fan-out queues
  // one `processOneFromEnv` job per env through `pLimit`, ballooning
  // per-tick latency and event-loop queue depth. With this cap the
  // drainer rotates through the full set across multiple ticks instead.
  // Defaults to 500; size for "typical worst-case envs-with-pending-
  // entries" rather than total system env count.
  maxEnvsPerTick?: number;
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
  private readonly maxEnvsPerTick: number;
  private readonly logger: Logger;
  private readonly limit: ReturnType<typeof pLimit>;
  private envCursor = 0;
  private isRunning = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: MollifierDrainerOptions<TPayload>) {
    this.buffer = options.buffer;
    this.handler = options.handler;
    this.maxAttempts = options.maxAttempts;
    this.isRetryable = options.isRetryable;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxEnvsPerTick = options.maxEnvsPerTick ?? 500;
    this.logger = options.logger ?? new Logger("MollifierDrainer", "debug");
    this.limit = pLimit(options.concurrency);
  }

  async runOnce(): Promise<DrainResult> {
    const envs = await this.buffer.listEnvs();
    if (envs.length === 0) return { drained: 0, failed: 0 };

    const ordered = this.takeRotatingSlice(envs);

    const inflight: Promise<"drained" | "failed" | "empty">[] = [];
    for (const envId of ordered) {
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

  // Take up to `maxEnvsPerTick` envs starting at the current cursor, with
  // wrap-around. Always advance the cursor by 1 — when the full set fits
  // within the cap this is just the original rotation; when we have to
  // slice, advancing by 1 still gives every env a turn at every position
  // (0…sliceSize-1) over `envs.length` ticks, so no env is systematically
  // last into `pLimit`. Drainage rate per env is `sliceSize / envs.length`
  // per tick — same as advancing by sliceSize, but without the head-of-line
  // bias that fixed slice boundaries would introduce.
  private takeRotatingSlice(envs: string[]): string[] {
    const n = envs.length;
    const sliceSize = Math.min(this.maxEnvsPerTick, n);
    const start = this.envCursor % n;
    this.envCursor = (this.envCursor + 1) % Math.max(n, 1);
    const end = start + sliceSize;
    if (end <= n) return envs.slice(start, end);
    return [...envs.slice(start), ...envs.slice(0, end - n)];
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
