import { defaultQuery } from "~/v3/querySchemas";
import { BasePresenter } from "./basePresenter.server";
import type { QueryScope } from "~/services/queryService.server";

export type QueryHistoryItem = {
  id: string;
  query: string;
  scope: QueryScope;
  createdAt: Date;
  userName: string | null;
};

export class QueryPresenter extends BasePresenter {
  public async call({ organizationId }: { organizationId: string }) {
    const history = await this._replica.customerQuery.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        query: true,
        scope: true,
        createdAt: true,
        user: {
          select: { name: true, displayName: true },
        },
      },
    });

    return {
      defaultQuery,
      history: history.map(
        (q): QueryHistoryItem => ({
          id: q.id,
          query: q.query,
          scope: q.scope.toLowerCase() as QueryScope,
          createdAt: q.createdAt,
          userName: q.user?.displayName ?? q.user?.name ?? null,
        })
      ),
    };
  }
}

