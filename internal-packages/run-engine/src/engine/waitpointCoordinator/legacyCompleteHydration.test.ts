import { PostgresRunStore } from "@internal/run-store";
import { postgresTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { LegacyPostgresWaitpointCoordinator } from "./legacyPostgresCoordinator.js";
import { parent } from "../tests/utils/waitpointRouting.js";

describe("LegacyPostgresWaitpointCoordinator completion query cost", () => {
  postgresTest(
    "returns blocked runs without issuing a TaskRun hydration query",
    async ({ prisma, postgresContainer }) => {
      const client = new PrismaClient({
        datasources: { db: { url: postgresContainer.getConnectionUri() } },
        log: [{ emit: "event", level: "query" }],
      });
      const queries: string[] = [];
      // Prisma's native query log observes real SQL; no coordinator or store method is replaced.
      client.$on("query", ({ query }) => queries.push(query));
      const runStore = new PostgresRunStore({ prisma: client, readOnlyPrisma: client });
      const coordinator = new LegacyPostgresWaitpointCoordinator({
        runStore: () => runStore,
        prisma: client,
        logger: new Logger("legacyCompleteHydration.test", "error"),
      });
      try {
        const args = await parent(prisma);
        const waitpoint = await coordinator.createDateTimeWaitpoint({
          ...args,
          completedAfter: new Date(),
        });
        await coordinator.registerBlocks({
          ...args,
          client,
          waitpointIds: [waitpoint.waitpoint.id],
        });
        queries.length = 0;
        const completed = await coordinator.complete({ waitpointId: waitpoint.waitpoint.id });
        expect(completed.blockedRuns).toEqual([
          { taskRunId: args.runId, spanIdToComplete: null, createdAt: expect.any(Date) },
        ]);
        expect(queries.some((query) => query.includes('"TaskRunWaitpoint"'))).toBe(true);
        expect(queries.filter((query) => query.includes('"TaskRun"'))).toEqual([]);
      } finally {
        await client.$disconnect();
      }
    }
  );
});
