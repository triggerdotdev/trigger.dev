// Under replica lag, BulkActionService.process (CANCEL and REPLAY) tolerates a member whose row has
// not replicated: the per-batch member-hydration findRuns misses, the member is skipped this pass (no
// throw, no mutation — not cancelled, not replayed), and the run stays live on the primary. The id set
// comes from ClickHouse, fed downstream of Postgres and lagging more than the PG replica, so an id
// cannot reach this batch before its PG row is on the replica — the skip window is unreachable.
//
// Drives the REAL exported BulkActionService.process against a real Postgres testcontainer. Tenant +
// group are seeded on the primary; only orthogonal peripherals are mocked (ClickHouse-sourced id list,
// commonWorker enqueue, db/engine/run-store singletons so the module imports don't construct at load).
// The member-hydration store is a real PostgresRunStore whose read replica is frozen via the shared
// laggingReplica primitive.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { BulkActionStatus, BulkActionType, type PrismaClient } from "@trigger.dev/database";
import { BulkActionId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Prevent the db / engine / run-store singletons from constructing at import (the service is driven with
// an explicitly-injected prisma + store).
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/v3/runEngine.server", () => ({ engine: {} }));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));
// commonWorker.enqueue is the "next batch" scheduling side effect — orthogonal to the hydration read.
vi.mock("~/v3/commonWorker.server", () => ({ commonWorker: { enqueue: vi.fn(async () => {}) } }));
// ClickHouse client factory — the id list is injected via the RunsRepository mock below.
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: vi.fn(async () => ({})) },
}));
// RunsRepository.listRunIds is the ClickHouse-sourced id page. Keep parseRunListInputOptions REAL; swap
// only the repository so listRunIds returns our controlled member id set + a terminal (null) cursor.
const listHolder = vi.hoisted(() => ({ runIds: [] as string[] }));
vi.mock("~/services/runsRepository/runsRepository.server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  RunsRepository: class {
    constructor(_opts: any) {}
    async listRunIds() {
      return { runIds: listHolder.runIds, pagination: { nextCursor: null, previousCursor: null } };
    }
    async countRuns() {
      return listHolder.runIds.length;
    }
  },
}));

import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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

async function seedRun(
  prisma: PrismaClient,
  seed: { organization: { id: string }; project: { id: string }; environment: { id: string } },
  suffix: string,
  status: "EXECUTING" | "COMPLETED_SUCCESSFULLY"
) {
  const runId = `run_${suffix}`;
  await prisma.taskRun.create({
    data: {
      id: runId,
      engine: "V2",
      status,
      friendlyId: `run_fr_${suffix}`,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: `trace_${suffix}`,
      spanId: `span_${suffix}`,
      queue: "task/my-task",
      runtimeEnvironmentId: seed.environment.id,
      projectId: seed.project.id,
      organizationId: seed.organization.id,
      environmentType: "DEVELOPMENT",
    },
  });
  return runId;
}

async function seedGroup(
  prisma: PrismaClient,
  seed: { project: { id: string }; environment: { id: string } },
  type: BulkActionType
) {
  const { id, friendlyId } = BulkActionId.generate();
  await prisma.bulkActionGroup.create({
    data: {
      id,
      friendlyId,
      projectId: seed.project.id,
      environmentId: seed.environment.id,
      type,
      params: {},
      queryName: "bulk_action_v1",
      status: BulkActionStatus.PENDING,
      totalCount: 1,
    },
  });
  return id;
}

describe("BulkActionV2.process tolerates members whose rows have not replicated", () => {
  // CANCEL.
  heteroPostgresTest(
    "CANCEL skips a member whose row has not replicated, leaving the run live on the primary",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `bulk_cancel_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = await seedRun(prisma, seed, suffix, "EXECUTING");
      const groupId = await seedGroup(prisma, seed, BulkActionType.CANCEL);

      listHolder.runIds = [runId];

      // Member-hydration store: primary live, taskRun frozen-missing on the replica.
      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: replica.client as never,
        schemaVariant: "legacy",
      });

      const service = new BulkActionService(prisma as never, prisma as never, store);
      await service.process(groupId, { continueInline: true });

      // The hydration read really hit the (lagging) replica.
      expect(replica.wasHit("taskRun")).toBe(true);

      // OBSERVABLE OUTPUT: the member was SKIPPED — the run was NOT cancelled (still EXECUTING).
      const onPrimary = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(onPrimary.status).toBe("EXECUTING");

      // No progress was counted for the skipped member (success=0, failure=0).
      const group = await prisma.bulkActionGroup.findFirstOrThrow({ where: { id: groupId } });
      expect(group.successCount).toBe(0);
      expect(group.failureCount).toBe(0);
    }
  );

  // REPLAY.
  heteroPostgresTest(
    "REPLAY skips a member whose row has not replicated, leaving the run live on the primary",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `bulk_replay_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = await seedRun(prisma, seed, suffix, "COMPLETED_SUCCESSFULLY");
      const groupId = await seedGroup(prisma, seed, BulkActionType.REPLAY);

      listHolder.runIds = [runId];

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: replica.client as never,
        schemaVariant: "legacy",
      });

      const service = new BulkActionService(prisma as never, prisma as never, store);
      await service.process(groupId, { continueInline: true });

      expect(replica.wasHit("taskRun")).toBe(true);

      // OBSERVABLE OUTPUT: the member was SKIPPED — no child replay run was created for this member.
      const childRuns = await prisma.taskRun.findMany({
        where: { rootTaskRunId: runId },
      });
      expect(childRuns).toHaveLength(0);

      const group = await prisma.bulkActionGroup.findFirstOrThrow({ where: { id: groupId } });
      expect(group.successCount).toBe(0);
      expect(group.failureCount).toBe(0);

      // The skip is pure lag: the member run is genuinely live on the primary.
      const onPrimary = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(onPrimary.friendlyId).toBe(`run_fr_${suffix}`);
    }
  );
});
