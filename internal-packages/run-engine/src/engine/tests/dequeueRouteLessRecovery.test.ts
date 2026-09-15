// Mixed-version dequeue compatibility. During a rolling deploy an OLD producer can leave an enrolled
// redis-primary run queued with no `snapshotRoute` (or a malformed one). On a consumer whose org dial
// reads undefined, the store's write-residency check treats a missing route as "never enrolled" and
// diverts the dequeue transition to Postgres — the run's MemoryDB head never advances and the run is
// stranded.
//
// RED before the fix: the dequeue/lock snapshot lands as a Postgres TRES row and the MemoryDB head is
// unchanged. GREEN after: the dequeue recovers the run's durable route once, threads it through the
// lock transition and the returned DequeuedMessage, and the MemoryDB head advances with zero TRES rows.
//
// Real queue, real Postgres, real Redis (testcontainers, no mocks).
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 90_000 });

const ROUTE = "logical:1";

// "absent" omits the field entirely (a pre-field producer); "malformed" writes a value the wire schema
// rejects, which parses to undefined exactly like the absent case.
const OLD_MESSAGE_CASES = [
  { label: "absent", route: undefined as unknown },
  { label: "malformed", route: { v: 99, residency: "nonsense" } as unknown },
];

describe("RunEngine dequeue route-less recovery (mixed-version)", () => {
  for (const kase of OLD_MESSAGE_CASES) {
    containerTest(
      `an old ${kase.label}-route message for a redis-primary run is recovered on a dial-undefined consumer`,
      async ({ prisma, redisOptions }) => {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const orgId = env.organizationId;
        const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

        let dial: SnapshotStoreDial | undefined = "redis-only";
        const runStore = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: () => dial,
          residencyResolver: new SnapshotResidencyResolver({
            store,
            taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
          }),
          logicalRunStoreRoute: ROUTE,
        });

        const engine = new RunEngine({
          prisma,
          store: runStore,
          worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
          queue: { redis: redisOptions },
          runLock: { redis: redisOptions },
          machines: {
            defaultMachine: "small-1x",
            machines: {
              "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
            },
            baseCostInCents: 0.0001,
          },
          tracer: trace.getTracer("test", "0.0.0"),
        });

        try {
          const taskIdentifier = "test-task";
          await setupBackgroundWorker(engine, env, taskIdentifier);

          // Born redis-primary at the redis-only dial. Delayed so nothing auto-enqueues it.
          const run = await engine.trigger(
            {
              number: 1,
              friendlyId: `run_oldmsg${kase.label === "absent" ? "a" : "b"}`,
              environment: env,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: `t-oldmsg-${kase.label}`,
              spanId: `s-oldmsg-${kase.label}`,
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              delayUntil: new Date(Date.now() + 60_000),
            },
            prisma
          );
          expect(await store.readBirthResidency(run.id)).toBe("redis-primary");

          const birthHead = await store.getLatest(run.id);
          assertNonNullable(birthHead);

          // Enqueue through the REAL enqueue path so the run reaches a genuine QUEUED (dequeueable)
          // state, then overwrite the stored message payload with the OLD-FORMAT one: the route is
          // absent (or malformed), exactly as a pre-field producer would have left it.
          await prisma.taskRun.update({
            where: { id: run.id },
            data: { delayUntil: null, queueTimestamp: new Date() },
          });
          const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
          await engine.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

          const stamped = await engine.runQueue.readMessage(orgId, run.id);
          assertNonNullable(stamped);
          expect((stamped.snapshotRoute as { residency?: string } | undefined)?.residency).toBe(
            "redis-primary"
          );
          const { snapshotRoute: _stampedRoute, ...withoutRoute } = stamped as Record<
            string,
            unknown
          >;
          await engine.runQueue.enqueueMessage({
            env,
            workerQueue: "main",
            message: {
              ...(withoutRoute as never),
              ...(kase.route === undefined ? {} : { snapshotRoute: kase.route }),
            },
            enableFastPath: true,
          });
          const oldMessage = await engine.runQueue.readMessage(orgId, run.id);
          assertNonNullable(oldMessage);
          expect(
            (oldMessage.snapshotRoute as { residency?: string } | undefined)?.residency
          ).not.toBe("redis-primary");

          // The consumer's dial reads undefined: without recovery, the missing route is taken as
          // "never enrolled" and the write diverts to Postgres.
          dial = undefined;
          expect(await runStore.readSnapshotRoute(run.id, orgId)).toBeUndefined();

          let dequeued: Awaited<ReturnType<typeof engine.dequeueFromWorkerQueue>> = [];
          for (let i = 0; i < 20 && dequeued.length === 0; i++) {
            await setTimeout(500);
            dequeued = await engine.dequeueFromWorkerQueue({
              consumerId: `oldmsg_consumer_${kase.label}`,
              workerQueue: "main",
            });
          }
          expect(dequeued.length).toBe(1);
          const locked = dequeued[0];
          expect(locked.run.id).toBe(run.id);

          // The stranding assertions come FIRST: without recovery the transition diverts to Postgres,
          // so a TRES row appears and the MemoryDB head never moves off the birth head.
          expect(
            await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } }),
            "a redis-primary run must have NO Postgres TRES row"
          ).toBe(0);
          const head = await store.getLatest(run.id);
          assertNonNullable(head);
          expect(head.id, "the MemoryDB head must advance past the birth head").not.toBe(
            birthHead.id
          );
          expect(head.id, "the MemoryDB head must be the dequeue/lock snapshot").toBe(
            locked.snapshot.id
          );

          // And the recovered route reached the returned message.
          expect(locked.snapshotRoute).toBeDefined();
          expect(locked.snapshotRoute?.residency).toBe("redis-primary");

          // A subsequent nack re-stamps the recovered route on the queue message, so the next
          // consumer no longer needs the compatibility lookup.
          await engine.runQueue.nackMessage({
            orgId,
            messageId: run.id,
            snapshotRoute: locked.snapshotRoute,
          });
          const requeued = await engine.runQueue.readMessage(orgId, run.id);
          assertNonNullable(requeued);
          expect((requeued.snapshotRoute as { residency?: string } | undefined)?.residency).toBe(
            "redis-primary"
          );
        } finally {
          await engine.quit();
          await store.quit();
        }
      }
    );
  }

  containerTest(
    "a VALID carried route still performs zero durable route lookups",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      let dial: SnapshotStoreDial | undefined = "redis-only";
      let durableLookups = 0;
      const runStore = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => dial,
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
      });
      // Count the compatibility lookup on the exact object the dequeue calls.
      const original = runStore.readSnapshotRoute.bind(runStore);
      (runStore as unknown as { readSnapshotRoute: unknown }).readSnapshotRoute = (
        ...args: Parameters<typeof original>
      ) => {
        if (args[2]?.forceDurable) durableLookups++;
        return original(...args);
      };

      const engine = new RunEngine({
        prisma,
        store: runStore,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_carried1",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-carried",
            spanId: "s-carried",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );

        // Enqueue through the REAL enqueue path, which stamps the route on the message.
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        await engine.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

        dial = undefined;
        durableLookups = 0;

        let dequeued: Awaited<ReturnType<typeof engine.dequeueFromWorkerQueue>> = [];
        for (let i = 0; i < 20 && dequeued.length === 0; i++) {
          await setTimeout(500);
          dequeued = await engine.dequeueFromWorkerQueue({
            consumerId: "carried_consumer",
            workerQueue: "main",
          });
        }
        expect(dequeued.length).toBe(1);
        expect(dequeued[0].snapshotRoute?.residency).toBe("redis-primary");
        expect(durableLookups, "a carried route must cost zero durable lookups").toBe(0);
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );
});
