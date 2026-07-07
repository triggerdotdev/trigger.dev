import { describe, expect, vi } from "vitest";

// Regression for the waitpoint-token completion route path: the route calls
// engine.completeWaitpoint, which must consult the cross-seam residency guard
// FIRST (routeKind "RESUME_TOKEN") and only then delegate the completion. A
// guard that throws (unclassifiable) must propagate loudly and leave the
// waitpoint PENDING — never a silent local apply. Single default store only.

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { trace } from "@opentelemetry/api";

vi.setConfig({ testTimeout: 60_000 });

type CrossSeamGuard = ConstructorParameters<typeof RunEngine>[0]["crossSeamGuard"];

function buildEngine(opts: { prisma: any; redisOptions: any; crossSeamGuard?: CrossSeamGuard }) {
  return new RunEngine({
    prisma: opts.prisma,
    ...(opts.crossSeamGuard ? { crossSeamGuard: opts.crossSeamGuard } : {}),
    worker: {
      redis: opts.redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: opts.redisOptions,
    },
    runLock: {
      redis: opts.redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

describe("waitpoint-token complete route — cross-seam guard", () => {
  // The completion path consults the guard FIRST with routeKind RESUME_TOKEN
  // recording the waitpointId, then delegates and the waitpoint becomes COMPLETED.
  containerTest(
    "consults the guard first (RESUME_TOKEN), then completes (single-store)",
    async ({ prisma, redisOptions }) => {
      const seen: Array<{ waitpointId: string; routeKind: string }> = [];
      const engine = buildEngine({
        prisma,
        redisOptions,
        crossSeamGuard: async ({ waitpointId, routeKind }) => {
          seen.push({ waitpointId, routeKind });
          // Single-store / split-OFF returns the single ("legacy") store; the
          // engine delegates regardless of decision.store.
          return { store: "legacy", residency: "LEGACY", routeKind };
        },
      });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
        });
        expect(waitpoint.status).toBe("PENDING");

        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "{}", isError: false },
        });

        // The guard was consulted first, with the right id + RESUME_TOKEN route kind.
        expect(seen).toEqual([{ waitpointId: waitpoint.id, routeKind: "RESUME_TOKEN" }]);

        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // An injected guard that throws (unclassifiable) causes completeWaitpoint
  // to reject and the waitpoint stays PENDING (loud, not silently applied).
  containerTest(
    "propagates a guard throw and leaves the waitpoint PENDING (loud)",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine({
        prisma,
        redisOptions,
        crossSeamGuard: async () => {
          throw new Error("UnclassifiableRunId");
        },
      });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
        });
        expect(waitpoint.status).toBe("PENDING");

        await expect(
          engine.completeWaitpoint({ id: waitpoint.id, output: { value: "{}", isError: false } })
        ).rejects.toThrow();

        // The throw short-circuited before delegation — no silent local apply.
        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );
});

// no-FK-abort: with the Waitpoint table split off control-plane, the env/project Cascade
// FKs are physically absent. Completing a waitpoint (status flip) must not trip a now-missing FK
// on EITHER the PG14 (legacy) or PG17 (new) store. Seed + complete on the SAME store (single-store
// write, no two-store router). The DB is never mocked: writes hit the real PG14/PG17 containers.
const WAITPOINT_CROSS_SEAM_FKS = [
  "Waitpoint_environmentId_fkey",
  "Waitpoint_projectId_fkey",
] as const;

async function dropWaitpointCrossSeamFks(prisma: PrismaClient) {
  for (const c of WAITPOINT_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Waitpoint" DROP CONSTRAINT IF EXISTS "${c}"`);
  }
}

let waitpointSeq = 0;

// Seed a PENDING MANUAL waitpoint, then complete it (status flip) on the SAME store.
async function seedAndCompleteOnStore(store: PrismaClient) {
  const s = waitpointSeq++;
  const { id, friendlyId } = WaitpointId.generate();
  await store.waitpoint.create({
    data: {
      id,
      friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_nofk_${s}`,
      userProvidedIdempotencyKey: false,
      // No matching env/project row on this store (they'd live on the other DB).
      environmentId: `env_other_db_${s}`,
      projectId: `proj_other_db_${s}`,
    },
  });

  await store.waitpoint.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      output: JSON.stringify({ value: "{}" }),
      outputType: "application/json",
      outputIsError: false,
    },
  });

  return store.waitpoint.findFirst({ where: { id }, select: { id: true, status: true } });
}

describe("waitpoint-token complete route — no FK abort across the PG14<->17 boundary", () => {
  heteroPostgresTest(
    "completes a run-ops waitpoint on each version store without tripping the absent control-plane Cascade FK",
    async ({ prisma14, prisma17 }) => {
      const legacy = prisma14 as unknown as PrismaClient;
      const next = prisma17 as unknown as PrismaClient;

      await dropWaitpointCrossSeamFks(legacy);
      const completedOnLegacy = await seedAndCompleteOnStore(legacy);
      expect(completedOnLegacy).not.toBeNull();
      expect(completedOnLegacy!.status).toBe("COMPLETED");

      await dropWaitpointCrossSeamFks(next);
      const completedOnNew = await seedAndCompleteOnStore(next);
      expect(completedOnNew).not.toBeNull();
      expect(completedOnNew!.status).toBe("COMPLETED");
    }
  );
});
