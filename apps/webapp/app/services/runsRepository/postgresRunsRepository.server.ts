import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { Prisma } from "@trigger.dev/database";
import { sqlDatabaseSchema } from "~/db.server";
import {
  type FilterRunsOptions,
  type IRunsRepository,
  type ListRunsOptions,
  type ListedRun,
  type RunListInputOptions,
  type RunsRepositoryOptions,
  convertRunListInputOptionsToFilterRunsOptions,
} from "./runsRepository.server";

export class PostgresRunsRepository implements IRunsRepository {
  constructor(private readonly options: RunsRepositoryOptions) {}

  get name() {
    return "postgres";
  }

  async listRunIds(options: ListRunsOptions) {
    const filterOptions = await convertRunListInputOptionsToFilterRunsOptions(
      options,
      this.options.prisma
    );

    const query = this.#buildRunIdsQuery(filterOptions, options.page);
    const runs = await this.options.prisma.$queryRaw<{ id: string }[]>(query);

    return runs.map((run) => run.id);
  }

  async listRuns(options: ListRunsOptions) {
    const filterOptions = await convertRunListInputOptionsToFilterRunsOptions(
      options,
      this.options.prisma
    );

    const query = this.#buildRunsQuery(filterOptions, options.page);
    const runs = await this.options.prisma.$queryRaw<ListedRun[]>(query);

    // If there are more runs than the page size, we need to fetch the next page
    const hasMore = runs.length > options.page.size;

    let nextCursor: string | null = null;
    let previousCursor: string | null = null;

    // Get cursors for next and previous pages
    const direction = options.page.direction ?? "forward";
    switch (direction) {
      case "forward": {
        previousCursor = options.page.cursor ? runs.at(0)?.id ?? null : null;
        if (hasMore) {
          // The next cursor should be the last run ID from this page
          nextCursor = runs[options.page.size - 1]?.id ?? null;
        }
        break;
      }
      case "backward": {
        const reversedRuns = [...runs].reverse();
        if (hasMore) {
          previousCursor = reversedRuns.at(1)?.id ?? null;
          nextCursor = reversedRuns.at(options.page.size)?.id ?? null;
        } else {
          nextCursor = reversedRuns.at(options.page.size - 1)?.id ?? null;
        }
        break;
      }
    }

    const runsToReturn =
      options.page.direction === "backward" && hasMore
        ? runs.slice(1, options.page.size + 1)
        : runs.slice(0, options.page.size);

    // ClickHouse is slightly delayed, so we're going to do in-memory status filtering too
    let filteredRuns = runsToReturn;
    if (options.statuses && options.statuses.length > 0) {
      filteredRuns = runsToReturn.filter((run) => options.statuses!.includes(run.status));
    }

    return {
      runs: filteredRuns,
      pagination: {
        nextCursor,
        previousCursor,
      },
    };
  }

  async countRuns(options: RunListInputOptions) {
    const filterOptions = await convertRunListInputOptionsToFilterRunsOptions(
      options,
      this.options.prisma
    );

    const query = this.#buildCountQuery(filterOptions);
    const result = await this.options.prisma.$queryRaw<{ count: bigint }[]>(query);

    if (result.length === 0) {
      throw new Error("No count rows returned");
    }

    return Number(result[0].count);
  }

