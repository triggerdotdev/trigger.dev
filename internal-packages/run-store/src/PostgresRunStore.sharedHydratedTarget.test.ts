// RED→GREEN: bare-projection dedicated-relation hydration (e.g. `connectedRuns: true`) shares ONE
// target object reference across every parent bucket that links it, so an in-place mutation on one
// parent's hydrated target aliases into another's. Two waitpoints connecting to the SAME run should
// come back with DISTINCT `TaskRun` objects, not the same instance.

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

describe("PostgresRunStore dedicated relation hydrators — shared target identity (bare projection)", () => {
  heteroRunOpsPostgresTest(
    "findManyWaitpoints hydrates bare `connectedRuns: true` for two waitpoints sharing one run as DISTINCT objects",
    async ({ prisma17 }) => {
      const store = makeStore(prisma17);
      const env = seedEnvironmentDedicated("shared_target");

      const runId = "run_shared_target";
      const waitpointIds = ["wp_shared_1", "wp_shared_2"];

      await store.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_shared_target_friendly",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      for (const waitpointId of waitpointIds) {
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
      }

      // Both waitpoints connect to the SAME run: the target-row `findMany` in
      // `batchHydrateJoinRelation` returns ONE row for the run, shared across both parents' buckets.
      await store.blockRunWithWaitpointEdges({
        runId,
        waitpointIds,
        projectId: env.project.id,
      });

      // Bare projection (`connectedRuns: true`, no sub-select) — the buggy path: `applyProjection`
      // returns the row UNCHANGED instead of a fresh object.
      const rows = (await store.findManyWaitpoints({
        where: { id: { in: waitpointIds } },
        include: { connectedRuns: true },
      })) as { id: string; connectedRuns: { id: string; friendlyId: string }[] }[];

      expect(rows).toHaveLength(2);
      const byWaitpointId = new Map(rows.map((r) => [r.id, r.connectedRuns]));
      const target1 = byWaitpointId.get("wp_shared_1")?.[0];
      const target2 = byWaitpointId.get("wp_shared_2")?.[0];

      expect(target1).toBeDefined();
      expect(target2).toBeDefined();
      expect(target1!.id).toBe(runId);
      expect(target2!.id).toBe(runId);

      // THE BUG: both hydrated targets are the SAME object reference.
      expect(target1).not.toBe(target2);

      // Mutating a top-level field on one parent's hydrated target must NOT change the other's.
      (target1 as { friendlyId: string }).friendlyId = "mutated";
      expect(target2!.friendlyId).not.toBe("mutated");
    }
  );
});
