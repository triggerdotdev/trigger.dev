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
): { client: RunOpsPrismaClient; counts: Record<string, CallCounts> } {
  const counts: Record<string, CallCounts> = {};
  for (const name of delegateNames) {
    counts[name] = { findMany: 0, findFirst: 0 };
  }
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
      return (target as any)[prop];
    },
  }) as RunOpsPrismaClient;
  return { client, counts };
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
});
