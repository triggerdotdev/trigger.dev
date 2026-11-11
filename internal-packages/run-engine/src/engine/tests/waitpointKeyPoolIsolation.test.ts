import {
  containerTestWithIsolatedRedis as containerTest,
  postgresTest,
} from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import {
  RedisSnapshotStore,
  WaitpointKeyTransactionLane,
  WAITPOINT_KEY_TRANSACTION_POOL_SIZE,
  registerWaitpointKeyTransactionLane,
  PostgresRunStore,
} from "@internal/run-store";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { makeEngine } from "./utils/storeRunWaitpointLifecycleFixtures.js";
import { setupAuthenticatedEnvironment } from "./setup.js";
import { waitpointStoreBarrier } from "./utils/waitpointStoreBarrier.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";

async function secondEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: { title: "Second enabled organisation", slug: "burst-second-org" },
  });
  const project = await prisma.project.create({
    data: {
      name: "Second project",
      slug: "burst-second-project",
      externalRef: "proj_burst_second",
      organizationId: organization.id,
    },
  });
  const second = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: "burst-second-env",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "burst_second_api_key",
      pkApiKey: "burst_second_pk_api_key",
      shortcode: "burst_second",
    },
  });
  return second;
}

function testGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Test gate was not released")), 10_000);
    release = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, release: () => release() };
}

