import { getUsername } from "~/utils/username";
import { BasePresenter } from "./basePresenter.server";

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
      },
      where: {
        environmentId,
        friendlyId: bulkActionId,
      },
    });

    if (!bulkAction) {
      throw new Error("Bulk action not found");
    }

    return {
      ...bulkAction,
      user: bulkAction.user
        ? { name: getUsername(bulkAction.user), avatarUrl: bulkAction.user.avatarUrl }
        : undefined,
    };
  }
}
