import {
  boundedIn,
  type BulkActionStatus,
  type BulkActionType,
  type Prisma,
} from "@trigger.dev/database";
import { getUsername } from "~/utils/username";
import { BasePresenter } from "./basePresenter.server";

type BulkActionListOptions = {
  environmentId: string;
  page?: number;
  types?: BulkActionType[];
  statuses?: BulkActionStatus[];
  users?: string[];
};

const DEFAULT_PAGE_SIZE = 25;

export type BulkActionListItem = Awaited<
  ReturnType<BulkActionListPresenter["call"]>
>["bulkActions"][number];

export class BulkActionListPresenter extends BasePresenter {
  public async call({ environmentId, page, types, statuses, users }: BulkActionListOptions) {
    const where = {
      environmentId,
      ...(types?.length ? { type: { in: types } } : {}),
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      ...(users?.length ? { userId: { in: users } } : {}),
    } satisfies Prisma.BulkActionGroupWhereInput;

    const totalCount = await this._replica.bulkActionGroup.count({
      where,
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
      where,
      orderBy: {
        createdAt: "desc",
      },
      skip: ((page ?? 1) - 1) * DEFAULT_PAGE_SIZE,
      take: DEFAULT_PAGE_SIZE,
    });

    // The User filter offers whoever has run a bulk action in this environment. Grouped in the
    // database: Prisma's `distinct` fetches every group's row and dedupes them here.
    const userIdRows = await this._replica.bulkActionGroup.groupBy({
      by: ["userId"],
      where: { environmentId, userId: { not: null } },
      orderBy: { userId: "asc" },
      take: 50,
    });
    const userIds = userIdRows.flatMap((row) => (row.userId ? [row.userId] : []));
    const userRows =
      userIds.length > 0
        ? await this._replica.user.findMany({
            where: { id: { in: boundedIn(userIds) } },
            select: { id: true, name: true, displayName: true, email: true },
          })
        : [];

    return {
      users: userRows.map((user) => ({
        id: user.id,
        name: getUsername(user) ?? user.id,
        email: user.email,
      })),
      hasFilters: Boolean(types?.length || statuses?.length || users?.length),
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
