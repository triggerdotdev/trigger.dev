import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";

export type TagListOptions = {
  userId?: string;
  projectId: string;
  //filters
  name?: string;
  //pagination
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;

export type TagList = Awaited<ReturnType<RunTagListPresenter["call"]>>;
export type TagListItem = TagList["tags"][number];

export class RunTagListPresenter extends BasePresenter {
  public async call({
    userId,
    projectId,
    name,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  }: TagListOptions) {
    const hasFilters = name;

    const tags = await this._replica.taskRunTag.findMany({
      where: {
        projectId,
        name: name
          ? {
              contains: name,
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

    logger.log("tags", {
      tags,
      projectId,
      name,
    });

    return {
      tags: tags
        .map((tag) => ({
          id: tag.friendlyId,
          name: tag.name,
        }))
        .slice(0, pageSize),
      currentPage: page,
      hasMore: tags.length > pageSize,
      hasFilters,
    };
  }
}
