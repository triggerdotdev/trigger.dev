// The engine-boundary regression for a redis-primary resume.
//
// The boundary that matters is getLatestExecutionSnapshot, NOT the decorated store: the store hands
// back unenhanced read rows, and the runner-facing payload only exists after the engine's single
// enhancement step. The earlier tests stopped at decoratedStore.findLatestExecutionSnapshot, which is
// precisely why a redis-primary read that lost every RUN/BATCH completion association looked correct.
//
// RED on the pre-fix code: the store returned already-enhanced values cast to a Prisma relation
// payload, the engine enhanced them a second time reading Prisma columns that shape lacks, and
// completedByTaskRun / completedByBatch came back undefined. The runtime silently drops a RUN
// waitpoint with no completedByTaskRun and a BATCH waitpoint with no completedByBatch, so the wait
// never resolved and the parent hung in EXECUTING.
//
// Real Postgres + real Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import {
  PostgresRunStore,
  RoutingRunStore,
  markReadReplicaClient,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  type CreateRunInput,
} from "@internal/run-store";
import {
  BatchId,
  generateInternalId,
  generateWaitpointId,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import { PrismaClient, type Waitpoint } from "@trigger.dev/database";
import {
  enhanceExecutionSnapshotWithWaitpoints,
  getLatestExecutionSnapshot,
} from "./executionSnapshotSystem.js";
import {
  buildCompletedWaitpointRecords,
  createCompletedWaitpointResolver,
} from "./completedWaitpointResolver.js";

import { createWaitpointResultRunStore } from "./waitpointResultRunStore.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";

const ROUTE = "logical:1";

async function seedEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

type Env = Awaited<ReturnType<typeof seedEnv>>;

function createRunInput(runId: string, env: Env): CreateRunInput {
  return {
    data: {
      id: runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_${runId}`,
      runtimeEnvironmentId: env.environment.id,
      environmentType: "PRODUCTION",
      organizationId: env.organization.id,
      projectId: env.project.id,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${runId}`,
      spanId: `span_${runId}`,
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: env.environment.id,
      environmentType: "PRODUCTION",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
  };
}

// The redis-primary parent: born at the redis-only dial (no Postgres TRES row), then resumed with the
// completed-waitpoint cycle attached — the "Run was continued, whilst still executing." transition.
async function seedResumedRedisPrimaryRun(
  delegate: PostgresRunStore,
  store: RedisSnapshotStore,
  env: Env,
  args: {
    // Exactly what continueRunIfUnblocked passes: a plain triggerAndWait / batch waitpoint carries NO
    // index (so the cycle's order is empty while its distinct set is not), a batched child carries one.
    completedWaitpoints: { id: string; index?: number }[];
    records: ReturnType<typeof buildCompletedWaitpointRecords>;
    batchId?: string;
  }
) {
  const runId = generateInternalId();
  const birth = generateInternalId();
  const resumed = generateInternalId();

  const writer = new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "redis-only",
    logicalRunStoreRoute: ROUTE,
  });
  await writer.createRun({
    data: createRunInput(runId, env).data,
    snapshot: { ...createRunInput(runId, env).snapshot, id: birth },
  });
  await writer.createExecutionSnapshot({
    id: resumed,
    createdAt: new Date(),
    run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
    snapshot: {
      executionStatus: "EXECUTING",
      description: "Run was continued, whilst still executing.",
    },
    previousSnapshotId: birth,
    batchId: args.batchId,
    environmentId: env.environment.id,
    environmentType: env.environment.type,
    projectId: env.project.id,
    organizationId: env.organization.id,
    completedWaitpoints: args.completedWaitpoints,
    resolveCompletedWaitpointRecords: async () => args.records,
  });

  const reader = new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "redis-only",
    logicalRunStoreRoute: ROUTE,
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
  });
  return { runId, resumed, reader };
}

