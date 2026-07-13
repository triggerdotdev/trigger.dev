// End-to-end resume-read path (managed worker `snapshots.since`): getExecutionSnapshotsSince ->
// getSnapshotWaitpointIds -> runStore.findSnapshotCompletedWaitpointIds(latestSnapshot.id). The
// latest snapshot id is a cuid, so the pre-fix router misrouted it to #legacy and the resumed NEW
// run received an empty completedWaitpoints list and hung. This asserts the whole path delivers the
// NEW-resident completed waitpoint. Real two-DB topology; never mocked.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore, type CreateRunInput } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect } from "vitest";
import { setTimeout as sleep } from "timers/promises";
import { getExecutionSnapshotsSince } from "../systems/executionSnapshotSystem.js";

const RUN_OPS_A = "n".repeat(24) + "01"; // run-ops id -> NEW (#new / prisma17)

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

async function seedControlPlaneEnv(prisma: PrismaClient, suffix: string) {
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

function buildCreateRunInput(p: {
  runId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: "run_since",
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "since-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${p.runId}`,
      spanId: `span_${p.runId}`,
      runTags: [],
      queue: "task/since-task",
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
      environmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

describe("run-ops split — getExecutionSnapshotsSince delivers a NEW run's completed waitpoints on resume", () => {
  heteroRunOpsPostgresTest(
    "the resumed snapshot carries the NEW-resident completed waitpoint (managed snapshots.since path)",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeRouter(prisma14, prisma17);
      const runId = `run_${RUN_OPS_A}`;
      const env = await seedControlPlaneEnv(prisma14, "sincepath");

      await router.createRun(
        buildCreateRunInput({
          runId,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      const since = await router.findLatestExecutionSnapshot(runId); // RUN_CREATED, the "since"

      // The resumed PENDING_EXECUTING snapshot (its id is a cuid). Space it past `since` in time.
      await sleep(10);
      const latest = await router.createExecutionSnapshot(
        {
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "PENDING_EXECUTING", description: "resumed" },
          previousSnapshotId: since!.id,
          environmentId: env.environment.id,
          environmentType: "PRODUCTION",
          projectId: env.project.id,
          organizationId: env.organization.id,
        },
        prisma14
      );

      // A completed waitpoint on #new, joined to the resumed snapshot (as completeWaitpoint would).
      const waitpointId = `waitpoint_${RUN_OPS_A}`;
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_since",
          type: "MANUAL",
          status: "COMPLETED",
          completedAt: new Date(),
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });
      await prisma17.completedWaitpoint.create({
        data: { snapshotId: latest.id, waitpointId },
      });

      const snapshots = await getExecutionSnapshotsSince(prisma14, runId, since!.id, router);
      const resumed = snapshots.find((s) => s.id === latest.id);

      // RED: findSnapshotCompletedWaitpointIds(latest.id cuid) -> #legacy -> [] -> resumed run hangs.
      // GREEN: fan-out finds the #new join -> the resumed snapshot carries the completed waitpoint.
      expect(resumed?.completedWaitpoints.map((w) => w.id)).toEqual([waitpointId]);
    }
  );
});
