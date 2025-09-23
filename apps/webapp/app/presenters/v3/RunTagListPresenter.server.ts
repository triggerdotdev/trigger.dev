import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { BasePresenter } from "./basePresenter.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { type PrismaClient } from "@trigger.dev/database";
import { timeFilters } from "~/components/runs/v3/SharedFilters";

export type TagListOptions = {
  organizationId: string;
  environmentId: string;
  projectId: string;
  period?: string;
  from?: Date;
  to?: Date;
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
    organizationId,
    environmentId,
    projectId,
    name,
    period,
    from,
    to,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  }: TagListOptions) {
    const hasFilters = Boolean(name?.trim());

    const runsRepository = new RunsRepository({
      clickhouse: clickhouseClient,
      prisma: this._replica as PrismaClient,
    });

    const tags = await runsRepository.listTags({
      organizationId,
      projectId,
      environmentId,
      query: name,
      period,
      from: from ? from.getTime() : undefined,
      to: to ? to.getTime() : undefined,
      offset: (page - 1) * pageSize,
      limit: pageSize + 1,
    });

    return {
      tags: tags.tags,
      currentPage: page,
      hasMore: tags.tags.length > pageSize,
      hasFilters,
    };
  }
}
