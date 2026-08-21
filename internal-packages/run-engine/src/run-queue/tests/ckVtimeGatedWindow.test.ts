import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";

// Devin's finding B on #4367: a concurrency-gated candidate returns from tryServe without
// the 'notReady' marker, so it spends one of pass 1's window slots even though it can
// never be served. A gated variant also stops advancing its tag, so it keeps sorting to
// the front and is revisited first on every call. Fill the window with them and pass 1
// serves nothing, every call, and the scheduler silently degrades to pass 2's age order.
//
// Work conservation survives that, which is why it was originally waved through. What does
// not survive is the feature's whole purpose: fair order. This pins the difference.

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 100,
  logger: new Logger("RunQueue", "error"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};
const baseEnv: any = {
  id: "e1234",
  type: "DEVELOPMENT",
  maximumConcurrencyLimit: 100,
  concurrencyLimitBurstFactor: new Decimal(1),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};
const QUEUE = "task/my-task";
const makeMessage = (o: any) => ({
  runId: "r1",
  taskIdentifier: QUEUE,
  orgId: "o1234",
  projectId: "p1234",
  environmentId: "e1234",
  environmentType: "DEVELOPMENT",
  queue: QUEUE,
  timestamp: Date.now(),
  attempt: 0,
  ...o,
});
const variantName = (ck: string) => testOptions.keys.queueKey(baseEnv, QUEUE, ck);

function createQueue(rc: any, keyPrefix: string) {
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ckVirtualTimeScheduling: { enabled: true, scanWindowMultiplier: 3 },
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: { keyPrefix, host: rc.getHost(), port: rc.getPort() },
      keys: testOptions.keys,
    }),
    redis: { keyPrefix, host: rc.getHost(), port: rc.getPort() },
  } as any) as any;
}

describe("CK vtime: gated variants and the pass-1 window", () => {
  redisTest(
    "gated variants must not spend the fair pass's budget",
    async ({ redisContainer }) => {
      const MAX = 2; // window = MAX * 3 = 6
      const GATED = 8; // more than the window, all sorting ahead on tag
      const queue = createQueue(redisContainer, "runqueue:test:gatedwin:");

      try {
        const env = baseEnv;
        await queue.updateEnvConcurrencyLimits(env);
        const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, 2);
        const t0 = Date.now() - 5_000_000;

        // Gated variants: queued work, but each parked at its per-key ceiling so it can
        // never be served. Enqueued first so their heads are oldest too.
        for (let i = 0; i < GATED; i++) {
          await queue.enqueueMessage({
            env,
            message: makeMessage({
              runId: `g-${i}`,
              concurrencyKey: `gated-${i}`,
              timestamp: t0 + i,
            }),
            workerQueue: env.id,
            skipDequeueProcessing: true,
          });
        }

        // "owed" is what fair order says to serve next: the lowest tag among servable
        // variants. Its head is the NEWEST, so age order would put it last.
        await queue.enqueueMessage({
          env,
          message: makeMessage({
            runId: "owed-0",
            concurrencyKey: "owed",
            timestamp: t0 + 900_000,
          }),
          workerQueue: env.id,
          skipDequeueProcessing: true,
        });
        // "old" has the OLDEST head of the servable pair but a higher tag, so age order
        // serves it first and fair order serves it second.
        await queue.enqueueMessage({
          env,
          message: makeMessage({ runId: "old-0", concurrencyKey: "old", timestamp: t0 + 100 }),
          workerQueue: env.id,
          skipDequeueProcessing: true,
        });

        // Park every gated variant at its ceiling.
        const limit = 100;
        for (let i = 0; i < GATED; i++) {
          const members = Array.from({ length: limit + 5 }, (_, k) => `busy-${i}-${k}`);
          await queue.redis.sadd(`${variantName(`gated-${i}`)}:currentConcurrency`, ...members);
        }

        // Tags: gated variants lowest so they lead pass 1, then owed, then old.
        const ckv = testOptions.keys.ckVtimeKeyFromQueue(variantName("owed"));
        for (let i = 0; i < GATED; i++) await queue.redis.zadd(ckv, 0, variantName(`gated-${i}`));
        await queue.redis.zadd(ckv, 1, variantName("owed"));
        await queue.redis.zadd(ckv, 5, variantName("old"));

        const served: string[] = [];
        for (let c = 0; c < 4 && served.length < 2; c++) {
          for (const m of await queue.testDequeueFromMasterQueue(shard, env.id, MAX)) {
            served.push(m.message.concurrencyKey as string);
            await queue.acknowledgeMessage(env.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        // Fair order is the point of the feature: lowest tag first. If gated variants have
        // eaten the window, pass 1 served nothing and pass 2's age order ran instead,
        // which puts "old" first.
        expect(served[0]).toBe("owed");
      } finally {
        await queue.quit();
      }
    },
    60_000
  );
});
