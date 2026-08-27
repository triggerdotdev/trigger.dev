// The whole loss-and-recovery cycle against a real Postgres and a real Redis: an injected fault
// models the process dying between the two writes, and the repair is then asked to close the gap it
// left. Only the append script can prove the two guards the repair leans on, so the sibling
// container-free suite covers the decisions and this one covers the guards.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { entryFromCreateRun } from "./snapshotEntry.js";
import { InjectedSnapshotFault } from "./snapshotFaultInjection.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

function harness(
  prisma: never,
  redisOptions: never,
  opts?: { faults?: ConstructorParameters<typeof TaskRunExecutionSnapshotStore>[1]["faults"] }
) {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const repairs: { runId: string; snapshotId: string; executionStatus: string }[] = [];

  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    {
      store: redis,
      mode: "redis-read",
      readPercent: 100,
      ...(opts?.faults && { faults: opts.faults }),
      onAppendFailure: async (args) => {
        repairs.push(args);
      },
    }
  );

  return { decorated, redis, repairs };
}

async function seedBirth(
  decorated: TaskRunExecutionSnapshotStore,
  redis: RedisSnapshotStore,
  runId: string,
  env: SnapshotFixtureEnv
): Promise<void> {
  const snapshot = {
    id: generateInternalId(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };

  await redis.append({
    entry: entryFromCreateRun({ id: snapshot.id, runId, createdAt: new Date() }, snapshot),
    kind: "birth",
    isTerminal: false,
  });

  await decorated.createRun({ data: buildCreateRunData(runId, env), snapshot });
}

function executingSnapshot(runId: string, env: SnapshotFixtureEnv, previousSnapshotId?: string) {
  return {
    id: generateInternalId(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "Run is executing" },
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
    ...(previousSnapshotId && { previousSnapshotId }),
  };
}

describe("snapshot repair end to end", () => {
  containerTest(
    "re-appends an EXECUTING snapshot whose append the process died before making",
    async ({ prisma, redisOptions }) => {
      let dropNext = true;
      const { decorated, redis, repairs } = harness(prisma as never, redisOptions as never, {
        faults: (boundary) => {
          if (boundary === "afterPgBeforeRedis" && dropNext) {
            dropNext = false;
            throw new InjectedSnapshotFault(boundary);
          }
        },
      });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);

        const created = await decorated.createExecutionSnapshot(executingSnapshot(runId, env));

        expect(repairs).toEqual([{ runId, snapshotId: created.id, executionStatus: "EXECUTING" }]);
        expect(await redis.getById(runId, created.id)).toBeNull();

        await expect(decorated.repairRedisHead(runId, created.id)).resolves.toBe("reappended");

        const read = await redis.getLatest(runId);
        expect(read!.id).toBe(created.id);
        expect(read!.entry["executionStatus"]).toBe("EXECUTING");
        expect(read!.entry["createdAt"]).toBe(created.createdAt.toISOString());
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "is safe to run twice: the second attempt adds no second entry",
    async ({ prisma, redisOptions }) => {
      let dropNext = true;
      const { decorated, redis } = harness(prisma as never, redisOptions as never, {
        faults: (boundary) => {
          if (boundary === "afterPgBeforeRedis" && dropNext) {
            dropNext = false;
            throw new InjectedSnapshotFault(boundary);
          }
        },
      });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);

        const created = await decorated.createExecutionSnapshot(executingSnapshot(runId, env));

        await expect(decorated.repairRedisHead(runId, created.id)).resolves.toBe("reappended");
        const first = await redis.getLatest(runId);

        await expect(decorated.repairRedisHead(runId, created.id)).resolves.toBe("alreadyCurrent");
        const second = await redis.getLatest(runId);

        expect(second!.seq).toBe(first!.seq);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "does not resurrect a run that was never resident in Redis",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = harness(prisma as never, redisOptions as never);

      try {
        // Born through the UNDECORATED store, so Postgres holds a head and Redis holds no keyspace.
        // This is every pre-cutover run.
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const plain = new PostgresRunStore({
          prisma,
          readOnlyPrisma: prisma,
        }) as unknown as RunStore;

        await plain.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: generateInternalId(),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "Run was created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        const head = await plain.findLatestExecutionSnapshot(runId);

        await expect(decorated.repairRedisHead(runId, head!.id)).resolves.toBe("notResident");
        expect(await redis.getLatest(runId)).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "heals the head after the run has transitioned past the lost snapshot",
    async ({ prisma, redisOptions }) => {
      let dropping = true;
      const { decorated, redis } = harness(prisma as never, redisOptions as never, {
        faults: (boundary) => {
          if (boundary === "afterPgBeforeRedis" && dropping) {
            throw new InjectedSnapshotFault(boundary);
          }
        },
      });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);

        const lost = await decorated.createExecutionSnapshot(executingSnapshot(runId, env));
        const later = await decorated.createExecutionSnapshot(
          executingSnapshot(runId, env, lost.id)
        );
        dropping = false;

        await expect(decorated.repairRedisHead(runId, lost.id)).resolves.toBe("reappended");

        const read = await redis.getLatest(runId);
        expect(read!.id).toBe(later.id);
      } finally {
        await redis.quit();
      }
    }
  );
});
