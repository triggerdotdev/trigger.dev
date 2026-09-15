import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { classifyResidency } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

const ORG_ID = "orgroute0000000000000001";
const PROJ_ID = "projroute00000000000001";
const ENV_ID = "envroute0000000000000001";

const newId = (i: number) => "k".repeat(20) + String(i).padStart(4, "0") + "01";
const cuidId = (i: number) => "c".repeat(21) + String(i).padStart(4, "0");

async function seedShared(prisma: PrismaClient, suffix: string) {
  await prisma.organization.create({
    data: { id: ORG_ID, title: `Route ${suffix}`, slug: `route-${suffix}` },
  });
  await prisma.project.create({
    data: {
      id: PROJ_ID,
      name: `Route ${suffix}`,
      slug: `route-${suffix}`,
      externalRef: `proj_route_${suffix}`,
      organizationId: ORG_ID,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ENV_ID,
      type: "PRODUCTION",
      slug: "prod",
      projectId: PROJ_ID,
      organizationId: ORG_ID,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
}

const BASE = new Date("2026-01-01T00:00:00.000Z").getTime();

async function seedRun(prisma: PrismaClient, id: string, offsetSec: number) {
  await prisma.taskRun.create({
    data: {
      id,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: `run_${id}`,
      runtimeEnvironmentId: ENV_ID,
      environmentType: "PRODUCTION",
      organizationId: ORG_ID,
      projectId: PROJ_ID,
      taskIdentifier: "route-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: `trace_${id}`,
      spanId: `span_${id}`,
      queue: "task/route",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date(BASE + offsetSec * 1000),
    },
  });
}

describe("RoutingRunStore id-set residency routing", () => {
  heteroPostgresTest(
    "routes each id to its owning store and merges in orderBy order",
    { timeout: 120000 },
    async ({ prisma14, prisma17 }) => {
      for (let i = 0; i < 5; i++) {
        expect(classifyResidency(newId(i))).toBe("NEW");
        expect(classifyResidency(cuidId(i))).toBe("LEGACY");
      }

      await seedShared(prisma14, "legacy");
      await seedShared(prisma17, "new");

      for (let i = 0; i < 5; i++) {
        await seedRun(prisma17, newId(i), i * 2 + 1);
        await seedRun(prisma14, cuidId(i), i * 2);
      }

      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const mixedIds = [0, 1, 2, 3, 4].flatMap((i) => [newId(i), cuidId(i)]);
      const globalDesc = [
        newId(4),
        cuidId(4),
        newId(3),
        cuidId(3),
        newId(2),
        cuidId(2),
        newId(1),
        cuidId(1),
        newId(0),
        cuidId(0),
      ];

      const all = (await router.findRuns({
        where: { id: { in: mixedIds } },
        orderBy: { createdAt: "desc" },
        take: 100,
      })) as Array<{ id: string }>;
      expect(all.map((r) => r.id)).toEqual(globalDesc);

      const top4 = (await router.findRuns({
        where: { id: { in: mixedIds } },
        orderBy: { createdAt: "desc" },
        take: 4,
      })) as Array<{ id: string }>;
      expect(top4.map((r) => r.id)).toEqual(globalDesc.slice(0, 4));

      const newOnly = (await router.findRuns({
        where: { id: { in: [newId(0), newId(2), newId(4)] } },
        orderBy: { createdAt: "asc" },
      })) as Array<{ id: string }>;
      expect(newOnly.map((r) => r.id)).toEqual([newId(0), newId(2), newId(4)]);

      const legacyOnly = (await router.findRuns({
        where: { id: { in: [cuidId(1), cuidId(3)] } },
        orderBy: { createdAt: "asc" },
      })) as Array<{ id: string }>;
      expect(legacyOnly.map((r) => r.id)).toEqual([cuidId(1), cuidId(3)]);
    }
  );
});
