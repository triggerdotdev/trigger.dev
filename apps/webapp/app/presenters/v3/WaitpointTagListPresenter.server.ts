import { type PrismaClientOrTransaction } from "~/db.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
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
  constructor(
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    // Retained for source compatibility; read residency is now resolved inside `runStore`.
    _readRoute?: {
      runOpsNew?: PrismaClientOrTransaction;
      runOpsLegacyReplica?: PrismaClientOrTransaction;
      splitEnabled?: boolean;
    },
    private readonly runStore = defaultRunStore
  ) {
    super(prismaClient, replicaClient);
  }

  public async call({
    environmentId,
    name,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  }: TagListOptions) {
    const hasFilters = Boolean(name?.trim());
    const skip = (page - 1) * pageSize;

    // Fetch one extra row to detect a following page; `runStore` fans out across the new+legacy
    // run-ops DBs and de-dupes/orders/windows the merged result itself.
    const tags = await this.runStore.findManyWaitpointTags({
      where: {
        environmentId,
        name: name ? { startsWith: name, mode: "insensitive" } : undefined,
      },
      orderBy: { id: "desc" },
      take: pageSize + 1,
      skip,
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
