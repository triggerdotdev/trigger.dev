import { getUsername } from "~/utils/username";
import { BasePresenter } from "./basePresenter.server";
import { type BulkActionMode } from "~/components/BulkActionFilterSummary";
import { parseRunListInputOptions } from "~/services/runsRepository/runsRepository.server";
import { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";

type BulkActionOptions = {
  environmentId: string;
  bulkActionId: string;
};

export class BulkActionPresenter extends BasePresenter {
  public async call({ environmentId, bulkActionId }: BulkActionOptions) {
    const bulkAction = await this._replica.bulkActionGroup.findFirst({
      select: {
        friendlyId: true,
        name: true,
        status: true,
        type: true,
        createdAt: true,
        completedAt: true,
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
      throw new Error("Bulk action not found");
    }

    //parse filters
    const filtersParsed = TaskRunListSearchFilters.safeParse(
      bulkAction.params && typeof bulkAction.params === "object" ? bulkAction.params : {}
    );

    let mode: BulkActionMode = "filter";
    if (
      filtersParsed.success &&
      Object.keys(filtersParsed.data).length === 1 &&
      filtersParsed.data.runId?.length
    ) {
      mode = "selected";
    }

    return {
      ...bulkAction,
      user: bulkAction.user
        ? { name: getUsername(bulkAction.user), avatarUrl: bulkAction.user.avatarUrl }
        : undefined,
      filters: filtersParsed.data ?? {},
      mode,
    };
  }
}
