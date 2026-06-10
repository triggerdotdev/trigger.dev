import { type ClickHouse } from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "~/db.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { type RunListFilter, type RunListResolver } from "./runReader.server";

export type ClickHouseRunListResolverOptions = {
  /** Resolves the per-organization ClickHouse client (multi-tenant routing). */
  getClickhouse: (organizationId: string) => Promise<ClickHouse>;
  prisma: PrismaClientOrTransaction;
};

/**
 * Resolves the realtime tag/list filter into matching run ids via ClickHouse `listRunIds` (filter-only;
 * rows hydrated from Postgres by id afterward). Tag matching is contains-ANY (OR) — note this differs from
 * Electric's `runTags @> ARRAY[...]` AND shape; restoring AND needs a `hasAll` mode on the ClickHouse filter.
 */
export class ClickHouseRunListResolver implements RunListResolver {
  constructor(private readonly options: ClickHouseRunListResolverOptions) {}

  async resolveMatchingRunIds(filter: RunListFilter): Promise<string[]> {
    const clickhouse = await this.options.getClickhouse(filter.organizationId);
    const repository = new RunsRepository({ clickhouse, prisma: this.options.prisma });

    const { runIds } = await repository.listRunIds({
      organizationId: filter.organizationId,
      projectId: filter.projectId,
      environmentId: filter.environmentId,
      tags: filter.tags && filter.tags.length > 0 ? filter.tags : undefined,
      batchId: filter.batchId,
      from: filter.createdAtAfter?.getTime(),
      page: { size: filter.limit },
    });

    // listRunIds is keyset-paginated; runIds is already capped to page.size (= limit).
    return runIds;
  }
}
