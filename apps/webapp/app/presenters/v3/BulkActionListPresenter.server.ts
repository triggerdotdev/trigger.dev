import { getUsername } from "~/utils/username";
import { BasePresenter } from "./basePresenter.server";

type BulkActionListOptions = {
  environmentId: string;
  page?: number;
};

const DEFAULT_PAGE_SIZE = 25;

export type BulkActionListItem = Awaited<
  ReturnType<BulkActionListPresenter["call"]>
>["bulkActions"][number];

export class BulkActionListPresenter extends BasePresenter {
  public async call({ environmentId, page }: BulkActionListOptions) {
    const totalCount = await this._replica.bulkActionGroup.count({
      where: {
        environmentId,
      },
    });

    const bulkActions = await this._replica.bulkActionGroup.findMany({
      select: {
        friendlyId: true,
        name: true,
        status: true,
        type: true,
        createdAt: true,
        completedAt: true,
        totalCount: true,
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
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: ((page ?? 1) - 1) * DEFAULT_PAGE_SIZE,
      take: DEFAULT_PAGE_SIZE,
    });

    return {
      currentPage: page ?? 1,
      totalPages: Math.ceil(totalCount / DEFAULT_PAGE_SIZE),
      totalCount: totalCount,
      bulkActions: bulkActions.map((bulkAction) => ({
        ...bulkAction,
        user: bulkAction.user
          ? { name: getUsername(bulkAction.user), avatarUrl: bulkAction.user.avatarUrl }
          : undefined,
      })),
    };
  }
}