for (const poolSize of [1, 2]) {
  containerTest(
    `keyed creation isolates a shared pool of ${poolSize} connections`,
    async ({ prisma, postgresContainer, redisOptions }) => {
      const url = new URL(postgresContainer.getConnectionUri());
      url.searchParams.set("connection_limit", String(poolSize));
      url.searchParams.set("pool_timeout", "1");
      const limited = new PrismaClient({ datasources: { db: { url: url.href } } });
      const isolatedUrl = new URL(url);
      const application = `key_lane_${poolSize}_${Date.now()}`;
      isolatedUrl.searchParams.set("connection_limit", String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE));
      isolatedUrl.searchParams.set("application_name", application);
      let laneClientsOpened = 0;
      const lane = new WaitpointKeyTransactionLane(() => {
        laneClientsOpened++;
        return new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });
      });
      registerWaitpointKeyTransactionLane(limited, lane);
      const barrier = await waitpointStoreBarrier(redisOptions);
      const store = new WaitpointStoreCoordinator({ redisOptions: barrier.redisOptions });
      const snapshotStore = new RedisSnapshotStore({ redisOptions });
      const options = {
        store,
        snapshotStore,
        resolveDial: () => "off" as const,
        workerDisabled: true,
      };
      const firstEngine = makeEngine(limited, redisOptions, options);
      const secondEngine = makeEngine(limited, redisOptions, options);
      const pending: Promise<Awaited<ReturnType<typeof firstEngine.createDateTimeWaitpoint>>>[] =
        [];
      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const unrelated = await prisma.organization.create({
          data: { title: "Unrelated", slug: `pool-isolation-${poolSize}` },
        });
        const params = {
          runId: generateRunOpsId(),
          projectId: environment.project.id,
          environmentId: environment.id,
          organizationId: environment.organization.id,
          completedAfter: new Date(Date.now() + 3_600_000),
        };
        const darkEngine = makeEngine(limited, redisOptions, { ...options, enabled: false });
        try {
          await darkEngine.createDateTimeWaitpoint({ ...params, idempotencyKey: "dark-key" });
          expect(laneClientsOpened).toBe(0);
        } finally {
          await darkEngine.quit();
        }
        await firstEngine.createDateTimeWaitpoint({
          ...params,
          organizationId: undefined,
          idempotencyKey: "missing-org",
        });
        expect(laneClientsOpened).toBe(0);
        await firstEngine.createDateTimeWaitpoint({ ...params, idempotencyKey: "warmup" });
        const baselineStarted = performance.now();
        await limited.organization.findUniqueOrThrow({ where: { id: unrelated.id } });
        const baselineMs = performance.now() - baselineStarted;
        const held = barrier.pause((args) => ["evalsha", "eval"].includes(args[0].toLowerCase()));
        pending.push(firstEngine.createDateTimeWaitpoint({ ...params, idempotencyKey: "same" }));
        await held;
        pending.push(secondEngine.createDateTimeWaitpoint({ ...params, idempotencyKey: "same" }));
        pending.push(
          secondEngine.createDateTimeWaitpoint({ ...params, idempotencyKey: "different" })
        );
        await expect
          .poll(async () => {
            const rows = await prisma.$queryRaw<
              Array<{ n: number }>
            >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${application} AND state = 'idle in transaction'`;
            return rows[0].n;
          })
          .toBe(1);
        // This timed out with P2024 before isolation, including for unrelated organisations.
        const queryStarted = performance.now();
        expect(
          (await limited.organization.findUniqueOrThrow({ where: { id: unrelated.id } })).id
        ).toBe(unrelated.id);
        console.info("keyed waitpoint pool isolation", {
          poolSize,
          baselineMs,
          delayedClaimQueryMs: performance.now() - queryStarted,
        });
        expect(laneClientsOpened).toBe(1);
        barrier.release();
        const [first, same, different] = await Promise.all(pending);
        expect(first.waitpoint.id).toBe(same.waitpoint.id);
        expect(same.isCached).toBe(true);
        expect(different.waitpoint.id).not.toBe(first.waitpoint.id);
      } finally {
        barrier.release();
        await Promise.allSettled(pending);
        await firstEngine.quit();
        await secondEngine.quit();
        await lane.close();
        await store.quit();
        await snapshotStore.quit();
        await limited.$disconnect();
        await barrier.close();
      }
    }
  );
}

containerTest(
  "healthy keyed bursts preserve shared namespaces and organisation isolation",
  async ({ prisma, postgresContainer, redisOptions }) => {
    const url = new URL(postgresContainer.getConnectionUri());
    url.searchParams.set("connection_limit", String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE));
    const lane = new WaitpointKeyTransactionLane(
      () => new PrismaClient({ datasources: { db: { url: url.href } } })
    );
    registerWaitpointKeyTransactionLane(prisma, lane);
    const store = new WaitpointStoreCoordinator({ redisOptions });
    const snapshotStore = new RedisSnapshotStore({ redisOptions });
    const engine = makeEngine(prisma, redisOptions, {
      store,
      snapshotStore,
      resolveDial: () => "off",
      workerDisabled: true,
    });
    try {
      const first = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const second = await secondEnvironment(prisma);
      const environments = [first, second];
      const paramsFor = (index: number) => {
        const environment = environments[index];
        return {
          runId: generateRunOpsId(),
          projectId: environment.projectId,
          environmentId: environment.id,
          organizationId: environment.organizationId,
          completedAfter: new Date(Date.now() + 3_600_000),
        };
      };
      await engine.createDateTimeWaitpoint({ ...paramsFor(0), idempotencyKey: "burst-warmup" });
      const measurements = [];
      for (const count of [20, 80, 200]) {
        const started = performance.now();
        // Direct engine calls: distinct keys, one attempt each, with no SDK retries.
        const results = await Promise.allSettled([
          ...Array.from({ length: count }, (_, index) =>
            engine.createDateTimeWaitpoint({
              ...paramsFor(0),
              idempotencyKey: `burst-${count}-${index}`,
            })
          ),
          engine.createDateTimeWaitpoint({
            ...paramsFor(1),
            idempotencyKey: `burst-${count}-0`,
          }),
        ]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : []
        );
        measurements.push({
          count,
          successes: results.length - errors.length,
          elapsedMs: performance.now() - started,
          errors,
        });
        console.info("healthy keyed waitpoint burst", measurements.at(-1));
        if (errors.length > 0) continue;
        const values = results.map((result) => {
          if (result.status !== "fulfilled") throw result.reason;
          return result.value;
        });
        expect(new Set(values.map((value) => value.waitpoint.id)).size).toBe(count + 1);
        const manual = await engine.createManualWaitpoint({
          ...paramsFor(0),
          idempotencyKey: `burst-${count}-0`,
        });
        expect(manual.isCached).toBe(true);
        expect(manual.waitpoint.id).toBe(values[0].waitpoint.id);
        expect(manual.waitpoint.type).toBe("DATETIME");
      }
      const overloaded = Promise.allSettled(
        Array.from({ length: 1_500 }, (_, index) =>
          engine.createDateTimeWaitpoint({ ...paramsFor(0), idempotencyKey: `overload-${index}` })
        )
      );
      const independentStarted = performance.now();
      const independent = await Promise.allSettled([
        engine.createDateTimeWaitpoint({ ...paramsFor(1), idempotencyKey: "overload-independent" }),
      ]);
      const independentMs = performance.now() - independentStarted;
      const overloadedResults = await overloaded;
      console.info("overloaded keyed waitpoint organisation isolation", {
        count: overloadedResults.length,
        successes: overloadedResults.filter((result) => result.status === "fulfilled").length,
        independentMs,
        independentStatus: independent[0].status,
      });
      expect(independent[0].status).toBe("fulfilled");
      expect(independentMs).toBeLessThan(2_500);
      expect(measurements.map(({ count, errors }) => ({ count, errors }))).toEqual(
        [20, 80, 200].map((count) => ({ count, errors: [] }))
      );
    } finally {
      await engine.quit();
      await lane.close();
      await store.quit();
      await snapshotStore.quit();
    }
  }
);

containerTest(
  "a held advisory lock does not delay another organisation or outlive its creation budget",
  async ({ prisma, postgresContainer, redisOptions }) => {
    const url = new URL(postgresContainer.getConnectionUri());
    url.searchParams.set("connection_limit", String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE));
    const application = `key_lock_${Date.now()}`;
    url.searchParams.set("application_name", application);
    const lane = new WaitpointKeyTransactionLane(
      () => new PrismaClient({ datasources: { db: { url: url.href } } })
    );
    registerWaitpointKeyTransactionLane(prisma, lane);
    const store = new WaitpointStoreCoordinator({ redisOptions });
    const snapshotStore = new RedisSnapshotStore({ redisOptions });
    const engine = makeEngine(prisma, redisOptions, {
      store,
      snapshotStore,
      resolveDial: () => "off",
      workerDisabled: true,
    });
    const held = testGate();
    let locked = false;
    let holder: Promise<unknown> | undefined;
    let blocked: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const independentEnvironment = await secondEnvironment(prisma);
      const params = {
        runId: generateRunOpsId(),
        projectId: environment.project.id,
        environmentId: environment.id,
        organizationId: environment.organization.id,
        completedAfter: new Date(Date.now() + 3_600_000),
      };
      await engine.createDateTimeWaitpoint({ ...params, idempotencyKey: "warmup" });
      holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([environment.id, "held"])}, 0))::text`;
          locked = true;
          await held.promise;
        },
        { timeout: 12_000 }
      );
      await expect
        .poll(() => locked, { timeout: 2_000, message: "holder never acquired advisory lock" })
        .toBe(true);
      const blockedStarted = performance.now();
      blocked = Promise.allSettled([
        engine.createDateTimeWaitpoint({ ...params, idempotencyKey: "held" }),
      ]);
      await expect
        .poll(
          async () => {
            const rows = await prisma.$queryRaw<
              Array<{ n: number }>
            >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${application} AND wait_event = 'advisory'`;
            return rows[0].n;
          },
          { timeout: 2_000, message: "keyed creator never waited on the held advisory lock" }
        )
        .toBe(1);
      const independentStarted = performance.now();
      const independent = await Promise.allSettled([
        engine.createDateTimeWaitpoint({
          ...params,
          organizationId: independentEnvironment.organizationId,
          projectId: independentEnvironment.projectId,
          environmentId: independentEnvironment.id,
          idempotencyKey: "independent",
        }),
      ]);
      const independentMs = performance.now() - independentStarted;
      console.info("held keyed lock organisation isolation", {
        independentMs,
        status: independent[0].status,
      });
      expect(independent[0].status).toBe("fulfilled");
      expect(independentMs).toBeLessThan(2_500);
      expect((await blocked)[0].status).toBe("rejected");
      expect(performance.now() - blockedStarted).toBeLessThan(5_500);
      const waiting = await prisma.$queryRaw<
        Array<{ n: number }>
      >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${application} AND wait_event = 'advisory'`;
      expect(waiting[0].n).toBe(0);
      console.info("keyed advisory wait cancellation", {
        elapsedMs: performance.now() - blockedStarted,
        waiting: waiting[0].n,
        externalLockStillHeld: true,
      });
    } finally {
      held.release();
      await holder;
      await blocked;
      await engine.quit();
      await lane.close();
      await store.quit();
      await snapshotStore.quit();
    }
  }
);

