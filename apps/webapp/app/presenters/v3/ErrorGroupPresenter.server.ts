import { z } from "zod";
import { type ClickHouse, msToClickHouseInterval } from "@internal/clickhouse";
import { TimeGranularity } from "~/utils/timeGranularity";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { type Direction, DirectionSchema } from "~/components/ListPagination";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "~/presenters/v3/basePresenter.server";
import {
  NextRunListPresenter,
  type NextRunList,
} from "~/presenters/v3/NextRunListPresenter.server";
import { sortVersionsDescending } from "~/utils/semver";

const errorGroupGranularity = new TimeGranularity([
  { max: "1h", granularity: "1m" },
  { max: "1d", granularity: "20m" },
  { max: "1w", granularity: "2h" },
  { max: "31d", granularity: "12h" },
  { max: "60d", granularity: "1w" },
  { max: "Infinity", granularity: "30d" },
]);

export type ErrorGroupOptions = {
  userId?: string;
  projectId: string;
  fingerprint: string;
  runsPageSize?: number;
  period?: string;
  from?: number;
  to?: number;
  cursor?: string;
  direction?: Direction;
};

export const ErrorGroupOptionsSchema = z.object({
  userId: z.string().optional(),
  projectId: z.string(),
  fingerprint: z.string(),
  runsPageSize: z.number().int().positive().max(1000).optional(),
  period: z.string().optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  cursor: z.string().optional(),
  direction: DirectionSchema.optional(),
});

const DEFAULT_RUNS_PAGE_SIZE = 25;

export type ErrorGroupDetail = Awaited<ReturnType<ErrorGroupPresenter["call"]>>;

function parseClickHouseDateTime(value: string): Date {
  const asNum = Number(value);
  if (!isNaN(asNum) && asNum > 1e12) {
    return new Date(asNum);
  }
  return new Date(value.replace(" ", "T") + "Z");
}

export type ErrorGroupSummary = {
  fingerprint: string;
  errorType: string;
  errorMessage: string;
  taskIdentifier: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  affectedVersions: string[];
};

export type ErrorGroupOccurrences = Awaited<ReturnType<ErrorGroupPresenter["getOccurrences"]>>;
export type ErrorGroupActivity = ErrorGroupOccurrences["data"];

export class ErrorGroupPresenter extends BasePresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly logsClickhouse: ClickHouse,
    private readonly clickhouse: ClickHouse
  ) {
    super(undefined, replica);
  }

  public async call(
    organizationId: string,
    environmentId: string,
    {
      userId,
      projectId,
      fingerprint,
      runsPageSize = DEFAULT_RUNS_PAGE_SIZE,
      period,
      from,
      to,
      cursor,
      direction,
    }: ErrorGroupOptions
  ) {
    const displayableEnvironment = await findDisplayableEnvironment(environmentId, userId);

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    const time = timeFilterFromTo({
      period,
      from,
      to,
      defaultPeriod: "7d",
    });

    const [summary, affectedVersions, runList] = await Promise.all([
      this.getSummary(organizationId, projectId, environmentId, fingerprint),
      this.getAffectedVersions(organizationId, projectId, environmentId, fingerprint),
      this.getRunList(organizationId, environmentId, {
        userId,
        projectId,
        fingerprint,
        pageSize: runsPageSize,
        from: time.from.getTime(),
        to: time.to.getTime(),
        cursor,
        direction,
      }),
    ]);

    if (summary) {
      summary.affectedVersions = affectedVersions;
    }

    return {
      errorGroup: summary,
      runList,
      filters: {
        from: time.from,
        to: time.to,
      },
    };
  }

  /**
   * Returns bucketed occurrence counts for a single fingerprint over a time range.
   * Granularity is determined automatically from the range span.
   */
  public async getOccurrences(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprint: string,
    from: Date,
    to: Date
  ): Promise<{
    data: Array<{ date: Date; count: number }>;
  }> {
    const granularityMs = errorGroupGranularity.getTimeGranularityMs(from, to);
    const intervalExpr = msToClickHouseInterval(granularityMs);

    const queryBuilder = this.logsClickhouse.errors.createOccurrencesQueryBuilder(intervalExpr);

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
    queryBuilder.where("minute >= toStartOfMinute(fromUnixTimestamp64Milli({fromTimeMs: Int64}))", {
      fromTimeMs: from.getTime(),
    });
    queryBuilder.where("minute <= toStartOfMinute(fromUnixTimestamp64Milli({toTimeMs: Int64}))", {
      toTimeMs: to.getTime(),
    });

    queryBuilder.groupBy("error_fingerprint, bucket_epoch");
    queryBuilder.orderBy("bucket_epoch ASC");

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    // Build time buckets covering the full range
    const buckets: number[] = [];
    const startEpoch = Math.floor(from.getTime() / granularityMs) * (granularityMs / 1000);
    const endEpoch = Math.ceil(to.getTime() / 1000);
    for (let epoch = startEpoch; epoch <= endEpoch; epoch += granularityMs / 1000) {
      buckets.push(epoch);
    }

    const byBucket = new Map<number, number>();
    for (const row of records ?? []) {
      byBucket.set(row.bucket_epoch, (byBucket.get(row.bucket_epoch) ?? 0) + row.count);
    }

    return {
      data: buckets.map((epoch) => ({
        date: new Date(epoch * 1000),
        count: byBucket.get(epoch) ?? 0,
      })),
    };
  }

  private async getSummary(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprint: string
  ): Promise<ErrorGroupSummary | undefined> {
    const queryBuilder = this.logsClickhouse.errors.listQueryBuilder();

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });

    queryBuilder.groupBy("error_fingerprint, task_identifier");
    queryBuilder.limit(1);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    if (!records || records.length === 0) {
      return undefined;
    }

    const record = records[0];
    return {
      fingerprint: record.error_fingerprint,
      errorType: record.error_type,
      errorMessage: record.error_message,
      taskIdentifier: record.task_identifier,
      count: record.occurrence_count,
      firstSeen: parseClickHouseDateTime(record.first_seen),
      lastSeen: parseClickHouseDateTime(record.last_seen),
      affectedVersions: [],
    };
  }

  /**
   * Returns the most recent distinct task_version values for an error fingerprint,
   * sorted by semantic version descending (newest first).
   * Queries error_occurrences_v1 where task_version is part of the ORDER BY key.
   */
  private async getAffectedVersions(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprint: string
  ): Promise<string[]> {
    const queryBuilder = this.logsClickhouse.errors.affectedVersionsQueryBuilder();

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
    queryBuilder.where("task_version != ''");
    queryBuilder.limit(100);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError || !records) {
      return [];
    }

    const versions = records.map((r) => r.task_version).filter((v) => v.length > 0);
    return sortVersionsDescending(versions).slice(0, 5);
  }

  private async getRunList(
    organizationId: string,
    environmentId: string,
    options: {
      userId?: string;
      projectId: string;
      fingerprint: string;
      pageSize: number;
      from?: number;
      to?: number;
      cursor?: string;
      direction?: Direction;
    }
  ): Promise<NextRunList | undefined> {
    const runListPresenter = new NextRunListPresenter(this.replica, this.clickhouse);

    const result = await runListPresenter.call(organizationId, environmentId, {
      userId: options.userId,
      projectId: options.projectId,
      rootOnly: false,
      errorId: ErrorId.toFriendlyId(options.fingerprint),
      pageSize: options.pageSize,
      from: options.from,
      to: options.to,
      cursor: options.cursor,
      direction: options.direction,
    });

    if (result.runs.length === 0) {
      return undefined;
    }

    return result;
  }
}
