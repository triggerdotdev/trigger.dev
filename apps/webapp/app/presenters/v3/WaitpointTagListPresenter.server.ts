import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";

export type TagListOptions = {
  environmentId: string;
  names?: string[];
  //pagination
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;

export type TagList = Awaited<ReturnType<WaitpointTagListPresenter["call"]>>;
export type TagListItem = TagList["tags"][number];

export class WaitpointTagListPresenter extends BasePresenter {
  public async call({
    environmentId,
    names,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  }: TagListOptions) {
    const hasFilters = names !== undefined && names.length > 0;

    const tags = await this._replica.waitpointTag.findMany({
      where: {
        environmentId,
        OR:
          names && names.length > 0
            ? names.map((name) => ({ name: { contains: name, mode: "insensitive" } }))
            : undefined,
      },
      orderBy: {
        id: "desc",
      },
      take: pageSize + 1,
      skip: (page - 1) * pageSize,
    });

    return {
      tags: tags
        .map((tag) => ({
          name: tag.name,
        }))
        .slice(0, pageSize),
      currentPage: page,
      hasMore: tags.length > pageSize,
      hasFilters,
    };
  }
}