postgresTest(
  "lane bounds active organisations, rotates ready work, expires waiters and drains rollback on shutdown",
  async ({ prisma, postgresContainer }) => {
    const url = new URL(postgresContainer.getConnectionUri());
    url.searchParams.set("connection_limit", String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE));
    let opened = 0;
    let isolated!: PrismaClient;
    const lane = new WaitpointKeyTransactionLane(() => {
      opened++;
      return (isolated = new PrismaClient({ datasources: { db: { url: url.href } } }));
    });
    const gates = Array.from({ length: WAITPOINT_KEY_TRANSACTION_POOL_SIZE }, () => testGate());
    const admitted: number[] = [];
    let activeCount = 0;
    let maxActive = 0;
    const active: Promise<unknown>[] = [];
    let shutdownActive: Promise<unknown>[] = [];
    const shutdownGates = [testGate(), testGate()];
    try {
      expect(opened).toBe(0);
      await expect(lane.run("", Date.now() + 4_500, async () => "must not enter")).rejects.toThrow(
        "requires organization context"
      );
      expect(opened).toBe(0);
      await expect(
        lane.run("org-0", Date.now() + 4_500, async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          throw new Error("callback rolled back");
        })
      ).rejects.toThrow("callback rolled back");
      const rollbackSettings = await isolated.$queryRaw<
        Array<{ lockTimeout: string; statementTimeout: string }>
      >`SELECT current_setting('lock_timeout') AS "lockTimeout", current_setting('statement_timeout') AS "statementTimeout"`;
      expect(rollbackSettings[0]).toEqual({ lockTimeout: "0", statementTimeout: "0" });
      const run = (org: number, held?: ReturnType<typeof testGate>) =>
        lane.run(`org-${org}`, Date.now() + 4_500, async (tx) => {
          activeCount++;
          maxActive = Math.max(maxActive, activeCount);
          admitted.push(org);
          try {
            await tx.$queryRaw`SELECT 1`;
            await held?.promise;
          } finally {
            activeCount--;
          }
        });
      active.push(...gates.map((gate, org) => run(org, gate)));
      await expect
        .poll(() => admitted.length, {
          timeout: 2_000,
          message: "four organisations never entered",
        })
        .toBe(4);
      let expiredCallbacks = 0;
      const expired = await Promise.allSettled(
        Array.from({ length: 80 }, () =>
          lane.run("org-0", Date.now() + 100, async () => {
            expiredCallbacks++;
          })
        )
      );
      expect(
        expired.map((result) =>
          result.status === "rejected" ? String(result.reason) : "unexpected admission"
        )
      ).toEqual(
        Array(80).fill(
          "WaitpointKeyTransactionBudgetExhaustedError: Keyed waitpoint creation transaction budget exhausted"
        )
      );
      expect(expiredCallbacks).toBe(0);
      // The active org's second request must join BEHIND already-ready other orgs.
      active.push(run(0), run(4), run(5));
      gates[0].release();
      await expect
        .poll(() => admitted.length, {
          timeout: 2_000,
          message: "ready organisations never progressed",
        })
        .toBe(7);
      expect(admitted.slice(4)).toEqual([4, 5, 0]);
      expect(maxActive).toBe(WAITPOINT_KEY_TRANSACTION_POOL_SIZE);
      console.info("keyed lane fairness", {
        maxActive,
        rotatedOrgOrder: admitted.slice(4),
        expiredCallbacks,
      });
      gates.forEach((gate) => gate.release());
      await Promise.all(active);
      const settings = await isolated.$queryRaw<
        Array<{ lockTimeout: string; statementTimeout: string }>
      >`SELECT current_setting('lock_timeout') AS "lockTimeout", current_setting('statement_timeout') AS "statementTimeout"`;
      expect(settings[0]).toEqual({ lockTimeout: "0", statementTimeout: "0" });
      // Reusing an idle org after expiry/rotation can enter again.
      await run(0);
      let shutdownEntered = 0;
      shutdownActive = shutdownGates.map((gate, index) =>
        lane.run(`shutdown-${index}`, Date.now() + 4_500, async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(748, ${index}::int)::text`;
          shutdownEntered++;
          await gate.promise;
          if (index === 1) throw new Error("shutdown rollback");
          return "shutdown done";
        })
      );
      const settled = Promise.allSettled(shutdownActive);
      await expect
        .poll(() => shutdownEntered, {
          timeout: 2_000,
          message: "shutdown transactions never entered",
        })
        .toBe(2);
      const queued = lane.run("shutdown-0", Date.now() + 4_500, async () => "must not enter");
      const rejected = expect(queued).rejects.toThrow("lane is closed");
      let closed = false;
      const closing = lane.close().then(() => {
        closed = true;
      });
      await rejected;
      await expect(
        lane.run("closed", Date.now() + 4_500, async () => "must not enter")
      ).rejects.toThrow("lane is closed");
      shutdownGates[0].release();
      expect(await shutdownActive[0]).toBe("shutdown done");
      // close still waits for the second admitted transaction and its rollback.
      expect(closed).toBe(false);
      shutdownGates[1].release();
      expect((await settled)[1]).toMatchObject({
        status: "rejected",
        reason: new Error("shutdown rollback"),
      });
      await closing;
      const lock = await prisma.$queryRaw<
        Array<{ acquired: boolean }>
      >`SELECT pg_try_advisory_xact_lock(748, 1) AS acquired`;
      expect(lock[0].acquired).toBe(true);
      expect(opened).toBe(1);
    } finally {
      gates.forEach((gate) => gate.release());
      shutdownGates.forEach((gate) => gate.release());
      await Promise.allSettled([...active, ...shutdownActive]);
      await lane.close();
    }
  }
);

postgresTest(
  "missing isolated lane fails closed before opening an ordinary transaction",
  async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    expect(() =>
      store.runInWaitpointKeyTransaction(undefined, "org", Date.now() + 4_500, async () => "no")
    ).toThrow("requires an isolated transaction lane");
  }
);
