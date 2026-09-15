// blockRunWithWaitpointEdges' legacy branch joined `FROM "Waitpoint" w`, so a LEGACY run blocking on
// a NEW-resident (run-ops) token — whose Waitpoint row lives on #new — matched 0 rows and wrote NO
// blocking edge. countPendingWaitpoints then fans out, still sees the token PENDING, so the run is
// suspended believing it's blocked while nothing will ever resume it -> silent hang. The fix sources
// the edge rows from the id array via `unnest` (FK-free, mirroring the dedicated branch); a migration
// drops the _WaitpointRunConnections -> Waitpoint FK so the cross-DB connection can be recorded too.
// Real two-DB topology; never mocked.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

const CUID_25 = "c".repeat(25); // LEGACY run -> #legacy (prisma14, full schema)

function makeRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

async function seedEnvironmentLegacy(prisma: PrismaClient, suffix: string) {
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
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    status: "EXECUTING" as const,
    friendlyId: `run_${opts.id}`,
    runtimeEnvironmentId: opts.runtimeEnvironmentId,
    environmentType: "DEVELOPMENT" as const,
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    taskIdentifier: "xdb-task",
    payload: "{}",
    payloadType: "application/json",
    traceContext: {},
    traceId: `trace_${opts.id}`,
    spanId: `span_${opts.id}`,
    queue: "task/xdb-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

describe("run-ops split — a LEGACY run blocking on a NEW-resident token gets its blocking edge (cross-DB)", () => {
  heteroRunOpsPostgresTest(
    "blockRunWithWaitpointEdges writes the edge for a cross-DB token instead of stranding the run",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeRouter(prisma14, prisma17);
      // The harness builds the schema with `prisma db push`, which re-creates the FKs that the
      // run-ops split migrations (20260705210000 / 20260705220000) drop in prod. Mirror those drops on
      // this clone so the cross-DB insert exercises the real prod state (FKs gone, app-enforced).
      await prisma14.$executeRawUnsafe(
        `ALTER TABLE "TaskRunWaitpoint" DROP CONSTRAINT IF EXISTS "TaskRunWaitpoint_waitpointId_fkey"`
      );
      await prisma14.$executeRawUnsafe(
        `ALTER TABLE "_WaitpointRunConnections" DROP CONSTRAINT IF EXISTS "_WaitpointRunConnections_B_fkey"`
      );
      const seed = await seedEnvironmentLegacy(prisma14, "xdbblock");
      const runId = `run_${CUID_25}`; // LEGACY run, resident on #legacy
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      // The token was minted co-located with a run-ops run, so its Waitpoint row lives on #new.
      const tokenId = "waitpoint_" + "x".repeat(20);
      await prisma17.waitpoint.create({
        data: {
          id: tokenId,
          friendlyId: "wp_xdb",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${tokenId}`,
          userProvidedIdempotencyKey: false,
          projectId: seed.project.id,
          environmentId: seed.environment.id,
        },
      });

      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [tokenId],
        projectId: seed.project.id,
      });

      // RED: the legacy `FROM "Waitpoint"` join matches 0 rows -> no edge -> the run is stranded.
      // GREEN: `unnest` writes the edge from the id directly.
      expect(
        await prisma14.taskRunWaitpoint.count({ where: { taskRunId: runId, waitpointId: tokenId } })
      ).toBe(1);
      // The historical connection is recorded too (needs the dropped B-fkey migration).
      const conn = (await prisma14.$queryRaw`
        SELECT "B" FROM "_WaitpointRunConnections" WHERE "A" = ${runId}
      `) as unknown[];
      expect(conn.length).toBe(1);
    }
  );
});
