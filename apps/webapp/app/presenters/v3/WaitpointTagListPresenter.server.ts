import { BasePresenter } from "./basePresenter.server";

export type TagListOptions = {
  environmentId: string;
  name?: string;
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
    name,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  }: TagListOptions) {
    const hasFilters = Boolean(name?.trim());

    const tags = await this._replica.waitpointTag.findMany({
      where: {
        environmentId,
        name: name
          ? {
              startsWith: name,
              mode: "insensitive",
            }
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
