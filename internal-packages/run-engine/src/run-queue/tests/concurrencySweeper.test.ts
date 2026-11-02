import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { setTimeout } from "node:timers/promises";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue, SWEEPER_SET_CONCURRENCY } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";
import { commandCalls, seedSweeperKeyspace } from "./sweeperKeyspace.js";
import { Decimal } from "@trigger.dev/database";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "debug"),
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

const messageDev: InputPayload = {
  runId: "r4321",
  taskIdentifier: "task/my-task",
  orgId: "o1234",
  projectId: "p1234",
  environmentId: "e4321",
  environmentType: "DEVELOPMENT",
  queue: "task/my-task",
  timestamp: Date.now(),
  attempt: 0,
};

const messageDev2: InputPayload = {
  ...messageDev,
  runId: "r4322",
};

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue Concurrency Sweeper", () => {
  redisTest(
    "should process queue current concurrency sets and mark runs for ack if they are completed",
    async ({ redisContainer }) => {
      let enableConcurrencySweeper = false;

      const queue = new RunQueue({
        ...testOptions,
        logLevel: "debug",
        queueSelectionStrategy: new FairQueueSelectionStrategy({
          redis: {
            keyPrefix: "runqueue:test:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
          keys: testOptions.keys,
        }),
        workerOptions: {
          pollIntervalMs: 100,
          immediatePollIntervalMs: 100,
        },
        redis: {
          keyPrefix: "runqueue:test:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        concurrencySweeper: {
          scanSchedule: "* * * * * *", // Every second
          scanJitterInMs: 5,
          processMarkedSchedule: "* * * * * *", // Every second
          processMarkedJitterInMs: 5,
          callback: async (runIds) => {
            if (!enableConcurrencySweeper) {
              return [];
            }

            return [{ id: messageDev.runId, orgId: "o1234" }];
          },
        },
      });

      try {
        //enqueue message
        const enqueueResult = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: authenticatedEnvDev.id,
        });

        expect(enqueueResult).toBe(undefined);

        const enqueueResult2 = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev2,
          workerQueue: authenticatedEnvDev.id,
        });

        expect(enqueueResult2).toBe(undefined);

        //queue length
        const result2 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(result2).toBe(2);

        const envQueueLength2 = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(envQueueLength2).toBe(2);

        //concurrencies
        const queueConcurrency = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency).toBe(0);

        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(0);

        //dequeue message
        const dequeued = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );

        expect(dequeued).toBeDefined();
        expect(dequeued?.messageId).toEqual(messageDev.runId);

        const dequeued2 = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );
        expect(dequeued2).toBeDefined();
        expect(dequeued2?.messageId).toEqual(messageDev2.runId);

        // queue concurrency should be 2
        const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency2).toBe(2);

        // env concurrency should be 2
        const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency2).toBe(2);

        enableConcurrencySweeper = true;

        await setTimeout(5_000); // Now a run is "completed" and should be removed from the concurrency set

        // queue concurrency should be 1
        const queueConcurrency3 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency3).toBe(1);

        // env concurrency should be 1
        const envConcurrency3 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency3).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "scans the keyspace in large SCAN batches, bounds callback fan-out, and finds the same members",
    async ({ redisContainer }) => {
      // Catches: the sweeper falling back to tiny SCAN pages (~1.7M SCANs per prod sweep) or bursting one callback per set in a page.
      const createQueue = (
        scanCount: number | undefined,
        seen: Set<string>,
        inFlight: { now: number; max: number }
      ) =>
        new RunQueue({
          ...testOptions,
          logger: new Logger("RunQueue", "warn"),
          masterQueueConsumersDisabled: true,
          workerOptions: { disabled: true },
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
          concurrencySweeper: {
            scanCount,
            callback: async (runIds) => {
              inFlight.max = Math.max(inFlight.max, ++inFlight.now);
              await setTimeout(1);
              runIds.forEach((id) => seen.add(id));
              inFlight.now--;
              return [];
            },
          },
        });

      const sweep = async (scanCount: number | undefined) => {
        const seen = new Set<string>();
        const inFlight = { now: 0, max: 0 };
        const queue = createQueue(scanCount, seen, inFlight);
        try {
          const before = await commandCalls(queue.redis, "scan");
          await queue["scanConcurrencySets"]();
          const scans = (await commandCalls(queue.redis, "scan")) - before;
          return { seen, scans, maxInFlight: inFlight.max, dbsize: await queue.redis.dbsize() };
        } finally {
          await queue.quit();
        }
      };

      const seedQueue = createQueue(undefined, new Set(), { now: 0, max: 0 });
      let expected: Set<string>;
      try {
        expected = await seedSweeperKeyspace(seedQueue.redis, {
          concurrencySets: 2_000,
          unrelatedPerSet: 9,
        });
      } finally {
        await seedQueue.quit();
      }

      const legacy = await sweep(10);
      const current = await sweep(undefined);

      // Same members reach the callback whatever the batch size.
      expect(legacy.seen).toEqual(expected);
      expect(current.seen).toEqual(expected);

      // ~20k keys: the old COUNT 10 needs ~2,000 SCANs, the default must stay near dbsize/1000.
      expect(current.dbsize).toBeGreaterThanOrEqual(20_000);
      expect(legacy.scans).toBeGreaterThan(1_000);
      expect(current.scans).toBeLessThanOrEqual(Math.ceil(current.dbsize / 1000) * 2);

      // A 1000-key SCAN page can hold hundreds of matches; the callback (a DB query in
      // the engine) must not fan out wider than the old 10-key page did.
      expect(current.maxInFlight).toBeGreaterThan(1);
      expect(current.maxInFlight).toBeLessThanOrEqual(SWEEPER_SET_CONCURRENCY);
    }
  );

  redisTest(
    "does not resolve the sweep until the last SCAN page has been processed",
    async ({ redisContainer }) => {
      // Catches: the sweep resolving on SCAN "end" while the last page's sets are still being processed.
      const seen = new Set<string>();
      const queue = new RunQueue({
        ...testOptions,
        logger: new Logger("RunQueue", "warn"),
        masterQueueConsumersDisabled: true,
        workerOptions: { disabled: true },
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
        concurrencySweeper: {
          scanCount: 30,
          callback: async (runIds) => {
            await setTimeout(50);
            runIds.forEach((id) => seen.add(id));
            return [];
          },
        },
      });

      try {
        // 40 sets at COUNT 30 is two pages, the second non-empty. While the first is processed
        // the stream reads ahead to the end, so "end" fires as soon as the second page is handed
        // out, before its callbacks finish. A single page can't show this ("end" waits for
        // resume()), nor can an empty last page.
        const expected = await seedSweeperKeyspace(queue.redis, {
          concurrencySets: 40,
          unrelatedPerSet: 0,
        });

        const stats = await queue["scanConcurrencySets"]();
        expect(seen).toEqual(expected);
        expect(stats?.streamCallbacks).toBeGreaterThan(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "does not resolve a set until its last SSCAN page has been processed",
    async ({ redisContainer }) => {
      // Catches: a concurrency set resolving on SSCAN "end" while its last page's callback is still pending.
      const seen = new Set<string>();
      const queue = new RunQueue({
        ...testOptions,
        logger: new Logger("RunQueue", "warn"),
        masterQueueConsumersDisabled: true,
        workerOptions: { disabled: true },
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
        concurrencySweeper: {
          callback: async (runIds) => {
            await setTimeout(50);
            runIds.forEach((id) => seen.add(id));
            return [];
          },
        },
      });

      try {
        // 250 members is past the listpack limit, so SSCAN COUNT 100 pages through a hashtable.
        const expected = Array.from({ length: 250 }, (_, i) => `run_${i}`);
        await queue.redis.sadd(
          testOptions.keys.queueCurrentConcurrencyKey(authenticatedEnvDev, messageDev.queue),
          ...expected
        );

        await queue["scanConcurrencySets"]();
        expect(seen).toEqual(new Set(expected));
      } finally {
        await queue.quit();
      }
    }
  );
});
