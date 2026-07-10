// RED→GREEN: the dedicated-schema relation hydrators (`batchHydrateJoinRelation` /
// `batchHydrateEdgeTarget`) fetch the target row's FULL columns (no `select`) and only strip fields
// in JS afterwards via `applyProjection`. At prod scale (a 6.68B-row `TaskRun`) that over-fetches
// every wide TOASTed column (`payload`/`output`/`context`) even when the caller only asked for
// `friendlyId`. The RESULT is identical with/without the fix (`applyProjection` trims either way),
// so this asserts the QUERY SHAPE Prisma actually receives, via a `$extends` query hook on a REAL
// `heteroRunOpsPostgresTest.prisma17` client — the DB still runs the query, this only observes it.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateRunInput } from "./types.js";

function seedEnvironmentDedicated(suffix: string) {
  return {
    organization: { id: `org_${suffix}` },
    project: { id: `proj_${suffix}` },
    environment: { id: `env_${suffix}` },
  };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      traceContext: { trace: "ctx" },
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

function makeStore(prisma: RunOpsPrismaClient) {
  return new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant: "dedicated",
  });
}

// Wraps `taskRun.findMany` with a REAL Prisma Client Extension query hook: every call's `args` is
// captured, then delegated unchanged to `query(args)` so the DB still executes it. This is
// observation, not a mock — the extension can't fabricate a result, only see what's sent.
function withCapturedTaskRunFindManyArgs(real: RunOpsPrismaClient) {
  const capturedArgs: Record<string, unknown>[] = [];
  const extended = (real as unknown as { $extends: (config: unknown) => unknown }).$extends({
    query: {
      taskRun: {
        findMany({
          args,
          query,
        }: {
          args: Record<string, unknown>;
          query: (args: unknown) => Promise<unknown>;
        }) {
          capturedArgs.push(args);
          return query(args);
        },
      },
    },
  });
  return { client: extended as RunOpsPrismaClient, capturedArgs };
}

describe("PostgresRunStore dedicated relation hydrators — target findMany select pushdown", () => {
  heteroRunOpsPostgresTest(
    "hydrateConnectedRuns narrows the target taskRun.findMany to the caller's select instead of fetching the full row",
    async ({ prisma17 }) => {
      const seedStore = makeStore(prisma17);
      const env = seedEnvironmentDedicated("select_pushdown");

      const runId = "run_select_pushdown";
      const waitpointId = "wp_select_pushdown";

      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: `${waitpointId}_friendly`,
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      await seedStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `${runId}_friendly`,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      // Seeds BOTH the TaskRunWaitpoint edge and the WaitpointRunConnection join row that
      // `connectedRuns` reads from.
      await seedStore.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: env.project.id,
      });

      const { client: capturingClient, capturedArgs } = withCapturedTaskRunFindManyArgs(prisma17);
      const readStore = makeStore(capturingClient);

      const waitpoint = (await readStore.findWaitpoint({
        where: { id: waitpointId },
        include: { connectedRuns: { select: { friendlyId: true } } },
      })) as { connectedRuns: { friendlyId: string }[] } | null;

      expect(capturedArgs).toHaveLength(1);
      const targetArgs = capturedArgs[0] as { where: unknown; select?: Record<string, unknown> };

      // THE FIX: the target `findMany` carries a `select` narrowed to the caller's projection (plus
      // the `id` the hydrator keys off), never a bare where-only (= full row) query.
      expect(targetArgs.select).toBeDefined();
      expect(targetArgs.select).toMatchObject({ friendlyId: true, id: true });
      expect(targetArgs.select?.payload).toBeUndefined();
      expect(targetArgs.select?.output).toBeUndefined();
      expect(targetArgs.select?.context).toBeUndefined();

      // `applyProjection` still trims correctly: exactly `{ friendlyId }`, no `id` leak, no wide
      // columns — proving the pushdown didn't change the caller-visible result.
      expect(waitpoint?.connectedRuns).toHaveLength(1);
      expect(waitpoint?.connectedRuns[0]).toEqual({ friendlyId: `${runId}_friendly` });
    }
  );

  heteroRunOpsPostgresTest(
    "hydrateEdgeTaskRun (batchHydrateEdgeTarget) narrows the target taskRun.findMany to the caller's select instead of fetching the full row",
    async ({ prisma17 }) => {
      const seedStore = makeStore(prisma17);
      const env = seedEnvironmentDedicated("edge_pushdown");

      const runId = "run_edge_pushdown";
      const waitpointId = "wp_edge_pushdown";

      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: `${waitpointId}_friendly`,
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      await seedStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `${runId}_friendly`,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      await seedStore.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: env.project.id,
      });

      const { client: capturingClient, capturedArgs } = withCapturedTaskRunFindManyArgs(prisma17);
      const readStore = makeStore(capturingClient);

      // TaskRunWaitpoint's `taskRun` relation is the dedicated `hydrateEdgeTaskRun` ->
      // `batchHydrateEdgeTarget` path (the scalar-FK-on-the-parent variant).
      const edges = (await readStore.findManyTaskRunWaitpoints({
        where: { waitpointId },
        select: { taskRun: { select: { friendlyId: true } } },
      })) as { taskRun: { friendlyId: string } | null }[];

      expect(capturedArgs).toHaveLength(1);
      const targetArgs = capturedArgs[0] as { where: unknown; select?: Record<string, unknown> };

      expect(targetArgs.select).toBeDefined();
      expect(targetArgs.select).toMatchObject({ friendlyId: true, id: true });
      expect(targetArgs.select?.payload).toBeUndefined();
      expect(targetArgs.select?.output).toBeUndefined();
      expect(targetArgs.select?.context).toBeUndefined();

      expect(edges).toHaveLength(1);
      expect(edges[0].taskRun).toEqual({ friendlyId: `${runId}_friendly` });
    }
  );
});
