// The record set's journey from a caller's input to the wait cycle's key.
//
// The raw store already pins that a records array round-trips through the cycle hash. What is
// untested without this file is the decorator leg: that `completedWaitpointRecords` on a
// snapshot input reaches `cycle.records`, that a mint carries it, and that a copy-forward and
// a legacy-only wait carry none — which is what keeps a Postgres-resident resume unchanged.
import { createRedisClient } from "@internal/redis";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, type CompletedWaitpointRecord } from "./redisSnapshotStore.js";
import { entryFromCreateRun } from "./snapshotEntry.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  seedSnapshotWaitpoints,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";
import type { RunStore } from "./types.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

function build(prisma: never, redisOptions: never) {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    {
      store: redis,
      mode: "redis-read",
      readPercent: 100,
      metrics: {
        recordWrite: () => {},
        recordAppendFailed: () => {},
        recordRead: () => {},
      },
    }
  );
  return { decorated, redis };
}

async function seedRun(
  decorated: TaskRunExecutionSnapshotStore,
  redis: RedisSnapshotStore,
  env: SnapshotFixtureEnv
): Promise<string> {
  const runId = generateInternalId();
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
  return runId;
}

function resumeInput(
  runId: string,
  env: SnapshotFixtureEnv,
  completedWaitpoints: { id: string; index?: number }[],
  completedWaitpointRecords?: CompletedWaitpointRecord[]
) {
  return {
    id: generateInternalId(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "Run resumed" },
    completedWaitpoints,
    ...(completedWaitpointRecords && { completedWaitpointRecords }),
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

function record(id: string, overrides: Partial<CompletedWaitpointRecord> = {}) {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL" as const,
    completedAt: "2026-08-25T00:00:00.000Z",
    outputType: "application/json",
    outputIsError: false,
    output: { inline: '{"ok":true}' },
    ...overrides,
  } satisfies CompletedWaitpointRecord;
}

async function readRecords(
  probe: ReturnType<typeof createRedisClient>,
  runId: string
): Promise<CompletedWaitpointRecord[] | undefined> {
  const [cycleKey] = await probe.keys(`snap:{${runId}}:wp:*`);
  if (!cycleKey) return undefined;
  const raw = await probe.hget(cycleKey, "records");
  return raw ? (JSON.parse(raw) as CompletedWaitpointRecord[]) : undefined;
}

describe("the completed-waitpoint record set", () => {
  containerTest(
    "a mint writes the records the caller supplied",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);

        await decorated.createExecutionSnapshot(
          resumeInput(
            runId,
            env,
            [
              { id: wpA!, index: 0 },
              { id: wpB!, index: 1 },
            ],
            [record(wpA!), record(wpB!)]
          )
        );

        const records = await readRecords(probe, runId);

        expect(records).toHaveLength(2);
        expect(records?.map((r) => r.id).sort()).toEqual([wpA, wpB].sort());
        expect(records?.[0]?.output).toEqual({ inline: '{"ok":true}' });
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  // The inertness guarantee. A wait with no store-resident half supplies no records, and the
  // cycle key must then hold none — a Postgres-resident resume is unchanged.
  containerTest("a mint with no records supplied writes none", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    const probe = createRedisClient(redisOptions, { onError: () => {} });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, redis, env);
      const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

      await decorated.createExecutionSnapshot(resumeInput(runId, env, [{ id: wpA!, index: 0 }]));

      expect(await readRecords(probe, runId)).toBeUndefined();
    } finally {
      await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
    }
  });

  // One record set per wait cycle, not one per entry in the resume chain. That is the write
  // amplification the pointer model exists to remove.
  containerTest("a copy-forward writes no second record set", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    const probe = createRedisClient(redisOptions, { onError: () => {} });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, redis, env);
      const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

      const waitpoints = [{ id: wpA!, index: 0 }];
      await decorated.createExecutionSnapshot(resumeInput(runId, env, waitpoints, [record(wpA!)]));
      await decorated.createExecutionSnapshot(resumeInput(runId, env, waitpoints, [record(wpA!)]));

      const cycleKeys = await probe.keys(`snap:{${runId}}:wp:*`);

      expect(cycleKeys).toHaveLength(1);
      expect(await readRecords(probe, runId)).toHaveLength(1);
    } finally {
      await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
    }
  });

  containerTest(
    "a record set survives beside a repeat-preserving order",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

        const created = await decorated.createExecutionSnapshot(
          resumeInput(
            runId,
            env,
            [
              { id: wpA!, index: 0 },
              { id: wpA!, index: 1 },
            ],
            [record(wpA!)]
          )
        );

        const ids = await redis.getSnapshotWaitpointIds(runId, created.id);

        // One record, two positions. The record set carries membership, the order carries
        // multiplicity.
        expect(await readRecords(probe, runId)).toHaveLength(1);
        expect(ids.order).toEqual([wpA, wpA]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
});
