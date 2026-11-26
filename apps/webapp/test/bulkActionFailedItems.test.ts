import { postgresTest } from "@internal/testcontainers";
import { EngineServiceValidationError } from "@internal/run-engine";
import { describe, expect, it, vi } from "vitest";
import { ServiceValidationError } from "~/v3/services/common.server";
import {
  ALREADY_FINISHED_REASON,
  BULK_ACTION_MAX_RECORDED_ITEMS,
  bulkActionFailureReason,
  recordFailedBulkActionItems,
  summarizeBulkActionFailures,
} from "~/v3/services/bulk/BulkActionV2.failedItems.server";

vi.setConfig({ testTimeout: 60_000 });

describe("bulk action failed items", () => {
  /** Catches: a bulk action's failed runs not being recorded, recorded twice when a batch is
   * processed again, or refused because the run lives in another database. */
  postgresTest("records each failed run once, with its reason", async ({ prisma }) => {
    // The test database is pushed from schema.prisma, which still declares the relation;
    // migration 20260710120000 dropped these foreign keys from real databases.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_sourceRunId_fkey"`
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_groupId_fkey"`
    );

    const groupId = "bulk_group_1";
    // Neither run exists in this database: sourceRunId has no foreign key.
    const failures = [
      { sourceRunId: "run_a", error: "Already finished" },
      { sourceRunId: "run_b", error: 'Task "v2-only" not found' },
    ];

    await recordFailedBulkActionItems(prisma, groupId, "CANCEL", failures);
    await recordFailedBulkActionItems(prisma, groupId, "CANCEL", failures);
    await recordFailedBulkActionItems(prisma, groupId, "CANCEL", []);

    const items = await prisma.bulkActionItem.findMany({
      where: { groupId },
      orderBy: { sourceRunId: "asc" },
    });
    expect(items.map((i) => [i.sourceRunId, i.status, i.error])).toEqual([
      ["run_a", "FAILED", "Already finished"],
      ["run_b", "FAILED", 'Task "v2-only" not found'],
    ]);
  });

  /** Catches: a cancel over mostly finished runs writing a row per run, a failed run losing its
   * reason because already-finished runs used up the limit, or the page showing the unrecorded
   * runs as failures. */
  postgresTest("stops recording at the limit for each kind", async ({ prisma }) => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_sourceRunId_fkey"`
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "BulkActionItem" DROP CONSTRAINT IF EXISTS "BulkActionItem_groupId_fkey"`
    );

    const groupId = "bulk_group_capped";
    const limit = BULK_ACTION_MAX_RECORDED_ITEMS;
    const alreadyFinished = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        sourceRunId: `run_done_${from + i}`,
        error: ALREADY_FINISHED_REASON,
      }));

    // Batches as the service sends them, past the limit for already-finished runs.
    await recordFailedBulkActionItems(prisma, groupId, "CANCEL", alreadyFinished(0, limit - 50));
    await recordFailedBulkActionItems(prisma, groupId, "CANCEL", [
      ...alreadyFinished(limit - 50, 100),
      { sourceRunId: "run_failed_1", error: "Couldn't cancel this run" },
    ]);
    await recordFailedBulkActionItems(prisma, groupId, "CANCEL", [
      ...alreadyFinished(limit + 50, 100),
      { sourceRunId: "run_failed_2", error: "Couldn't cancel this run" },
    ]);

    const recorded = await prisma.bulkActionItem.count({ where: { groupId } });
    const recordedAlreadyFinished = await prisma.bulkActionItem.count({
      where: { groupId, error: ALREADY_FINISHED_REASON },
    });
    expect(recordedAlreadyFinished).toBe(limit);
    // Both real failures kept their row after the already-finished limit was reached.
    expect(recorded).toBe(limit + 2);

    // The group counted every run: 1,150 already finished and 2 failed.
    const failureCount = limit + 150 + 2;
    expect(
      summarizeBulkActionFailures({ failureCount, recorded, recordedAlreadyFinished })
    ).toEqual({ alreadyFinished: limit + 150, capped: true, unclassified: 0 });
  });

  /** Catches: a bulk action from before reasons were recorded showing "N failed" beside an
   * empty list that says nothing failed, or its failures put down as already finished. */
  it("tells an action with no recorded reasons from one that hit the limit", () => {
    expect(
      summarizeBulkActionFailures({ failureCount: 40, recorded: 0, recordedAlreadyFinished: 0 })
    ).toEqual({ alreadyFinished: 0, capped: false, unclassified: 40 });

    expect(
      summarizeBulkActionFailures({ failureCount: 12, recorded: 12, recordedAlreadyFinished: 9 })
    ).toEqual({ alreadyFinished: 9, capped: false, unclassified: 0 });
  });

  /** Catches: a cancel past both limits showing every unrecorded run as a failure, when most of
   * them had only finished already. */
  it("doesn't call the remainder failed once both limits are reached", () => {
    const limit = BULK_ACTION_MAX_RECORDED_ITEMS;
    expect(
      summarizeBulkActionFailures({
        failureCount: 11 * limit,
        recorded: 2 * limit,
        recordedAlreadyFinished: limit,
      })
    ).toEqual({ alreadyFinished: limit, capped: true, unclassified: 9 * limit });
  });

  /** Catches: internal error text (database hosts, stack details) shown as a failure reason. */
  it("only shows validation messages as reasons", () => {
    expect(bulkActionFailureReason(new ServiceValidationError("No such task"), "x")).toBe(
      "No such task"
    );
    expect(bulkActionFailureReason(new EngineServiceValidationError("Engine says no"), "x")).toBe(
      "Engine says no"
    );
    expect(bulkActionFailureReason(new Error("connect ECONNREFUSED db:5432"), "Fallback")).toBe(
      "Fallback"
    );
  });
});
