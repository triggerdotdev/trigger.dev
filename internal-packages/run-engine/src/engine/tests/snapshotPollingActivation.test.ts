import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { CompletedWaitpointHydratingRunStore, PostgresRunStore } from "@internal/run-store";
import { generateInternalId, generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import {
  buildCompletedWaitpointRecords,
  expandCompletedWaitpointRecords,
} from "../systems/completedWaitpointResolver.js";
import { resolveCompletedWaitpointRecords } from "../systems/completedWaitpointRecordAdapter.js";
import { getExecutionSnapshotsSince } from "../systems/executionSnapshotSystem.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import {
  organizationFlagResolver,
  organizationQueryCounter,
} from "./utils/organizationFlagLookups.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../../run-store/src/testFixtures/snapshotIdFixture.js";

describe("snapshot polling activation", () => {
  containerTestWithIsolatedRedis(
    "snapshot polling returns legacy results by default and OFF, and hydrates enabled mixed results",
    async ({ prisma, redisOptions }) => {
      // db-push fixtures retain this FK; production migration drops it for shared native links.
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"'
      );
      const env = await seedSnapshotEnvironment(prisma);
      const postgres = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const native = new WaitpointStoreCoordinator({ redisOptions });
      let enabled = false;
      const isEnabled = (organizationId: string) => {
        return enabled && organizationId === env.organizationId;
      };
      const store = new CompletedWaitpointHydratingRunStore(postgres, {
        isEnabled,
        resolve: async (ids, context) => {
          const records = await resolveCompletedWaitpointRecords({
            requestedIds: ids,
            legacyReader: async (legacyIds) =>
              buildCompletedWaitpointRecords(
                await prisma.waitpoint.findMany({ where: { id: { in: legacyIds } } })
              ),
            storeReader: (storeIds) => native.readCompletedRecords(storeIds, context.runId),
          });
          return expandCompletedWaitpointRecords(
            {
              runId: context.runId,
              pointer: { cycleSeq: 1, count: records.length },
              order: ids,
              records,
            },
            () => undefined
          );
        },
      });
      const engine = new RunEngine({
        prisma,
        store,
        waitpointStoreEnabled: isEnabled,
        worker: { redis: redisOptions, disabled: true },
        queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("snapshot-polling-activation"),
      });
      try {
        // An existing PG parent can observe an independently native shared child completion.
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await postgres.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: birthId,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "old PG parent",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });
        const legacy = await prisma.waitpoint.create({
          data: {
            friendlyId: `waitpoint_${generateInternalId()}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date(),
            output: "legacy-output",
            outputType: "text/plain",
            idempotencyKey: generateInternalId(),
            userProvidedIdempotencyKey: false,
            projectId: env.projectId,
            environmentId: env.id,
          },
        });
        const nativeId = generateWaitpointId("RUN");
        await native.createIfAbsent({
          record: {
            id: nativeId,
            friendlyId: `waitpoint_${nativeId}`,
            type: "RUN",
            projectId: env.projectId,
            environmentId: env.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await native.complete({
          waitpointId: nativeId,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "text/plain",
            outputIsError: false,
            output: { inline: "native-output" },
          },
        });
        const selectedId = generateInternalId();
        await postgres.createExecutionSnapshot({
          id: selectedId,
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "mixed completion" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [
            { id: legacy.id, index: 0 },
            { id: nativeId, index: 1 },
            { id: nativeId, index: 2 },
          ],
        });
        expect(await prisma.waitpoint.findUnique({ where: { id: nativeId } })).toBeNull();
        const defaultResult = await getExecutionSnapshotsSince(prisma, runId, birthId, store);
        expect(defaultResult[0]!.completedWaitpoints.map((w) => w.output)).toEqual([
          "legacy-output",
        ]);
        const off = await engine.getSnapshotsSince({ runId, snapshotId: birthId });
        expect(off?.[0]!.completedWaitpoints.map((w) => w.output)).toEqual(["legacy-output"]);
        enabled = true;
        const on = await engine.getSnapshotsSince({ runId, snapshotId: birthId });
        expect(on?.[0]!.snapshot.id).toBe(selectedId);
        expect(on?.[0]!.completedWaitpoints.map((w) => [w.id, w.index, w.output])).toEqual([
          [legacy.id, 0, "legacy-output"],
          [nativeId, 1, "native-output"],
          [nativeId, 2, "native-output"],
        ]);
      } finally {
        await engine.quit();
        await native.quit();
      }
    }
  );

  // Catches: polling a snapshot with no completed waitpoints resolving the org flag, or a poll
  // resolving it more than once.
  containerTestWithIsolatedRedis(
    "snapshot polling resolves the flag only when the snapshot has completed waitpoints",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const counter = organizationQueryCounter(postgresContainer.getConnectionUri());
      const env = await seedSnapshotEnvironment(prisma);
      await prisma.organization.update({
        where: { id: env.organizationId },
        data: { featureFlags: { waitpointStoreEnabled: false } },
      });
      const postgres = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({
        prisma,
        store: postgres,
        waitpointStoreEnabled: organizationFlagResolver(counter.client),
        worker: { redis: redisOptions, disabled: true },
        queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("snapshot-polling-activation"),
      });
      const seedRun = async (completedWaitpoints: { id: string; index: number }[]) => {
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await postgres.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: birthId,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });
        await postgres.createExecutionSnapshot({
          id: generateInternalId(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "resumed" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints,
        });
        return { runId, snapshotId: birthId };
      };
      try {
        const legacy = await prisma.waitpoint.create({
          data: {
            friendlyId: `waitpoint_${generateInternalId()}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date(),
            output: "legacy-output",
            outputType: "text/plain",
            idempotencyKey: generateInternalId(),
            userProvidedIdempotencyKey: false,
            projectId: env.projectId,
            environmentId: env.id,
          },
        });
        const withLegacy = await seedRun([{ id: legacy.id, index: 0 }]);
        const withNone = await seedRun([]);

        const polledLegacy = await counter.measure(() => engine.getSnapshotsSince(withLegacy));
        const polledNone = await counter.measure(() => engine.getSnapshotsSince(withNone));
        expect({ legacy: polledLegacy.lookups, none: polledNone.lookups }).toEqual({
          legacy: 1,
          none: 0,
        });
        expect(polledLegacy.result?.[0]!.completedWaitpoints.map((w) => w.output)).toEqual([
          "legacy-output",
        ]);
        expect(polledNone.result?.[0]!.completedWaitpoints).toEqual([]);
      } finally {
        await engine.quit();
        await counter.client.$disconnect();
      }
    }
  );
});
