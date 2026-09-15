// End-to-end proof that the write-side record builder + read-side resolver are wired through the
// snapshot store. Against REAL Postgres + REAL Redis (testcontainers, no mocks), it proves three things:
// (1) a redis-primary transition's snapshot + waitpoint records + ordering + cycle publish ATOMICALLY —
// a crash before finalize leaves NOTHING visible; (2) a redis-primary read reproduces the mirrored
// run's Postgres-join answer EXACTLY (inline, error, and deriveFromRun outputs); (3) a forward-carry
// transition (dequeue/checkpoint re-propagating a prior cycle, refs but NO records) does not crash and
// carries the same completed-waitpoint set forward.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  type CreateRunInput,
} from "@internal/run-store";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import {
  enhanceExecutionSnapshotWithWaitpoints,
  getLatestExecutionSnapshot,
} from "./executionSnapshotSystem.js";
import {
  buildCompletedWaitpointRecords,
  createCompletedWaitpointResolver,
} from "./completedWaitpointResolver.js";

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

function transitionInput(
  runId: string,
  env: Env,
  args: {
    id: string;
    previousSnapshotId: string;
    completedWaitpoints?: { id: string; index?: number }[];
    completedWaitpointRecords?: ReturnType<typeof buildCompletedWaitpointRecords>;
    batchId?: string;
    description?: string;
  }
) {
  return {
    id: args.id,
    createdAt: new Date(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: {
      executionStatus: "EXECUTING" as const,
      description: args.description ?? "Run was continued",
    },
    previousSnapshotId: args.previousSnapshotId,
    environmentId: env.environment.id,
    environmentType: env.environment.type,
    projectId: env.project.id,
    organizationId: env.organization.id,
    batchId: args.batchId,
    completedWaitpoints: args.completedWaitpoints,
    resolveCompletedWaitpointRecords: args.completedWaitpointRecords
      ? async () => args.completedWaitpointRecords!
      : undefined,
  };
}

describe("completed-waitpoint cycle wiring (redis-primary)", () => {
  containerTest(
    "a fresh completion publishes snapshot + records + order + cycle atomically",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedEnv(prisma, "atomic");
        const waitpointId = generateInternalId();

        const records = buildCompletedWaitpointRecords([
          {
            id: waitpointId,
            friendlyId: "waitpoint_ok",
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            output: '{"value":42}',
            outputType: "application/json",
            outputIsError: false,
            idempotencyKey: "idem_ok",
            userProvidedIdempotencyKey: false,
            inactiveIdempotencyKey: null,
            completedByTaskRunId: null,
            completedByBatchId: null,
            completedAfter: null,
          } as Waitpoint,
        ]);
        const completedWaitpoints = [{ id: waitpointId, index: 0 }];

        // CRASH path: a run whose waitpoint transition throws before finalize must leave NOTHING —
        // the head stays at EXECUTING and the cycle is never published.
        const crashRunId = generateInternalId();
        const crashBirth = generateInternalId();
        const crashExecuting = generateInternalId();
        const crashWaitpoint = generateInternalId();
        const clean = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await clean.createRun({
          data: createRunInput(crashRunId, env).data,
          snapshot: { ...createRunInput(crashRunId, env).snapshot, id: crashBirth },
        });
        await clean.createExecutionSnapshot(
          transitionInput(crashRunId, env, {
            id: crashExecuting,
            previousSnapshotId: crashBirth,
            description: "Run started",
          })
        );
        const crashing = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          hooks: {
            beforeFinalize: () => {
              throw new Error("__hold__");
            },
          },
        });
        await expect(
          crashing.createExecutionSnapshot(
            transitionInput(crashRunId, env, {
              id: crashWaitpoint,
              previousSnapshotId: crashExecuting,
              completedWaitpoints,
              completedWaitpointRecords: records,
            })
          )
        ).rejects.toThrow(/__hold__/);

        // The head never advanced to the waitpoint transition, and its cycle is invisible.
        expect((await store.getLatest(crashRunId))?.id).toBe(crashExecuting);
        const crashCw = await store.getSnapshotCompletedWaitpoints(crashRunId, crashWaitpoint);
        expect(crashCw.present && crashCw.records.length > 0).toBe(false);

        // CLEAN path: the same transition, finalized, publishes the head, its order/records, and the
        // cycle together — a read reproduces them all.
        const runId = generateInternalId();
        const birth = generateInternalId();
        const executing = generateInternalId();
        const waitpointSnap = generateInternalId();
        await clean.createRun({
          data: createRunInput(runId, env).data,
          snapshot: { ...createRunInput(runId, env).snapshot, id: birth },
        });
        await clean.createExecutionSnapshot(
          transitionInput(runId, env, {
            id: executing,
            previousSnapshotId: birth,
            description: "Run started",
          })
        );
        await clean.createExecutionSnapshot(
          transitionInput(runId, env, {
            id: waitpointSnap,
            previousSnapshotId: executing,
            completedWaitpoints,
            completedWaitpointRecords: records,
          })
        );

        expect((await store.getLatest(runId))?.id).toBe(waitpointSnap);
        const cw = await store.getSnapshotCompletedWaitpoints(runId, waitpointSnap);
        expect(cw.present).toBe(true);
        expect(cw.order).toEqual([waitpointId]);
        expect(cw.records.map((r) => r.id)).toEqual([waitpointId]);

        // Postgres holds NO snapshot rows: the reproduction is entirely from the published cycle.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
        });
        const enhanced = await getLatestExecutionSnapshot(prisma, runId, reader);
        expect(enhanced.id).toBe(waitpointSnap);
        expect(enhanced.completedWaitpointOrder).toEqual([waitpointId]);
        const resolved = enhanced.completedWaitpoints;
        expect(resolved).toHaveLength(1);
        expect(resolved[0]!.id).toBe(waitpointId);
        expect(resolved[0]!.output).toBe('{"value":42}');
        expect(resolved[0]!.index).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a redis-primary read reproduces the mirrored Postgres-join answer exactly",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedEnv(prisma, "oracle");
        const batchId = "batch_oracle";

        // A completing run whose TaskRun.output the deriveFromRun record re-reads (never a copy).
        const completingRunId = generateInternalId();
        await delegate.createRun(createRunInput(completingRunId, env));
        await prisma.taskRun.update({
          where: { id: completingRunId },
          data: { output: '{"value":42}', outputType: "application/json" },
        });

        // Real waitpoint rows: an inline MANUAL, an error MANUAL, and a deriveFromRun RUN (its output
        // equals the completing run's TaskRun.output, as a real RUN success does).
        const inlineId = generateInternalId();
        const errorId = generateInternalId();
        const runWpId = generateInternalId();
        await prisma.waitpoint.create({
          data: {
            id: inlineId,
            friendlyId: "waitpoint_inline",
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            output: '{"inline":true}',
            outputType: "application/json",
            idempotencyKey: "idem_inline",
            userProvidedIdempotencyKey: true,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });
        await prisma.waitpoint.create({
          data: {
            id: errorId,
            friendlyId: "waitpoint_error",
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            output: '{"type":"STRING_ERROR"}',
            outputType: "application/json",
            outputIsError: true,
            idempotencyKey: "idem_error",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });
        await prisma.waitpoint.create({
          data: {
            id: runWpId,
            friendlyId: "waitpoint_run",
            type: "RUN",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            completedByTaskRunId: completingRunId,
            output: '{"value":42}',
            outputType: "application/json",
            idempotencyKey: "idem_run",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });

        const order = [inlineId, errorId, runWpId];
        const rows = (await prisma.waitpoint.findMany({
          where: { id: { in: order } },
        })) as unknown as Waitpoint[];
        // Iterate rows in the SAME order the oracle and the record builder both do, so the two
        // reproduced arrays line up position-for-position.
        rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

        const oracle = enhanceExecutionSnapshotWithWaitpoints(
          { id: "snap_oracle", runId: "reader", batchId, checkpoint: null } as never,
          rows,
          order
        );

        // The redis-primary run carrying the SAME waitpoints + records.
        const runId = generateInternalId();
        const birth = generateInternalId();
        const waitpointSnap = generateInternalId();
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: createRunInput(runId, env).data,
          snapshot: { ...createRunInput(runId, env).snapshot, id: birth },
        });
        await writer.createExecutionSnapshot(
          transitionInput(runId, env, {
            id: waitpointSnap,
            previousSnapshotId: birth,
            batchId,
            completedWaitpoints: order.map((id, index) => ({ id, index })),
            completedWaitpointRecords: buildCompletedWaitpointRecords(rows),
          })
        );

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
        });
        // Read through getLatestExecutionSnapshot, NOT the store directly: the store hands back
        // unenhanced rows, and the engine's enhancement step is where a redis-primary read used to
        // lose every RUN/BATCH completion association. Stopping at the store hid exactly that.
        const enhanced = await getLatestExecutionSnapshot(prisma, runId, reader);
        const resolved = enhanced.completedWaitpoints;

        expect(resolved).toEqual(oracle.completedWaitpoints);
        expect(resolved.map((r) => r.output)).toEqual([
          '{"inline":true}',
          '{"type":"STRING_ERROR"}',
          '{"value":42}',
        ]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a forward-carry transition does not crash and carries the prior cycle forward",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedEnv(prisma, "carry");
        const waitpointId = generateInternalId();
        const records = buildCompletedWaitpointRecords([
          {
            id: waitpointId,
            friendlyId: "waitpoint_carry",
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
            output: '{"carried":true}',
            outputType: "application/json",
            outputIsError: false,
            idempotencyKey: "idem_carry",
            userProvidedIdempotencyKey: false,
            inactiveIdempotencyKey: null,
            completedByTaskRunId: null,
            completedByBatchId: null,
            completedAfter: null,
          } as Waitpoint,
        ]);
        const refs = [{ id: waitpointId, index: 0 }];

        const runId = generateInternalId();
        const birth = generateInternalId();
        const fresh = generateInternalId();
        const carried = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: createRunInput(runId, env).data,
          snapshot: { ...createRunInput(runId, env).snapshot, id: birth },
        });
        // Fresh completion: records born here, a new cycle minted.
        await writer.createExecutionSnapshot(
          transitionInput(runId, env, {
            id: fresh,
            previousSnapshotId: birth,
            completedWaitpoints: refs,
            completedWaitpointRecords: records,
          })
        );
        // Forward-carry: the SAME refs but NO records (as dequeue/checkpoint re-propagate a prior
        // snapshot's completed waitpoints). This must NOT throw — it carries the prior cycle forward.
        await writer.createExecutionSnapshot(
          transitionInput(runId, env, {
            id: carried,
            previousSnapshotId: fresh,
            completedWaitpoints: refs,
            description: "Run carried forward after checkpoint",
          })
        );

        expect((await store.getLatest(runId))?.id).toBe(carried);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
        });
        const enhanced = await getLatestExecutionSnapshot(prisma, runId, reader);
        expect(enhanced.id).toBe(carried);
        // The carried head reproduces the SAME completed-waitpoint set as the fresh cycle.
        expect(enhanced.completedWaitpointOrder).toEqual([waitpointId]);
        const resolved = enhanced.completedWaitpoints;
        expect(resolved.map((r) => r.id)).toEqual([waitpointId]);
        expect(resolved[0]!.output).toBe('{"carried":true}');
      } finally {
        await store.quit();
      }
    }
  );
});