describe("redis-primary resume keeps its completion associations (engine boundary)", () => {
  containerTest(
    "disabled hydration preserves snapshot reads without interpreting storage metadata",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const waitpoints = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const env = await seedEnv(prisma, "disabled-hydration");
        const runId = generateInternalId();
        await delegate.createRun(createRunInput(runId, env));
        // The base Postgres reader carries metadata through unchanged. Hydration must not
        // introduce parsing errors for disabled orgs, including future metadata versions.
        await prisma.taskRunExecutionSnapshot.updateMany({
          where: { runId },
          data: { metadata: { snapshotStore: { version: 2, residency: "mirrored" } } },
        });
        const baseline = await delegate.findLatestExecutionSnapshot(runId);
        const checkedOrganizations: string[] = [];
        let enabledOrganization: string | undefined;
        const reader = createWaitpointResultRunStore(delegate, {
          store: waitpoints,
          isEnabled: (organizationId) => {
            checkedOrganizations.push(organizationId);
            return organizationId === enabledOrganization;
          },
        });
        expect(await reader.findLatestExecutionSnapshot(runId)).toEqual(baseline);
        const args = { where: { runId }, include: { completedWaitpoints: true } } as const;
        expect(await reader.findExecutionSnapshot(args)).toEqual(
          await delegate.findExecutionSnapshot(args)
        );
        expect(checkedOrganizations).toEqual([env.organization.id, env.organization.id]);
        enabledOrganization = env.organization.id;
        await expect(reader.findLatestExecutionSnapshot(runId)).rejects.toThrow(
          "Unsupported snapshot storage metadata"
        );
      } finally {
        await waitpoints.quit();
      }
    }
  );

  containerTest(
    "mirrored primary repair discovers shared MemoryDB completion links despite a frozen reader and empty order",
    async ({ prisma, redisOptions, postgresContainer }) => {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
      );
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const waitpoints = new WaitpointStoreCoordinator({ redisOptions });
      const readClient = new PrismaClient({
        datasources: { db: { url: postgresContainer.getConnectionUri() } },
      });
      try {
        const env = await seedEnv(prisma, "mirror-shared-repair");
        const parent = generateInternalId();
        const child = generateInternalId();
        const birth = generateInternalId();
        const resumed = generateInternalId();
        const sharedId = generateWaitpointId("RUN");
        await delegate.createRun(createRunInput(child, env));
        await prisma.taskRun.update({
          where: { id: child },
          data: { output: '{"child":"shared"}' },
        });
        await waitpoints.createIfAbsent({
          status: "PENDING",
          record: {
            id: sharedId,
            friendlyId: `waitpoint_${sharedId}`,
            type: "RUN",
            completedByTaskRunId: child,
            environmentId: env.environment.id,
            projectId: env.project.id,
            userProvidedIdempotencyKey: false,
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
        await waitpoints.complete({
          waitpointId: sharedId,
          completion: {
            completedAt: new Date().toISOString(),
            output: null,
            outputType: "application/json",
            outputIsError: false,
          },
        });
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store: snapshots,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: createRunInput(parent, env).data,
          snapshot: { ...createRunInput(parent, env).snapshot, id: birth },
        });
        await readClient.$transaction(
          async (frozenReader) => {
            expect(
              await frozenReader.taskRunExecutionSnapshot.findFirst({ where: { id: birth } })
            ).not.toBeNull();
            await writer.createExecutionSnapshot({
              id: resumed,
              createdAt: new Date(),
              run: { id: parent, status: "EXECUTING", attemptNumber: 1 },
              snapshot: { executionStatus: "EXECUTING", description: "Shared child completed" },
              previousSnapshotId: birth,
              environmentId: env.environment.id,
              environmentType: env.environment.type,
              projectId: env.project.id,
              organizationId: env.organization.id,
              completedWaitpoints: [{ id: sharedId }],
            });
            // This actual database reader has neither the repaired snapshot nor its completion links.
            expect(
              await frozenReader.taskRunExecutionSnapshot.findFirst({ where: { id: resumed } })
            ).toBeNull();
            const laggingLeaf = new PostgresRunStore({
              prisma,
              readOnlyPrisma: frozenReader as never,
            });
            const mirrorReader = new TaskRunExecutionSnapshotStore(laggingLeaf, {
              store: snapshots,
              mode: "redis-read",
              logicalRunStoreRoute: ROUTE,
              resolvePrimaryReadClient: () => prisma,
            });
            const routed = new RoutingRunStore({ new: delegate, legacy: mirrorReader });
            const reader = createWaitpointResultRunStore(routed, {
              store: waitpoints,
              isEnabled: () => true,
              primaryReadClient: prisma,
            });
            const snapshot = await getLatestExecutionSnapshot(
              markReadReplicaClient(frozenReader),
              parent,
              reader
            );
            expect(snapshot.id).toBe(resumed);
            expect(snapshot.completedWaitpointOrder).toEqual([]);
            expect(snapshot.completedWaitpoints).toMatchObject([
              { id: sharedId, output: '{"child":"shared"}', completedByTaskRun: { id: child } },
            ]);
            expect(
              await frozenReader.taskRunExecutionSnapshot.findFirst({ where: { id: resumed } })
            ).toBeNull();
            expect(await prisma.waitpoint.count({ where: { id: sharedId } })).toBe(0);
          },
          { isolationLevel: "RepeatableRead", timeout: 15_000 }
        );
      } finally {
        await readClient.$disconnect();
        await waitpoints.quit();
        await snapshots.quit();
      }
    }
  );

  containerTest(
    "a RUN waitpoint keeps completedByTaskRun id + friendlyId, with the child's output",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedEnv(prisma, "assoc-run");

        // A completed child run. Its RUN waitpoint carries deriveFromRun, so the resolver reads the
        // output back off TaskRun.output through its ONE batched findRunsByIds.
        const childId = generateInternalId();
        await delegate.createRun(createRunInput(childId, env));
        await prisma.taskRun.update({
          where: { id: childId },
          data: { status: "COMPLETED_SUCCESSFULLY", output: '{"child":"done"}' },
        });

        const waitpointId = generateInternalId();
        await prisma.waitpoint.create({
          data: {
            id: waitpointId,
            friendlyId: `waitpoint_${waitpointId}`,
            type: "RUN",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            output: '{"stale":"placeholder"}',
            outputType: "application/json",
            outputIsError: false,
            idempotencyKey: "idem_generated",
            userProvidedIdempotencyKey: false,
            completedByTaskRunId: childId,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });

        const rows = (await prisma.waitpoint.findMany({
          where: { id: waitpointId },
        })) as unknown as Waitpoint[];
        // A plain triggerAndWait carries no batch index, so the cycle's order is empty.
        const { runId, reader } = await seedResumedRedisPrimaryRun(delegate, store, env, {
          completedWaitpoints: [{ id: waitpointId }],
          records: buildCompletedWaitpointRecords(rows),
        });

        // The parent is redis-primary: Postgres holds NO snapshot row for it.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const enhanced = await getLatestExecutionSnapshot(prisma, runId, reader);
        expect(enhanced.executionStatus).toBe("EXECUTING");
        expect(enhanced.completedWaitpoints).toHaveLength(1);

        const wp = enhanced.completedWaitpoints[0]!;
        // RED before the fix: both of these were undefined, so the runtime dropped the waitpoint and
        // the parent's wait never resolved.
        expect(wp.completedByTaskRun?.id).toBe(childId);
        expect(wp.completedByTaskRun?.friendlyId).toBe(RunId.toFriendlyId(childId));
        expect(wp.type).toBe("RUN");
        expect(wp.index).toBeUndefined();
        // deriveFromRun re-read the CHILD's TaskRun.output through the resolver's one batched
        // findRunsByIds, rather than the stale copy on the waitpoint row. (Field-for-field parity with
        // the Postgres oracle is covered by completedWaitpointFreeze/-Cycle/-Resolver; asserting it
        // here too would require the two outputs to be equal, which defeats this check.)
        expect(wp.output).toBe('{"child":"done"}');
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a BATCH waitpoint keeps completedByBatch id + friendlyId",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedEnv(prisma, "assoc-batch");

        const batchId = generateInternalId();
        await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: BatchId.toFriendlyId(batchId),
            runtimeEnvironmentId: env.environment.id,
          },
        });

        const waitpointId = generateInternalId();
        await prisma.waitpoint.create({
          data: {
            id: waitpointId,
            friendlyId: `waitpoint_${waitpointId}`,
            type: "BATCH",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            output: '"Batch waitpoint completed"',
            outputType: "application/json",
            outputIsError: false,
            idempotencyKey: "idem_generated",
            userProvidedIdempotencyKey: false,
            completedByBatchId: batchId,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });

        const rows = (await prisma.waitpoint.findMany({
          where: { id: waitpointId },
        })) as unknown as Waitpoint[];
        const order: string[] = []; // the BATCH waitpoint itself never sits in the index order
        const { runId, reader } = await seedResumedRedisPrimaryRun(delegate, store, env, {
          completedWaitpoints: [{ id: waitpointId }],
          records: buildCompletedWaitpointRecords(rows),
          batchId,
        });

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const enhanced = await getLatestExecutionSnapshot(prisma, runId, reader);
        const wp = enhanced.completedWaitpoints[0]!;
        // RED before the fix: undefined, so batchTriggerAndWait never resolved either.
        expect(wp.completedByBatch?.id).toBe(batchId);
        expect(wp.completedByBatch?.friendlyId).toBe(BatchId.toFriendlyId(batchId));
        expect(wp.type).toBe("BATCH");
        expect(wp.output).toBe('"Batch waitpoint completed"');

        const oracle = enhanceExecutionSnapshotWithWaitpoints(
          { id: enhanced.id, runId, batchId, checkpoint: null } as never,
          rows,
          order
        );
        expect(enhanced.completedWaitpoints).toEqual(oracle.completedWaitpoints);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a repeated batched id is expanded at each position, and an active user key survives",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedEnv(prisma, "assoc-repeat");

        const batchId = generateInternalId();
        await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: BatchId.toFriendlyId(batchId),
            runtimeEnvironmentId: env.environment.id,
          },
        });

        // One child batched twice under a single idempotency key: ONE distinct record, TWO positions.
        const childId = generateInternalId();
        await delegate.createRun(createRunInput(childId, env));
        await prisma.taskRun.update({
          where: { id: childId },
          data: { status: "COMPLETED_SUCCESSFULLY", output: '{"twice":true}' },
        });

        const repeatedId = generateInternalId();
        await prisma.waitpoint.create({
          data: {
            id: repeatedId,
            friendlyId: `waitpoint_${repeatedId}`,
            type: "RUN",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            // Non-null so the record takes the deriveFromRun branch and the output is re-read off
            // TaskRun.output, exactly as a real RUN completion does.
            output: '{"stale":"placeholder"}',
            outputType: "application/json",
            outputIsError: false,
            idempotencyKey: "idem_user_visible",
            userProvidedIdempotencyKey: true,
            completedByTaskRunId: childId,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });

        // A second waitpoint whose user key was cleared: it must NOT surface a key.
        const clearedId = generateInternalId();
        await prisma.waitpoint.create({
          data: {
            id: clearedId,
            friendlyId: `waitpoint_${clearedId}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            output: '{"manual":true}',
            outputType: "application/json",
            outputIsError: false,
            idempotencyKey: "idem_regenerated",
            userProvidedIdempotencyKey: true,
            inactiveIdempotencyKey: "idem_was_cleared",
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });

        const order = [repeatedId, clearedId, repeatedId];
        const rows = (await prisma.waitpoint.findMany({
          where: { id: { in: [repeatedId, clearedId] } },
        })) as unknown as Waitpoint[];
        rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

        const records = buildCompletedWaitpointRecords(rows);
        // One record per DISTINCT id, even though one of them holds two positions.
        expect(records).toHaveLength(2);

        const { runId, reader } = await seedResumedRedisPrimaryRun(delegate, store, env, {
          completedWaitpoints: order.map((id, index) => ({ id, index })),
          records,
          batchId,
        });

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const enhanced = await getLatestExecutionSnapshot(prisma, runId, reader);
        // Three entries from two records: the repeated id expanded back to both its positions by the
        // enhancement step, which is the only place that expansion happens.
        expect(enhanced.completedWaitpoints).toHaveLength(3);
        expect(
          enhanced.completedWaitpoints.filter((w) => w.id === repeatedId).map((w) => w.index)
        ).toEqual([0, 2]);

        const repeated = enhanced.completedWaitpoints.filter((w) => w.id === repeatedId);
        for (const wp of repeated) {
          expect(wp.completedByTaskRun?.id).toBe(childId);
          expect(wp.completedByTaskRun?.batch?.id).toBe(batchId);
          expect(wp.output).toBe('{"twice":true}');
          expect(wp.idempotencyKey).toBe("idem_user_visible");
        }

        const cleared = enhanced.completedWaitpoints.find((w) => w.id === clearedId)!;
        expect(cleared.index).toBe(1);
        // A cleared user key must not surface, and the MANUAL row's own output is used as-is.
        expect(cleared.idempotencyKey).toBeUndefined();
        expect(cleared.output).toBe('{"manual":true}');
      } finally {
        await store.quit();
      }
    }
  );
});