  #buildRunIdsQuery(
    filterOptions: FilterRunsOptions,
    page: { size: number; cursor?: string; direction?: "forward" | "backward" }
  ) {
    const whereConditions = this.#buildWhereConditions(filterOptions, page.cursor, page.direction);

    return Prisma.sql`
      SELECT tr.id
      FROM ${sqlDatabaseSchema}."TaskRun" tr
      WHERE ${whereConditions}
      ORDER BY ${page.direction === "backward" ? Prisma.sql`tr.id ASC` : Prisma.sql`tr.id DESC`}
      LIMIT ${page.size + 1}
    `;
  }

  #buildRunsQuery(
    filterOptions: FilterRunsOptions,
    page: { size: number; cursor?: string; direction?: "forward" | "backward" }
  ) {
    const whereConditions = this.#buildWhereConditions(filterOptions, page.cursor, page.direction);

    return Prisma.sql`
      SELECT
        tr.id,
        tr."friendlyId",
        tr."taskIdentifier",
        tr."taskVersion",
        tr."runtimeEnvironmentId",
        tr.status,
        tr."createdAt",
        tr."startedAt",
        tr."lockedAt",
        tr."delayUntil",
        tr."updatedAt",
        tr."completedAt",
        tr."isTest",
        tr."spanId",
        tr."idempotencyKey",
        tr."ttl",
        tr."expiredAt",
        tr."costInCents",
        tr."baseCostInCents",
        tr."usageDurationMs",
        tr."runTags",
        tr."depth",
        tr."rootTaskRunId",
        tr."batchId",
        tr."metadata",
        tr."metadataType",
        tr."machinePreset",
        tr."queue"
      FROM ${sqlDatabaseSchema}."TaskRun" tr
      WHERE ${whereConditions}
      ORDER BY ${page.direction === "backward" ? Prisma.sql`tr.id ASC` : Prisma.sql`tr.id DESC`}
      LIMIT ${page.size + 1}
    `;
  }

  #buildCountQuery(filterOptions: FilterRunsOptions) {
    const whereConditions = this.#buildWhereConditions(filterOptions);

    return Prisma.sql`
      SELECT COUNT(*) as count
      FROM ${sqlDatabaseSchema}."TaskRun" tr
      WHERE ${whereConditions}
    `;
  }

  #buildWhereConditions(
    filterOptions: FilterRunsOptions,
    cursor?: string,
    direction?: "forward" | "backward"
  ) {
    const conditions: Prisma.Sql[] = [];

    // Environment filter
    conditions.push(Prisma.sql`tr."runtimeEnvironmentId" = ${filterOptions.environmentId}`);

    // Cursor pagination
    if (cursor) {
      if (direction === "forward" || !direction) {
        conditions.push(Prisma.sql`tr.id < ${cursor}`);
      } else {
        conditions.push(Prisma.sql`tr.id > ${cursor}`);
      }
    }

    // Task filters
    if (filterOptions.tasks && filterOptions.tasks.length > 0) {
      conditions.push(Prisma.sql`tr."taskIdentifier" IN (${Prisma.join(filterOptions.tasks)})`);
    }

    // Version filters
    if (filterOptions.versions && filterOptions.versions.length > 0) {
      conditions.push(Prisma.sql`tr."taskVersion" IN (${Prisma.join(filterOptions.versions)})`);
    }

    // Status filters
    if (filterOptions.statuses && filterOptions.statuses.length > 0) {
      conditions.push(
        Prisma.sql`tr.status = ANY(ARRAY[${Prisma.join(
          filterOptions.statuses
        )}]::"TaskRunStatus"[])`
      );
    }

    // Tag filters
    if (filterOptions.tags && filterOptions.tags.length > 0) {
      conditions.push(
        Prisma.sql`tr."runTags" && ARRAY[${Prisma.join(filterOptions.tags)}]::text[]`
      );
    }

    // Schedule filter
    if (filterOptions.scheduleId) {
      conditions.push(Prisma.sql`tr."scheduleId" = ${filterOptions.scheduleId}`);
    }

    // Time period filter
    if (filterOptions.period) {
      conditions.push(
        Prisma.sql`tr."createdAt" >= NOW() - INTERVAL '1 millisecond' * ${filterOptions.period}`
      );
    }

    // From date filter
    if (filterOptions.from) {
      conditions.push(
        Prisma.sql`tr."createdAt" >= ${new Date(filterOptions.from).toISOString()}::timestamp`
      );
    }

    // To date filter
    if (filterOptions.to) {
      const toDate = new Date(filterOptions.to);
      const now = new Date();
      const clampedDate = toDate > now ? now : toDate;
      conditions.push(Prisma.sql`tr."createdAt" <= ${clampedDate.toISOString()}::timestamp`);
    }

    // Test filter
    if (typeof filterOptions.isTest === "boolean") {
      conditions.push(Prisma.sql`tr."isTest" = ${filterOptions.isTest}`);
    }

    // Root only filter
    if (filterOptions.rootOnly) {
      conditions.push(Prisma.sql`tr."rootTaskRunId" IS NULL`);
    }

    // Batch filter
    if (filterOptions.batchId) {
      conditions.push(Prisma.sql`tr."batchId" = ${filterOptions.batchId}`);
    }

    // Bulk action filter
    if (filterOptions.bulkId) {
      conditions.push(
        Prisma.sql`tr."bulkActionGroupIds" && ARRAY[${filterOptions.bulkId}]::text[]`
      );
    }

    // Run ID filter
    if (filterOptions.runId && filterOptions.runId.length > 0) {
      const friendlyIds = filterOptions.runId.map((runId) => RunId.toFriendlyId(runId));
      conditions.push(Prisma.sql`tr."friendlyId" IN (${Prisma.join(friendlyIds)})`);
    }

    // Queue filter
    if (filterOptions.queues && filterOptions.queues.length > 0) {
      conditions.push(Prisma.sql`tr."queue" IN (${Prisma.join(filterOptions.queues)})`);
    }

    // Machine preset filter
    if (filterOptions.machines && filterOptions.machines.length > 0) {
      conditions.push(Prisma.sql`tr."machinePreset" IN (${Prisma.join(filterOptions.machines)})`);
    }

    // Combine all conditions with AND
    return conditions.reduce((acc, condition) =>
      acc === null ? condition : Prisma.sql`${acc} AND ${condition}`
    );
  }
}
