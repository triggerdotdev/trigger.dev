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
 * Resolves the realtime tag/list filter into matching run ids via ClickHouse
 * `listRunIds`. Tag matching is contains-ANY (OR), the same
 * semantics the dashboard runs list uses. Filter-only: ids only, hydrated from
 * Postgres by id afterward. This keeps the realtime tag feed off the Postgres
 * `runTags` GIN index entirely.
 *
 * (Multi-tag subscribeToRunsWithTag is therefore OR, not the AND that Electric's
 * `runTags @> ARRAY[...]` shape used. Restoring AND is a follow-up: add a
 * `hasAll` mode to the ClickHouse runs filter and use it here.)
 */
export class ClickHouseRunListResolver implements RunListResolver {
  constructor(private readonly options: ClickHouseRunListResolverOptions) {}

  async resolveMatchingRunIds(filter: RunListFilter): Promise<string[]> {
    const clickhouse = await this.options.getClickhouse(filter.organizationId);
    const repository = new RunsRepository({ clickhouse, prisma: this.options.prisma });

    return repository.listRunIds({
      organizationId: filter.organizationId,
      projectId: filter.projectId,
      environmentId: filter.environmentId,
      tags: filter.tags && filter.tags.length > 0 ? filter.tags : undefined,
      batchId: filter.batchId,
      from: filter.createdAtAfter?.getTime(),
      page: { size: filter.limit },
    });
  }
}
