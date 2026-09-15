import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";

// A draining variant parks its tag in :ckVtimeIdle before it leaves :ckVtime, so its next
// enqueue re-registers with the credit it earned instead of at the floor. This pins that
// on every route out: ack, dead-letter and TTL expiry parking it, and nack restoring it.
//
// Each test gives the variant credit first. Parking a tag that equals the floor proves
// nothing, because the dequeue reaps everything at or below the floor on its next call.

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "error"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

function createQueue(
  redisContainer: any,
  opts: { vtime?: boolean; maxAttempts?: number } = {}
): any {
  const redis = {
    keyPrefix: "runqueue:test:",
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ...(opts.maxAttempts
      ? { retryOptions: { ...testOptions.retryOptions, maxAttempts: opts.maxAttempts } }
      : {}),
    ...(opts.vtime === false ? {} : { ckVirtualTimeScheduling: { enabled: true } }),
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis, keys: testOptions.keys }),
    redis,
  } as any) as any;
}

describe("run queue Lua", () => {
  redisTest("every defined script compiles, in both builds", async ({ redisContainer }) => {
    const on = createQueue(redisContainer);
    const off = createQueue(redisContainer, { vtime: false });
    try {
      const scripts = new Map<string, string>();
      for (const q of [on, off]) {
        for (const [name, def] of Object.entries(
          (q.redis as any).scriptsSet as Record<string, any>
        )) {
          scripts.set(name, (def as any).lua);
        }
      }
      // Both builds are registered on the same client, so this covers the vtime commands and
      // the flag-off commands they share their text with.
      expect(scripts.size).toBeGreaterThan(30);

      const failures: string[] = [];
      for (const [name, lua] of scripts) {
        await (on.redis as any).script("LOAD", lua).catch((e: Error) => {
          failures.push(`${name}: ${e.message}`);
        });
      }
      expect(failures).toEqual([]);
    } finally {
      await off.quit();
      await on.quit();
    }
  });
});
