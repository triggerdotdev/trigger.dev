// RED→GREEN for bounding the connected-runs read path so it can never emit an unbounded id list.
//
// Mirrors the fix already shipped in `apps/webapp/app/presenters/v3/WaitpointPresenter.server.ts`
// `#connectedRunIdsOn`: existence-JOIN to TaskRun (so a dangling connection row can never occupy a
// LIMIT slot ahead of a real run), then LIMIT to `CONNECTED_RUNS_LIMIT` on BOTH schema branches.
//
// `PostgresRunStore.findWaitpointConnectedRunIds` currently has neither: the dedicated branch does
// a bare `waitpointRunConnection.findMany` (no LIMIT, no existence check) and the legacy branch does
// a bare `SELECT "A" FROM "_WaitpointRunConnections"` (same). `RoutingRunStore.findWaitpointConnectedRunIds`
// unions the two stores' results with no final cap, so even if each store were individually bounded
// the cross-DB union would not be.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { CONNECTED_RUNS_LIMIT, PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

function seedEnvironmentDedicated(suffix: string) {
  return {
    organization: { id: `org_${suffix}` },
    project: { id: `proj_${suffix}` },
    environment: { id: `env_${suffix}` },
  };
}

async function seedEnvironmentLegacy(prisma: any, suffix: string) {
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
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
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

describe("PostgresRunStore.findWaitpointConnectedRunIds — bounded via existence-JOIN + LIMIT", () => {
  heteroRunOpsPostgresTest(
    "dedicated schema: caps at CONNECTED_RUNS_LIMIT and never returns a dangling (run-less) connection",
    async ({ prisma17 }) => {
      const store = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });

      const newEnv = seedEnvironmentDedicated("bound_new");
      const waitpointId = "waitpoint_bound_new";
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_bound_new",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: newEnv.project.id,
          environmentId: newEnv.environment.id,
        },
      });

      // Dangling connections FIRST: taskRunId points at runs that were NEVER created. Legal on the
      // dedicated schema — `WaitpointRunConnection.taskRunId` is a scalar, no FK (see schema.prisma).
      const danglingRunIds = Array.from({ length: 20 }, (_, i) => `run_dangling_${i}`);
      for (const runId of danglingRunIds) {
        await store.blockRunWithWaitpointEdges({
          runId,
          waitpointIds: [waitpointId],
          projectId: newEnv.project.id,
        });
      }

      // A few REAL connected runs, inserted AFTER the dangling ones.
      const realRunIds = ["run_real_0", "run_real_1", "run_real_2"];
      for (const [i, id] of realRunIds.entries()) {
        await prisma17.taskRun.create({
          data: taskRunData({
            id,
            friendlyId: `run_bound_new_${i}`,
            organizationId: newEnv.organization.id,
            projectId: newEnv.project.id,
            runtimeEnvironmentId: newEnv.environment.id,
          }),
        });
        await store.blockRunWithWaitpointEdges({
          runId: id,
          waitpointIds: [waitpointId],
          projectId: newEnv.project.id,
        });
      }

      const result = await store.findWaitpointConnectedRunIds(waitpointId);

      // Bounded.
      expect(result.length).toBeLessThanOrEqual(CONNECTED_RUNS_LIMIT);
      // Never a dangling id — every returned id must be one of the REAL runs.
      for (const id of result) {
        expect(realRunIds).toContain(id);
      }
      // Not starved out: all 3 real runs (well under the limit) must be present.
      for (const id of realRunIds) {
        expect(result).toContain(id);
      }
    }
  );

  heteroRunOpsPostgresTest(
    "legacy schema: caps at CONNECTED_RUNS_LIMIT instead of returning every connected run",
    async ({ prisma14 }) => {
      const store = new PostgresRunStore({
        prisma: prisma14 as never,
        readOnlyPrisma: prisma14 as never,
        schemaVariant: "legacy",
      });

      const legEnv = await seedEnvironmentLegacy(prisma14, "bound_leg");
      const waitpointId = "waitpoint_bound_leg";
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_bound_leg",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });

      // More real connected runs than CONNECTED_RUNS_LIMIT — the legacy `_WaitpointRunConnections`
      // table still enforces an FK from "A" to TaskRun, so every row here is a real run.
      const realRunIds = Array.from({ length: CONNECTED_RUNS_LIMIT + 3 }, (_, i) => `run_leg_${i}`);
      for (const [i, id] of realRunIds.entries()) {
        await prisma14.taskRun.create({
          data: taskRunData({
            id,
            friendlyId: `run_bound_leg_${i}`,
            organizationId: legEnv.organization.id,
            projectId: legEnv.project.id,
            runtimeEnvironmentId: legEnv.environment.id,
          }),
        });
        await store.blockRunWithWaitpointEdges({
          runId: id,
          waitpointIds: [waitpointId],
          projectId: legEnv.project.id,
        });
      }

      const result = await store.findWaitpointConnectedRunIds(waitpointId);

      expect(result.length).toBeLessThanOrEqual(CONNECTED_RUNS_LIMIT);
    }
  );
});

describe("RoutingRunStore.findWaitpointConnectedRunIds — the cross-DB union is also bounded", () => {
  heteroRunOpsPostgresTest(
    "slices the merged NEW+LEGACY result to CONNECTED_RUNS_LIMIT",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({
        prisma: prisma14 as never,
        readOnlyPrisma: prisma14 as never,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const legEnv = await seedEnvironmentLegacy(prisma14, "bound_union_leg");
      const newEnv = seedEnvironmentDedicated("bound_union_new");
      const waitpointId = "waitpoint_bound_union";
      // The legacy `TaskRunWaitpoint.waitpointId` FK is still live in this test DB (built via
      // `prisma db push` from schema.prisma, which still declares the relation even though a later
      // migration drops the constraint in real deployments) — the legacy leg needs a real row here.
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_bound_union",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });

      // Each store individually caps at CONNECTED_RUNS_LIMIT, but a distinct set of runs on EACH side
      // means the union of the two capped results can still exceed the limit without a final slice.
      const legacyRunIds = Array.from(
        { length: CONNECTED_RUNS_LIMIT },
        (_, i) => `run_union_leg_${i}`
      );
      for (const [i, id] of legacyRunIds.entries()) {
        await prisma14.taskRun.create({
          data: taskRunData({
            id,
            friendlyId: `run_union_leg_${i}`,
            organizationId: legEnv.organization.id,
            projectId: legEnv.project.id,
            runtimeEnvironmentId: legEnv.environment.id,
          }),
        });
        await legacyStore.blockRunWithWaitpointEdges({
          runId: id,
          waitpointIds: [waitpointId],
          projectId: legEnv.project.id,
        });
      }

      const newRunIds = Array.from(
        { length: CONNECTED_RUNS_LIMIT },
        (_, i) => `run_union_new_${i}`
      );
      for (const [i, id] of newRunIds.entries()) {
        await prisma17.taskRun.create({
          data: taskRunData({
            id,
            friendlyId: `run_union_new_${i}`,
            organizationId: newEnv.organization.id,
            projectId: newEnv.project.id,
            runtimeEnvironmentId: newEnv.environment.id,
          }),
        });
        await newStore.blockRunWithWaitpointEdges({
          runId: id,
          waitpointIds: [waitpointId],
          projectId: newEnv.project.id,
        });
      }

      const result = await router.findWaitpointConnectedRunIds(waitpointId);

      expect(result.length).toBeLessThanOrEqual(CONNECTED_RUNS_LIMIT);
    }
  );
});
