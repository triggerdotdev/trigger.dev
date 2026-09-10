// F6: nackMessage must be able to stamp the run's snapshotRoute onto the requeued message DURING the
// existing nack (no extra Redis round trip), so the next consumer honors durable residency. When no
// route is supplied the message keeps whatever route it already had.
import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

function baseMessage(runId: string, snapshotRoute?: unknown): InputPayload {
  return {
    runId,
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e4321",
    environmentType: "DEVELOPMENT",
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...(snapshotRoute !== undefined ? { snapshotRoute } : {}),
  };
}

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue.nackMessage snapshotRoute (F6)", () => {
  redisTest("stamps a supplied route and preserves an existing one", async ({ redisContainer }) => {
    const queue = new RunQueue({
      ...testOptions,
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis: {
          keyPrefix: "runqueue:test:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        keys: testOptions.keys,
      }),
      redis: {
        keyPrefix: "runqueue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
    });

    const wireRoute = { version: 1, route: "logical:1" };

    try {
      // Case 1: a route-less message gets the route stamped on during the nack.
      const routeless = baseMessage("r-routeless");
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: routeless,
        workerQueue: authenticatedEnvDev.id,
      });
      await setTimeout(500);
      const dq1 = await queue.dequeueMessageFromWorkerQueue("c1", authenticatedEnvDev.id);
      assertNonNullable(dq1);

      await queue.nackMessage({
        orgId: routeless.orgId,
        messageId: routeless.runId,
        snapshotRoute: wireRoute,
      });

      const afterStamp = await queue.readMessage(routeless.orgId, routeless.runId);
      assertNonNullable(afterStamp);
      expect(afterStamp.snapshotRoute).toEqual(wireRoute);

      // Case 2: an existing route is preserved when no route is supplied to the nack.
      const withRoute = baseMessage("r-withroute", wireRoute);
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: withRoute,
        workerQueue: authenticatedEnvDev.id,
      });
      await setTimeout(500);
      const dq2 = await queue.dequeueMessageFromWorkerQueue("c2", authenticatedEnvDev.id);
      assertNonNullable(dq2);

      await queue.nackMessage({
        orgId: withRoute.orgId,
        messageId: withRoute.runId,
      });

      const afterPreserve = await queue.readMessage(withRoute.orgId, withRoute.runId);
      assertNonNullable(afterPreserve);
      expect(afterPreserve.snapshotRoute).toEqual(wireRoute);
    } finally {
      await queue.quit();
    }
  });
});
