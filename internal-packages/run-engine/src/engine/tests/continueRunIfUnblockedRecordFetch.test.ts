// Query-count regression for the waitpoint-resume path. The full completed-waitpoint records only feed
// a redis-primary cycle; a postgres-resident (OFF / never-enrolled) resume throws them away, so it must
// do ZERO findManyWaitpoints. Real Postgres + Redis (no mocks): a recording RunStore counts the REAL
// findManyWaitpoints calls, and the redis-primary case drives the actual resolver thunk once.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import {
  DelegatingRunStore,
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  type CreateRunInput,
  type ReadClient,
} from "@internal/run-store";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, PrismaClient, Waitpoint } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import type { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  enhanceExecutionSnapshotWithWaitpoints,
  getLatestExecutionSnapshot,
} from "../systems/executionSnapshotSystem.js";
import {
  buildCompletedWaitpointRecords,
  createCompletedWaitpointResolver,
} from "../systems/completedWaitpointResolver.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";

// A real RunStore that only tallies findManyWaitpoints, delegating everything else untouched.
class FindManyWaitpointsRecorder extends DelegatingRunStore {
  public count = 0;
  findManyWaitpoints<T extends Prisma.WaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindManyArgs>,
    client?: ReadClient,
    runId?: string
  ): Promise<Prisma.WaitpointGetPayload<T>[]> {
    this.count++;
    return super.findManyWaitpoints(args, client, runId);
  }
}

describe("continueRunIfUnblocked completed-waitpoint record fetch", () => {
  containerTest(
    "OFF / postgres-resident resume does ZERO findManyWaitpoints and still resumes",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const recorder = new FindManyWaitpointsRecorder(
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma })
      );

      const engine = new RunEngine({
        prisma,
        store: recorder,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_off1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-off-1",
            spanId: "s-off-1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_off",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        const waitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.waitpoint.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
        });
        expect(
          (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus
        ).toBe("EXECUTING_WITH_WAITPOINTS");

        let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
        engine.eventBus.on("workerNotification", (result) => {
          event = result;
        });

        // Count ONLY the resume window: reset, complete (enqueues continueRunIfUnblocked), then read the
        // tally the instant the resume settles — before any inspection read hydrates waitpoints.
        recorder.count = 0;
        await engine.completeWaitpoint({ id: waitpoint.waitpoint.id, output: undefined });
        await setTimeout(500);
        const resumeFetchCount = recorder.count;

        assertNonNullable(event);
        expect((event as EventBusEventArgs<"workerNotification">[0]).run.id).toBe(run.id);

        // The fix: the postgres resume never fetches the records it would only throw away.
        expect(resumeFetchCount).toBe(0);

        // And the run resumed exactly as before: back to EXECUTING with the waitpoint cleared.
        const resumed = await engine.getRunExecutionData({ runId: run.id });
        expect(resumed?.snapshot.executionStatus).toBe("EXECUTING");
        expect(resumed?.completedWaitpoints.map((w) => w.id)).toEqual([waitpoint.waitpoint.id]);
        expect(
          await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } })
        ).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "redis-primary resume fetches records once and reproduces inline/error/deriveFromRun",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const recorder = new FindManyWaitpointsRecorder(delegate);
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedEnv(prisma, "redisprimary");
        const batchId = "batch_redisprimary";

        // A completing run whose TaskRun.output the deriveFromRun record re-reads (never a copy).
        const completingRunId = generateInternalId();
        await delegate.createRun(createRunInput(completingRunId, env));
        await prisma.taskRun.update({
          where: { id: completingRunId },
          data: { output: '{"value":42}', outputType: "application/json" },
        });

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
        const oracleRows = (await prisma.waitpoint.findMany({
          where: { id: { in: order } },
        })) as unknown as Waitpoint[];
        oracleRows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        const oracle = enhanceExecutionSnapshotWithWaitpoints(
          { id: "snap_oracle", runId: "reader", batchId, checkpoint: null } as never,
          oracleRows,
          order
        );

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

        // The resolver thunk mirrors WaitpointSystem#buildCompletedWaitpointRecords: it fetches the full
        // rows via findManyWaitpoints, then builds the records. The store must invoke it exactly once,
        // only for this redis-primary cycle.
        let thunkCalls = 0;
        await writer.createExecutionSnapshot({
          id: waitpointSnap,
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Run was continued" },
          previousSnapshotId: birth,
          batchId,
          environmentId: env.environment.id,
          environmentType: env.environment.type,
          projectId: env.project.id,
          organizationId: env.organization.id,
          completedWaitpoints: order.map((id, index) => ({ id, index })),
          resolveCompletedWaitpointRecords: async () => {
            thunkCalls++;
            const rows = await recorder.findManyWaitpoints(
              { where: { id: { in: order } } },
              prisma,
              runId
            );
            rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            return buildCompletedWaitpointRecords(rows as unknown as Waitpoint[]);
          },
        });

        expect(thunkCalls).toBe(1);
        expect(recorder.count).toBe(1);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
        });
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
});

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
