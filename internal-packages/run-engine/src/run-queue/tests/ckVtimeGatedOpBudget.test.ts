import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
const keys = new RunQueueFullKeyProducer();
const baseEnv: any = {
  id: "e1234",
  type: "DEVELOPMENT",
  maximumConcurrencyLimit: 100,
  concurrencyLimitBurstFactor: new Decimal(1),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};
const QUEUE = "task/my-task";
const mk = (o: any) => ({
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
// Declining to spend a window slot on a gated candidate means pass 1 reads further, so a
// fully-gated call costs more than it used to: measured 53 ops before and 80 after, the
// whole difference being SCARDs. That is the price of not silently degrading to age order,
// and it is worth paying because a fully-gated call serves nothing either way. What must
// not happen is the read running away, so this pins it against scanLimit (window * 2)
// rather than against the measured number, which would only be a tripwire.
describe("op count: fully gated dequeue", () => {
  redisTest(
    "pass 1 reads further when everything is gated, but stays inside scanLimit",
    async ({ redisContainer }) => {
      const MAX = 10; // window = 30, scanLimit = 60
      const GATED = 80; // more than scanLimit, so both bounds bind
      const kp = "rq:opc:";
      const q: any = new RunQueue({
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
        keys,
        masterQueueConsumersDisabled: true,
        workerOptions: { disabled: true },
        ckVirtualTimeScheduling: { enabled: true, scanWindowMultiplier: 3 },
        queueSelectionStrategy: new FairQueueSelectionStrategy({
          redis: { keyPrefix: kp, host: redisContainer.getHost(), port: redisContainer.getPort() },
          keys,
        }),
        redis: { keyPrefix: kp, host: redisContainer.getHost(), port: redisContainer.getPort() },
      } as any);
      const env = baseEnv;
      await q.updateEnvConcurrencyLimits(env);
      const shard = keys.masterQueueShardForEnvironment(env.id, 2);
      const t0 = Date.now() - 5000000;
      for (let i = 0; i < GATED; i++) {
        await q.enqueueMessage({
          env,
          message: mk({ runId: "g" + i, concurrencyKey: "gated-" + i, timestamp: t0 + i }),
          workerQueue: env.id,
          skipDequeueProcessing: true,
        });
        const members = Array.from({ length: 105 }, (_, k) => "busy-" + i + "-" + k);
        await q.redis.sadd(
          keys.queueKey(env, QUEUE, "gated-" + i) + ":currentConcurrency",
          ...members
        );
      }
      await q.redis.config("RESETSTAT");
      const served = await q.testDequeueFromMasterQueue(shard, env.id, MAX);
      const info = await q.redis.info("commandstats");
      let total = 0;
      const per: Record<string, number> = {};
      for (const line of info.split("\n")) {
        const m = line.match(/^cmdstat_([a-z|]+):calls=(\d+)/);
        if (!m || ["info", "config"].includes(m[1])) continue;
        per[m[1]] = parseInt(m[2], 10);
        total += parseInt(m[2], 10);
      }
      // Nothing is servable, so the call is pure scan.
      expect(served.length).toBe(0);
      // window = MAX * 3 = 30, scanLimit = 60. Pass 1 may read up to scanLimit candidates and
      // pass 2 up to its own window, one SCARD each, so that sum is the ceiling.
      const scanLimit = MAX * 3 * 2;
      const pass2Window = MAX * 3;
      expect(per.scard ?? 0).toBeLessThanOrEqual(scanLimit + pass2Window);
      // And it must read past the old window bound, or the fix is not in effect.
      expect(per.scard ?? 0).toBeGreaterThan(MAX * 3);
      await q.quit();
    },
    120000
  );
});
