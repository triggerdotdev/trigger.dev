import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  type CompletedWaitpointRecord,
} from "@internal/run-store";
import { generateInternalId, generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { createSnapshotStoreRuntime } from "../app/v3/utils/snapshotStoreRuntime.server";
import { createSnapshotRolloutResolver } from "../app/v3/utils/snapshotStoreRollout.server";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../internal-packages/run-store/src/testFixtures/snapshotIdFixture.js";

describe("snapshotStoreRuntime", () => {
  containerTest(
    "snapshot runtime retains absent/OFF reads and hydrates enabled native RUN results from primary",
    async ({ prisma, redisOptions }) => {
      const env = await seedSnapshotEnvironment(prisma);
      const writer = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const childId = generateInternalId();
      const snapshot = {
        engine: "V2" as const,
        executionStatus: "RUN_CREATED" as const,
        description: "created",
        runStatus: "PENDING" as const,
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      };
      await writer.createRun({ data: buildCreateRunData(childId, env), snapshot });
      await prisma.taskRun.update({ where: { id: childId }, data: { output: "stale-output" } });
      const client = createRedisClient(redisOptions);
      const snapshots = new RedisSnapshotStore({ client, completedTtlMs: 60_000 });
      // Adapt the real standalone Redis fixture to the connection interface without replacing I/O.
      const connection = {
        getStore: () => snapshots,
        getClient: () => client,
        ready: async () => {
          await client.ping();
        },
        close: async () => {
          await client.quit();
        },
      } as unknown as Parameters<typeof createSnapshotStoreRuntime>[0]["connection"];
      try {
        await prisma.$transaction(
          async (frozenReader) => {
            expect(
              (await frozenReader.taskRun.findUniqueOrThrow({ where: { id: childId } })).output
            ).toBe("stale-output");
            await prisma.taskRun.update({
              where: { id: childId },
              data: { output: "committed-output" },
            });
            const leaf = new PostgresRunStore({ prisma, readOnlyPrisma: frozenReader as never });
            for (const enabled of [undefined, false, true]) {
              const organizations: string[] = [];
              const runtime = createSnapshotStoreRuntime({
                connection,
                rollout: createSnapshotRolloutResolver(
                  () => ({ snapshotStoreMode: "redis-only" }),
                  prisma
                ),
                getRunStore: () => leaf,
                ...(enabled === undefined
                  ? {}
                  : {
                      waitpointStoreEnabled: (organizationId: string) => {
                        organizations.push(organizationId);
                        return enabled;
                      },
                    }),
              });
              const store = runtime.decorate(leaf, `runtime-${enabled}`);
              const runId = generateInternalId();
              const birthId = generateInternalId();
              await store.createRun({
                data: buildCreateRunData(runId, env),
                snapshot: { ...snapshot, id: birthId },
              });
              const nativeId = generateWaitpointId("RUN");
              const legacyId = generateInternalId();
              const records: CompletedWaitpointRecord[] = [nativeId, legacyId].map((id) => ({
                id,
                friendlyId: `waitpoint_${id}`,
                type: "RUN",
                completedAt: new Date().toISOString(),
                output: { deriveFromRun: true },
                outputType: "text/plain",
                outputIsError: false,
                completedByTaskRunId: childId,
              }));
              await store.createExecutionSnapshot({
                id: generateInternalId(),
                run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
                snapshot: { executionStatus: "EXECUTING", description: "completed results" },
                previousSnapshotId: birthId,
                environmentId: env.id,
                environmentType: env.type,
                projectId: env.projectId,
                organizationId: env.organizationId,
                completedWaitpoints: [
                  { id: nativeId, index: 0 },
                  { id: legacyId, index: 1 },
                ],
                resolveCompletedWaitpointRecords: async () => records,
              });
              const result = await store.findLatestExecutionSnapshot(
                runId,
                undefined,
                env.id,
                env.organizationId
              );
              expect(result?.completedWaitpoints.map((w) => w.output)).toEqual(
                enabled === true
                  ? ["committed-output", "stale-output"]
                  : ["stale-output", "stale-output"]
              );
              expect(organizations).toEqual(enabled === undefined ? [] : [env.organizationId]);
            }
          },
          { isolationLevel: "RepeatableRead", timeout: 20_000 }
        );
      } finally {
        await snapshots.quit();
        await connection.close();
      }
    }
  );
});
