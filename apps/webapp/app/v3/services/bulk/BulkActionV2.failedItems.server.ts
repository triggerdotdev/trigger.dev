import { EngineServiceValidationError } from "@internal/run-engine";
import type { BulkActionType, PrismaClientOrTransaction } from "@trigger.dev/database";
import { ServiceValidationError } from "../common.server";

export type FailedBulkActionItem = {
  sourceRunId: string;
  error: string;
};

export const ALREADY_FINISHED_REASON = "Already finished";

/** The reason shown to the user. Only validation errors carry a message meant for them. */
export function bulkActionFailureReason(error: unknown, fallback: string): string {
  if (error instanceof ServiceValidationError || error instanceof EngineServiceValidationError) {
    return error.message;
  }
  return fallback;
}

/**
 * A bulk action records at most this many failed runs, and at most this many runs that had
 * already finished. A cancel over a filter that matches mostly finished runs would otherwise
 * write a row per run. The group's `failureCount` still counts every one.
 */
export const BULK_ACTION_MAX_RECORDED_ITEMS = 1000;

/**
 * Records one batch of failed items, up to the limit for each kind. The item id is derived from
 * the group and the run, so a batch that is processed again (job retry) doesn't record its
 * failures twice. `sourceRunId` has no foreign key: the run can live in the run-ops database.
 */
export async function recordFailedBulkActionItems(
  prisma: PrismaClientOrTransaction,
  groupId: string,
  type: BulkActionType,
  failures: FailedBulkActionItem[]
) {
  if (failures.length === 0) return;

  // At most two limits' worth of rows, read through the (groupId, createdAt) index.
  const recorded = await prisma.bulkActionItem.count({ where: { groupId } });
  const recordedAlreadyFinished = await prisma.bulkActionItem.count({
    where: { groupId, error: ALREADY_FINISHED_REASON },
  });
  let failedRoom = BULK_ACTION_MAX_RECORDED_ITEMS - (recorded - recordedAlreadyFinished);
  let alreadyFinishedRoom = BULK_ACTION_MAX_RECORDED_ITEMS - recordedAlreadyFinished;

  const toRecord = failures.filter((failure) =>
    failure.error === ALREADY_FINISHED_REASON ? alreadyFinishedRoom-- > 0 : failedRoom-- > 0
  );
  if (toRecord.length === 0) return;

  await prisma.bulkActionItem.createMany({
    data: toRecord.map((failure) => ({
      id: `${groupId}_${failure.sourceRunId}`,
      groupId,
      type,
      status: "FAILED" as const,
      sourceRunId: failure.sourceRunId,
      error: failure.error.slice(0, 1000),
    })),
    skipDuplicates: true,
  });
}

/**
 * How a bulk action's failure count splits, from the group's own count and the rows recorded
 * for it. Rows are capped per kind, so past one cap the remainder belongs to the kind that hit
 * it. Past both caps, or with no cap reached and rows missing, the remainder can't be told apart.
 */
export function summarizeBulkActionFailures({
  failureCount,
  recorded,
  recordedAlreadyFinished,
}: {
  failureCount: number;
  recorded: number;
  recordedAlreadyFinished: number;
}) {
  const recordedFailed = recorded - recordedAlreadyFinished;
  const notRecorded = Math.max(0, failureCount - recorded);
  const failedCapped = recordedFailed >= BULK_ACTION_MAX_RECORDED_ITEMS;
  const alreadyFinishedCapped = recordedAlreadyFinished >= BULK_ACTION_MAX_RECORDED_ITEMS;

  return {
    // Only when every failed run has its row can the rest be put down as already finished.
    alreadyFinished:
      recordedAlreadyFinished + (alreadyFinishedCapped && !failedCapped ? notRecorded : 0),
    /** The list stops at the limit: there are more runs than rows. */
    capped: notRecorded > 0 && (failedCapped || alreadyFinishedCapped),
    /**
     * Runs counted as failed that can't be put down as either kind: the bulk action ran before
     * reasons were recorded (no limit reached), or both limits were reached.
     */
    unclassified: failedCapped === alreadyFinishedCapped ? notRecorded : 0,
  };
}
