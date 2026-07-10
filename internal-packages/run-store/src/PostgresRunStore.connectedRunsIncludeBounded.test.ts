// RED→GREEN for bounding the DISPLAY `connectedRuns` RELATION hydration (findWaitpoint /
// findManyWaitpoints with `include`/`select: { connectedRuns }`), NOT the id-list helper
// `findWaitpointConnectedRunIds` (covered separately in connectedRunsBounded.test.ts).
//
// The dedicated-schema hydrator `hydrateConnectedRuns` goes through the generic
// `batchHydrateJoinRelation`, which fetched EVERY WaitpointRunConnection link with no per-parent
// cap — so a heavily-fanned-in waitpoint hydrated an unbounded connectedRuns list, bypassing the
// CONNECTED_RUNS_LIMIT the presenter/`findWaitpointConnectedRunIds` already enforce.
//
// The fix bounds it per parent via a window function + existence-JOIN to TaskRun, mirroring the
// bounded helper: a dangling connection row never occupies a LIMIT slot, and the returned relation
// is capped at CONNECTED_RUNS_LIMIT.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { CONNECTED_RUNS_LIMIT, PostgresRunStore } from "./PostgresRunStore.js";

function seedEnvironmentDedicated(suffix: string) {
  return {
    organization: { id: `org_${suffix}` },
    project: { id: `proj_${suffix}` },
    environment: { id: `env_${suffix}` },
  };
}

function taskRunData(opts: {
  id: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    status: "PENDING" as const,
    friendlyId: opts.friendlyId,
    runtimeEnvironmentId: opts.runtimeEnvironmentId,
    environmentType: "DEVELOPMENT" as const,
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    taskIdentifier: "my-task",
    payload: "{}",
    payloadType: "application/json",
    traceContext: {},
    traceId: `trace_${opts.id}`,
    spanId: `span_${opts.id}`,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

describe("PostgresRunStore.findWaitpoint — connectedRuns relation is bounded", () => {
  heteroRunOpsPostgresTest(
    "dedicated schema: include connectedRuns caps at CONNECTED_RUNS_LIMIT and skips dangling connections",
    async ({ prisma17 }) => {
      const store = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });

      const env = seedEnvironmentDedicated("cr_incl_new");
      const waitpointId = "waitpoint_cr_incl_new";
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_cr_incl_new",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      // Dangling connections (taskRunId points at runs that were never created). Legal on the
      // dedicated schema — WaitpointRunConnection.taskRunId is a scalar with no FK.
      const danglingRunIds = Array.from({ length: 20 }, (_, i) => `run_cr_dangling_${i}`);
      for (const runId of danglingRunIds) {
        await store.blockRunWithWaitpointEdges({
          runId,
          waitpointIds: [waitpointId],
          projectId: env.project.id,
        });
      }

      // More REAL connected runs than the limit.
      const realRunIds = Array.from(
        { length: CONNECTED_RUNS_LIMIT + 3 },
        (_, i) => `run_cr_real_${i}`
      );
      for (const [i, id] of realRunIds.entries()) {
        await prisma17.taskRun.create({
          data: taskRunData({
            id,
            friendlyId: `run_cr_incl_new_${i}`,
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          }),
        });
        await store.blockRunWithWaitpointEdges({
          runId: id,
          waitpointIds: [waitpointId],
          projectId: env.project.id,
        });
      }

      const waitpoint = (await store.findWaitpoint({
        where: { id: waitpointId },
        include: { connectedRuns: true },
      })) as unknown as { connectedRuns: { id: string }[] } | null;

      expect(waitpoint).not.toBeNull();
      const connectedRuns = waitpoint!.connectedRuns;

      // Bounded to exactly the cap (fixture connects more real runs than the limit).
      expect(connectedRuns).toHaveLength(CONNECTED_RUNS_LIMIT);
      // Never a dangling id — every returned run must be a REAL run.
      for (const run of connectedRuns) {
        expect(realRunIds).toContain(run.id);
        expect(danglingRunIds).not.toContain(run.id);
      }
    }
  );
});
