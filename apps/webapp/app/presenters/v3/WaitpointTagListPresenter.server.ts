import { type PrismaClientOrTransaction } from "~/db.server";
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

type WaitpointTagRow = {
  id: string;
  name: string;
};

type TagFindManyArgs = NonNullable<
  Parameters<PrismaClientOrTransaction["waitpointTag"]["findMany"]>[0]
>;
type TagQuery = {
  where: TagFindManyArgs["where"];
  orderBy: TagFindManyArgs["orderBy"];
};

export class WaitpointTagListPresenter extends BasePresenter {
  constructor(
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    private readonly readRoute?: {
      runOpsNew?: PrismaClientOrTransaction;
      runOpsLegacyReplica?: PrismaClientOrTransaction; // READ REPLICA only — never the legacy primary
      splitEnabled?: boolean;
    }
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

    const query: TagQuery = {
      where: {
        environmentId,
        name: name ? { startsWith: name, mode: "insensitive" } : undefined,
      },
      orderBy: { id: "desc" },
    };

    const tags = await this.#scanTags(query, skip, pageSize);

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

  async #scanTags(query: TagQuery, skip: number, pageSize: number): Promise<WaitpointTagRow[]> {
    const scan = (client: PrismaClientOrTransaction, take: number, offset: number) =>
      client.waitpointTag.findMany({ ...query, take, skip: offset });

    if (!this.readRoute?.splitEnabled) {
      return scan(this._replica, pageSize + 1, skip);
    }

    const prefixSize = skip + pageSize + 1;

    const newRows = await scan(this.readRoute.runOpsNew ?? this._replica, prefixSize, 0);

    // New DB filled the prefix => any older tags fall on a later page; skip the
    // legacy read entirely. Presence on the new DB is the migrated signal.
    if (newRows.length >= prefixSize) {
      return newRows.slice(skip, prefixSize);
    }

    const legacyRows = await scan(
      this.readRoute.runOpsLegacyReplica ?? this._replica,
      prefixSize,
      0
    );

    const byId = new Map<string, WaitpointTagRow>();
    for (const row of newRows) byId.set(row.id, row);
    for (const row of legacyRows) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }

    const merged = Array.from(byId.values());
    merged.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    return merged.slice(skip, skip + pageSize + 1);
  }
}
