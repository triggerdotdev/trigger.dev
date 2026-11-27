import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn } from "@trigger.dev/database";
import { type BulkActionMode } from "~/components/BulkActionFilterSummary";
import { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getUsername } from "~/utils/username";
import { runStore } from "~/v3/runStore.server";
import {
  ALREADY_FINISHED_REASON,
  BULK_ACTION_MAX_RECORDED_ITEMS,
  summarizeBulkActionFailures,
} from "~/v3/services/bulk/BulkActionV2.failedItems.server";
import { BasePresenter } from "./basePresenter.server";

const FAILED_ITEMS_PAGE_SIZE = 25;
/** "View failed runs" links to the runs list by run ID; the URL holds this many at most. */
const FAILED_RUNS_LINK_LIMIT = 100;

type BulkActionOptions = {
  environmentId: string;
  userId?: string;
  bulkActionId: string;
  failedPage?: number;
};

export class BulkActionPresenter extends BasePresenter {
  public async call({ environmentId, bulkActionId, userId, failedPage = 1 }: BulkActionOptions) {
    const bulkAction = await this._replica.bulkActionGroup.findFirst({
      select: {
        id: true,
        friendlyId: true,
        name: true,
        status: true,
        type: true,
        createdAt: true,
        completedAt: true,
        updatedAt: true,
        totalCount: true,
        successCount: true,
        failureCount: true,
        user: {
          select: {
            name: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        params: true,
        project: {
          select: {
            id: true,
            organizationId: true,
          },
        },
      },
      where: {
        environmentId,
        friendlyId: bulkActionId,
      },
    });

    if (!bulkAction) {
      return null;
    }

    //parse filters
    const filtersParsed = TaskRunListSearchFilters.safeParse(
      bulkAction.params && typeof bulkAction.params === "object" ? bulkAction.params : {}
    );

    const rawParams = (
      bulkAction.params && typeof bulkAction.params === "object" ? bulkAction.params : {}
    ) as Record<string, unknown>;
    const replayVersion =
      typeof rawParams.replayVersion === "string" ? rawParams.replayVersion : undefined;
    const replayRegion =
      typeof rawParams.replayRegion === "string" ? rawParams.replayRegion : undefined;
    const replayEnvironment =
      typeof rawParams.replayEnvironmentId === "string"
        ? await this._replica.runtimeEnvironment.findFirst({
            where: { id: rawParams.replayEnvironmentId, projectId: bulkAction.project.id },
            select: {
              id: true,
              type: true,
              slug: true,
              branchName: true,
              orgMember: { select: { user: true } },
            },
          })
        : null;

    let mode: BulkActionMode = "filter";
    if (
      filtersParsed.success &&
      Object.keys(filtersParsed.data).length === 1 &&
      filtersParsed.data.runId?.length
    ) {
      mode = "selected";
    }

    const failedItems = await this.#failedItems(bulkAction.id, bulkAction.failureCount, failedPage);

    const { id: _id, ...rest } = bulkAction;
    return {
      ...rest,
      failedItems,
      user: bulkAction.user
        ? { name: getUsername(bulkAction.user), avatarUrl: bulkAction.user.avatarUrl }
        : undefined,
      filters: filtersParsed.data ?? {},
      mode,
      replayVersion,
      replayRegion,
      replayEnvironment: replayEnvironment
        ? {
            ...displayableEnvironment(replayEnvironment, userId),
            branchName: replayEnvironment.branchName ?? undefined,
          }
        : undefined,
    };
  }

  /**
   * What changes while a bulk action runs: its status and counts. The page polls this and
   * loads everything else once, so a tick is the group's row plus, for a cancel with failures,
   * two counts over its capped rows.
   */
  public async progress({
    environmentId,
    bulkActionId,
  }: {
    environmentId: string;
    bulkActionId: string;
  }) {
    const group = await this._replica.bulkActionGroup.findFirst({
      select: {
        id: true,
        type: true,
        status: true,
        totalCount: true,
        successCount: true,
        failureCount: true,
        completedAt: true,
        updatedAt: true,
      },
      where: { environmentId, friendlyId: bulkActionId },
    });
    if (!group) return null;

    const { id, type, ...progress } = group;
    // Only a cancel splits its failure count (already finished, failed).
    const summary =
      type === "CANCEL" && group.failureCount > 0
        ? summarizeBulkActionFailures({
            failureCount: group.failureCount,
            ...(await this.#recordedCounts(id)),
          })
        : undefined;

    return {
      ...progress,
      alreadyFinished: summary?.alreadyFinished ?? 0,
      unclassified: summary?.unclassified ?? 0,
    };
  }

  /** Rows are capped per bulk action, so both counts read a bounded number of rows. */
  async #recordedCounts(groupId: string) {
    const [recorded, recordedAlreadyFinished] = await Promise.all([
      this._replica.bulkActionItem.count({ where: { groupId, status: "FAILED" } }),
      // A cancel records runs that had already finished as failed items; they weren't failures.
      this._replica.bulkActionItem.count({
        where: { groupId, status: "FAILED", error: ALREADY_FINISHED_REASON },
      }),
    ]);
    return { recorded, recordedAlreadyFinished };
  }

  async #failedItems(groupId: string, failureCount: number, page: number) {
    // Rows are capped per bulk action (BULK_ACTION_MAX_RECORDED_ITEMS for each kind), so the
    // counts and the offset paging read a bounded number of rows. The total is the group's own
    // failureCount, which counts every run.
    const [{ recorded, recordedAlreadyFinished }, items, linkItems] = await Promise.all([
      this.#recordedCounts(groupId),
      this._replica.bulkActionItem.findMany({
        where: { groupId, status: "FAILED" },
        select: { sourceRunId: true, error: true },
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * FAILED_ITEMS_PAGE_SIZE,
        take: FAILED_ITEMS_PAGE_SIZE,
      }),
      this._replica.bulkActionItem.findMany({
        where: { groupId, status: "FAILED" },
        select: { sourceRunId: true },
        orderBy: { createdAt: "asc" },
        take: FAILED_RUNS_LINK_LIMIT,
      }),
    ]);
    const summary = summarizeBulkActionFailures({
      failureCount,
      recorded,
      recordedAlreadyFinished,
    });

    // Runs can live in the run-ops database, so they're read through the run store.
    const runs =
      items.length > 0
        ? await runStore.findRuns({
            where: { id: { in: boundedIn(items.map((item) => item.sourceRunId)) } },
            select: { id: true, friendlyId: true, taskIdentifier: true },
          })
        : [];
    const runsById = new Map(runs.map((run) => [run.id, run]));

    return {
      /** Every run the action failed on or found already finished. */
      total: failureCount,
      /** Runs with a row in the list below. */
      recorded,
      alreadyFinished: summary.alreadyFinished,
      capped: summary.capped,
      /** Counted as failed, kind unknown: before reasons were recorded, or past both limits. */
      unclassified: summary.unclassified,
      recordLimit: BULK_ACTION_MAX_RECORDED_ITEMS,
      page,
      totalPages: Math.max(1, Math.ceil(recorded / FAILED_ITEMS_PAGE_SIZE)),
      items: items.map((item) => {
        const run = runsById.get(item.sourceRunId);
        return {
          runId: run?.friendlyId ?? RunId.toFriendlyId(item.sourceRunId),
          taskIdentifier: run?.taskIdentifier,
          error: item.error ?? "Failed",
          alreadyFinished: item.error === ALREADY_FINISHED_REASON,
        };
      }),
      linkRunIds: linkItems.map((item) => RunId.toFriendlyId(item.sourceRunId)),
    };
  }
}
