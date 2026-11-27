// A batch's failed runs are recorded together with the group's counters. Drives the real
// BulkActionService.process against a real Postgres; the ClickHouse id page, the engine and the
// worker queue are stubbed as in bulkActionV2.replicaLag.test.ts.

import { postgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { BulkActionStatus, BulkActionType } from "@trigger.dev/database";
import { BulkActionId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  $transaction: (client: any, _name: string, fn: (tx: any) => Promise<unknown>) =>
    client.$transaction(fn),
}));
// No engine: the cancel fails, which is the failed run the batch records.
vi.mock("~/v3/runEngine.server", () => ({ engine: {} }));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));
vi.mock("~/v3/commonWorker.server", () => ({ commonWorker: { enqueue: vi.fn(async () => {}) } }));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: vi.fn(async () => ({})) },
}));
const listHolder = vi.hoisted(() => ({ runIds: [] as string[] }));
vi.mock("~/services/runsRepository/runsRepository.server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  RunsRepository: class {
    constructor(_opts: any) {}
    async listRunIds() {
      return { runIds: listHolder.runIds, pagination: { nextCursor: null, previousCursor: null } };
    }
  },
}));

import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";

describe("BulkActionV2.process failed items", () => {
  /** Catches: a failed row left behind by a batch whose group update failed, so a run the retry
   * handled is still listed (and offered for replay) as failed. */
  postgresTest("keeps no failed row from a batch that wasn't counted", async ({ prisma }) => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_sourceRunId_fkey"`
    );

    const organization = await prisma.organization.create({
      data: { title: "Org", slug: "org-atomic" },
    });
    const project = await prisma.project.create({
      data: {
        name: "Project",
        slug: "project-atomic",
        externalRef: "proj_atomic",
        organizationId: organization.id,
      },
    });
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        type: "DEVELOPMENT",
        slug: "dev",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: "tr_dev_atomic",
        pkApiKey: "pk_dev_atomic",
        shortcode: "short_atomic",
      },
    });
    const run = await prisma.taskRun.create({
      data: {
        engine: "V2",
        status: "EXECUTING",
        friendlyId: "run_atomic",
        taskIdentifier: "my-task",
        payload: "{}",
        payloadType: "application/json",
        traceId: "trace_atomic",
        spanId: "span_atomic",
        queue: "task/my-task",
        runtimeEnvironmentId: environment.id,
        projectId: project.id,
        organizationId: organization.id,
        environmentType: "DEVELOPMENT",
      },
    });
    const { id: groupId, friendlyId } = BulkActionId.generate();
    await prisma.bulkActionGroup.create({
      data: {
        id: groupId,
        friendlyId,
        projectId: project.id,
        environmentId: environment.id,
        type: BulkActionType.CANCEL,
        params: {},
        queryName: "bulk_action_v1",
        status: BulkActionStatus.PENDING,
        totalCount: 1,
      },
    });
    listHolder.runIds = [run.id];

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const service = new BulkActionService(prisma as never, prisma as never, store);

    // The group update fails, as it would on a dropped connection.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION fail_group_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'group update failed'; END $$ LANGUAGE plpgsql`
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER fail_group_update BEFORE UPDATE ON "BulkActionGroup" FOR EACH ROW EXECUTE FUNCTION fail_group_update()`
    );

    await expect(service.process(groupId, { continueInline: true })).rejects.toThrow();
    expect(await prisma.bulkActionItem.count({ where: { groupId } })).toBe(0);

    // The retry records the run and counts it once.
    await prisma.$executeRawUnsafe(`DROP TRIGGER fail_group_update ON "BulkActionGroup"`);
    await service.process(groupId, { continueInline: true });

    const items = await prisma.bulkActionItem.findMany({ where: { groupId } });
    expect(items.map((item) => item.sourceRunId)).toEqual([run.id]);
    const group = await prisma.bulkActionGroup.findFirstOrThrow({ where: { id: groupId } });
    expect(group.failureCount).toBe(1);
    expect(group.status).toBe("COMPLETED");
  });
});
