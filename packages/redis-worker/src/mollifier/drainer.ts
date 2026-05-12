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
  private readonly logger: Logger;
  private readonly limit: ReturnType<typeof pLimit>;
  private envCursor = 0;
  private isRunning = false;
  private stopping = false;

  constructor(options: MollifierDrainerOptions<TPayload>) {
    this.buffer = options.buffer;
    this.handler = options.handler;
    this.maxAttempts = options.maxAttempts;
    this.isRetryable = options.isRetryable;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.logger = options.logger ?? new Logger("MollifierDrainer", "debug");
    this.limit = pLimit(options.concurrency);
  }

  async runOnce(): Promise<DrainResult> {
    const envs = await this.buffer.listEnvs();
    if (envs.length === 0) return { drained: 0, failed: 0 };

    const ordered = this.rotate(envs);

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
    void this.loop();
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.isRunning) return;
    this.stopping = true;
    const deadline = options.timeoutMs != null ? Date.now() + options.timeoutMs : Infinity;
    while (this.isRunning) {
      if (Date.now() >= deadline) {
        this.logger.warn(
          "MollifierDrainer.stop: deadline exceeded; returning while loop iteration is in flight",
          { timeoutMs: options.timeoutMs },
        );
        return;
      }
      await this.delay(20);
    }
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopping) {
        const result = await this.runOnce();
        if (result.drained === 0 && result.failed === 0) {
          await this.delay(this.pollIntervalMs);
        }
      }
    } catch (err) {
      this.logger.error("MollifierDrainer loop crashed", { err });
    } finally {
      this.isRunning = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private rotate(envs: string[]): string[] {
    const start = this.envCursor % envs.length;
    this.envCursor = (this.envCursor + 1) % Math.max(envs.length, 1);
    return [...envs.slice(start), ...envs.slice(0, start)];
  }

  private async processOneFromEnv(envId: string): Promise<"drained" | "failed" | "empty"> {
    const entry = await this.buffer.pop(envId);
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
