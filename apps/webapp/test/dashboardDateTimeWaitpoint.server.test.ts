import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe, expect } from "vitest";
import { RunEngine } from "../../../internal-packages/run-engine/src/engine/index.js";
import { WaitpointStoreCoordinator } from "../../../internal-packages/run-engine/src/engine/waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../../../internal-packages/run-engine/src/engine/waitpointCoordinator/storeWaitpointCoordinator.js";
import { createRedisClient } from "@internal/redis";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "@internal/run-store";
import {
  waitpointRelatedRunsKey,
  waitpointKeys,
} from "../../../internal-packages/run-engine/src/engine/waitpointCoordinator/keys.js";
import { triggerRun } from "../../../internal-packages/run-engine/src/engine/tests/utils/storeRunWaitpointLifecycleFixtures.js";
import {
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "../../../internal-packages/run-engine/src/engine/tests/setup.js";
import {
  isStoreDateTimeWaitpoint,
  resolveDashboardDateTimeWaitpoint,
  resolveDashboardWaitpointRelatedRuns,
  skipDashboardDateTimeWaitpoint,
} from "~/services/dashboardDateTimeWaitpoint.server";

describe("dashboardDateTimeWaitpoint.server", () => {
  // Catches: dashboard DATETIME detail, skip or related-runs reads crossing tenants, moving the deadline, overwriting the first completion, or failing open once the store is disabled or unavailable.
  containerTest(
    "dashboard duration details and skip retain tenant fences, deadlines and the first completion",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      const shortStore = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 1000 });
      const shortAdapter = new StoreWaitpointCoordinator({ store: shortStore });
      const redis = createRedisClient(redisOptions);
      let enabled = true;
      const enabledOrganizations = new Set<string>();
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("dashboard-waitpoint-test"),
        waitpointStore: store,
        waitpointRouting: { store: adapter },
        waitpointStoreEnabled: (organizationId) =>
          enabled && enabledOrganizations.has(organizationId),
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        enabledOrganizations.add(env.organization.id);
        const deadline = new Date(Date.now() + 600_000);
        const { waitpoint } = await adapter.createDateTimeWaitpoint({
          projectId: env.project.id,
          environmentId: env.id,
          completedAfter: deadline,
          idempotencyKey: "dashboard-duration-key",
          idempotencyKeyExpiresAt: new Date(Date.now() + 3_600_000),
        });
        const scope = {
          friendlyId: waitpoint.friendlyId,
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        };
        expect(isStoreDateTimeWaitpoint(waitpoint.id)).toBe(true);
        expect(await resolveDashboardDateTimeWaitpoint(scope, engine)).toMatchObject({
          id: waitpoint.id,
          friendlyId: waitpoint.friendlyId,
          type: "DATETIME",
          status: "PENDING",
          completedAfter: deadline,
          idempotencyKey: "dashboard-duration-key",
          userProvidedIdempotencyKey: true,
          tags: [],
        });
        expect(await prisma.waitpoint.count({ where: { id: waitpoint.id } })).toBe(0);
        expect(
          await resolveDashboardDateTimeWaitpoint({ ...scope, environmentId: "other-env" }, engine)
        ).toBeNull();
        expect(
          await resolveDashboardDateTimeWaitpoint({ ...scope, projectId: "other-project" }, engine)
        ).toBeNull();
        expect(
          await resolveDashboardDateTimeWaitpoint({ ...scope, organizationId: "other-org" }, engine)
        ).toBeNull();

        await skipDashboardDateTimeWaitpoint(waitpoint.id, env.organization.id, engine);
        const skipped = await resolveDashboardDateTimeWaitpoint(scope, engine);
        expect(skipped).toMatchObject({
          status: "COMPLETED",
          completedAfter: deadline,
          output: null,
          outputIsError: false,
        });
        expect(skipped?.completedAt).toBeInstanceOf(Date);
        expect(skipped!.completedAt!.getTime()).toBeLessThan(deadline.getTime());
        // A retry and the ordinary deadline job use the same pending-only operation.
        await skipDashboardDateTimeWaitpoint(waitpoint.id, env.organization.id, engine);
        await engine.completeWaitpoint({
          id: waitpoint.id,
          organizationId: env.organization.id,
          onlyIfPending: true,
        });
        expect(await resolveDashboardDateTimeWaitpoint(scope, engine)).toEqual(skipped);

        const completed = await adapter.createDateTimeWaitpoint({
          projectId: env.project.id,
          environmentId: env.id,
          completedAfter: deadline,
        });
        await engine.completeWaitpoint({
          id: completed.waitpoint.id,
          organizationId: env.organization.id,
          output: { value: "false", type: "application/json", isError: false },
        });
        await skipDashboardDateTimeWaitpoint(completed.waitpoint.id, env.organization.id, engine);
        expect(
          await engine.getStoreDateTimeWaitpoint({ ...scope, waitpointId: completed.waitpoint.id })
        ).toMatchObject({ output: "false", status: "COMPLETED" });

        await setupBackgroundWorker(engine, env, ["related-run"]);
        const survivor = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "related-run",
        });
        const related = await shortAdapter.createDateTimeWaitpoint({
          projectId: env.project.id,
          environmentId: env.id,
          completedAfter: deadline,
        });
        const relationScope = { ...scope, waitpointId: related.waitpoint.id };
        const danglingIds = Array.from(
          { length: 26 },
          (_, i) => `${"0".repeat(20)}${i.toString(32).padStart(4, "0")}01`
        );
        const registeredIds = [...danglingIds, survivor.id];
        for (const runId of registeredIds)
          await shortStore.registerOrReport({
            waitpointId: related.waitpoint.id,
            runId,
            blockId: "related-history",
            createdAt: new Date().toISOString(),
          });
        const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        expect(await resolveDashboardWaitpointRelatedRuns(relationScope, engine, runStore)).toEqual(
          [survivor.friendlyId]
        );
        // Withdrawal and source completion consume watchers, never persistent relationships.
        for (const runId of registeredIds)
          await shortStore.unregisterWatcher({
            waitpointId: related.waitpoint.id,
            runId,
            blockId: "related-history",
          });
        expect(await resolveDashboardWaitpointRelatedRuns(relationScope, engine, runStore)).toEqual(
          [survivor.friendlyId]
        );
        const completedSurvivor = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "related-run",
        });
        await shortAdapter.complete({ waitpointId: related.waitpoint.id });
        expect(
          (
            await shortStore.registerOrReport({
              waitpointId: related.waitpoint.id,
              runId: completedSurvivor.id,
              blockId: "completed-history",
              createdAt: new Date().toISOString(),
            })
          ).outcome
        ).toBe("completed");
        expect(
          (await resolveDashboardWaitpointRelatedRuns(relationScope, engine, runStore)).sort()
        ).toEqual([survivor.friendlyId, completedSurvivor.friendlyId].sort());
        expect(await redis.zcard(waitpointRelatedRunsKey(related.waitpoint.id))).toBe(28);
        expect(await redis.pttl(waitpointRelatedRunsKey(related.waitpoint.id))).toBeGreaterThan(0);
        expect(
          await resolveDashboardWaitpointRelatedRuns(
            { ...relationScope, environmentId: "foreign-env" },
            engine,
            runStore
          )
        ).toEqual([]);
        await expect
          .poll(() => redis.exists(waitpointKeys(related.waitpoint.id).record), {
            timeout: 3000,
            interval: 20,
            message: "completed source never expired",
          })
          .toBe(0);
        expect(await redis.exists(waitpointRelatedRunsKey(related.waitpoint.id))).toBe(0);
        enabled = false;
        const legacy = await engine.createDateTimeWaitpoint({
          projectId: env.project.id,
          environmentId: env.id,
          organizationId: env.organization.id,
          completedAfter: deadline,
        });
        expect(isStoreDateTimeWaitpoint(legacy.waitpoint.id)).toBe(false);
        await engine.completeWaitpoint({
          id: legacy.waitpoint.id,
          organizationId: env.organization.id,
        });
        expect(
          await prisma.waitpoint.findFirst({ where: { id: legacy.waitpoint.id } })
        ).toMatchObject({ status: "COMPLETED", completedAfter: deadline });
        // Disabled/cross-org rejection must work even after the real store is unavailable.
        await store.quit();
        expect(await resolveDashboardDateTimeWaitpoint(scope, engine)).toBeNull();
        expect(await resolveDashboardWaitpointRelatedRuns(relationScope, engine, runStore)).toEqual(
          []
        );
        expect(
          await resolveDashboardDateTimeWaitpoint({ ...scope, organizationId: "other-org" }, engine)
        ).toBeNull();
      } finally {
        await engine.quit();
        await store.quit();
        await shortStore.quit();
        await redis.quit();
      }
    }
  );
});
