// RED→GREEN: the dedicated-schema relation hydrators (`hydrateBlockingTaskRuns` /
// `#hydrateDedicatedRelations`) resolve a relation PER PARENT ROW, so for N parents each requesting
// the same relation, the store issues N round trips (a `findFirst`/`findMany` per row) instead of one
// grouped query for the whole batch. `heteroRunOpsPostgresTest.prisma17` is a REAL RunOpsPrismaClient
// over the dedicated subset schema. The counting proxy wraps its `taskRun` delegate to tally
// `findFirst`/`findMany` calls while delegating every call to the real client — the DB still runs the
// query; this is instrumentation, not a mock.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateRunInput } from "./types.js";

type CallCounts = { findMany: number; findFirst: number };

// Wraps the named delegates on a REAL client to tally `findMany`/`findFirst` calls PER delegate,
// delegating every call unchanged to the real client (the DB still runs the query).
function countingClient(
  real: RunOpsPrismaClient,
  delegateNames: string[]
): { client: RunOpsPrismaClient; counts: Record<string, CallCounts>; queryRaw: { count: number } } {
  const counts: Record<string, CallCounts> = {};
  for (const name of delegateNames) {
    counts[name] = { findMany: 0, findFirst: 0 };
  }
  const queryRaw = { count: 0 };
  const wrapped = new Map(
    delegateNames.map((name) => [
      name,
      new Proxy((real as any)[name], {
        get(target, prop) {
          if (prop === "findMany" || prop === "findFirst") {
            counts[name][prop as "findMany" | "findFirst"]++;
          }
          return (target as any)[prop];
        },
      }),
    ])
  );
  const client = new Proxy(real, {
    get(target, prop) {
      if (typeof prop === "string" && wrapped.has(prop)) {
        return wrapped.get(prop);
      }
      // Tally the grouped raw query the bounded connectedRuns hydrator issues, delegating unchanged.
      if (prop === "$queryRaw") {
        return (...args: unknown[]) => {
          queryRaw.count++;
          return (target as any).$queryRaw(...args);
        };
      }
      return (target as any)[prop];
    },
  }) as RunOpsPrismaClient;
  return { client, counts, queryRaw };
}

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

describe("PostgresRunStore dedicated relation hydrators — grouped batch reads", () => {
  heteroRunOpsPostgresTest(
    "hydrateBlockingTaskRuns resolves N edges' `taskRun` with ONE grouped findMany, not N findFirst",
    async ({ prisma17 }) => {
      const seedStore = makeStore(prisma17);
      const env = seedEnvironmentDedicated("hbt");
      const waitpointId = "wp_hbt_shared";
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_hbt_friendly",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      const runIds = ["run_hbt_1", "run_hbt_2", "run_hbt_3"];
      for (const runId of runIds) {
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
      }

      const counting = countingClient(prisma17, ["taskRun"]);
      const readStore = makeStore(counting.client);

      const waitpoint = (await readStore.findWaitpoint({
        where: { id: waitpointId },
        include: {
          blockingTaskRuns: { select: { taskRun: { select: { id: true, friendlyId: true } } } },
        },
      })) as { blockingTaskRuns: { taskRun: { id: string; friendlyId: string } | null }[] } | null;

      const blocking = waitpoint?.blockingTaskRuns ?? [];
      expect(blocking).toHaveLength(3);
      expect(blocking.map((b) => b.taskRun?.id).sort()).toEqual([...runIds].sort());

      // GROUPED: one findMany for the WHOLE batch, never one findFirst per edge.
      expect(counting.counts.taskRun.findMany).toBe(1);
      expect(counting.counts.taskRun.findFirst).toBe(0);
    }
  );

  heteroRunOpsPostgresTest(
    "findManyWaitpoints hydrates N parents' `connectedRuns` with ONE grouped join query + ONE grouped target query",
    async ({ prisma17 }) => {
      const seedStore = makeStore(prisma17);
      const env = seedEnvironmentDedicated("cr");

      const waitpointIds = ["wp_cr_1", "wp_cr_2", "wp_cr_3"];
      const runIds = ["run_cr_1", "run_cr_2", "run_cr_3"];
      for (const [i, waitpointId] of waitpointIds.entries()) {
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
            runId: runIds[i],
            friendlyId: `${runIds[i]}_friendly`,
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );
        // One connection per waitpoint, to its own distinct run.
        await seedStore.blockRunWithWaitpointEdges({
          runId: runIds[i],
          waitpointIds: [waitpointId],
          projectId: env.project.id,
        });
      }

      const counting = countingClient(prisma17, ["waitpointRunConnection", "taskRun"]);
      const readStore = makeStore(counting.client);

      const rows = (await readStore.findManyWaitpoints({
        where: { id: { in: waitpointIds } },
        include: { connectedRuns: { select: { id: true, friendlyId: true } } },
      })) as { id: string; connectedRuns: { id: string; friendlyId: string }[] }[];

      expect(rows).toHaveLength(3);
      const byWaitpointId = new Map(rows.map((r) => [r.id, r.connectedRuns]));
      for (const [i, waitpointId] of waitpointIds.entries()) {
        const connected = byWaitpointId.get(waitpointId) ?? [];
        expect(connected).toHaveLength(1);
        expect(connected[0].id).toBe(runIds[i]);
      }

      // GROUPED: one bounded join query (raw, ROW_NUMBER-per-parent) + one target query for the
      // WHOLE batch, never one pair per parent. The bounded hydrator replaces the delegate
      // `waitpointRunConnection.findMany` with a single `$queryRaw`.
      expect(counting.queryRaw.count).toBe(1);
      expect(counting.counts.waitpointRunConnection.findMany).toBe(0);
      expect(counting.counts.taskRun.findMany).toBe(1);
      expect(counting.counts.taskRun.findFirst).toBe(0);
    }
  );
});
