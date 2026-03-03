import { z } from "zod";
import {
  type ClickHouse,
  type TimeGranularity,
  detectTimeGranularity,
  granularityToInterval,
  granularityToStepMs,
} from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "~/presenters/v3/basePresenter.server";

export type ErrorGroupOptions = {
  userId?: string;
  projectId: string;
  fingerprint: string;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

export const ErrorGroupOptionsSchema = z.object({
  userId: z.string().optional(),
  projectId: z.string(),
  fingerprint: z.string(),
  direction: z.enum(["forward", "backward"]).optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
});

const DEFAULT_PAGE_SIZE = 50;

export type ErrorGroupDetail = Awaited<ReturnType<ErrorGroupPresenter["call"]>>;
export type ErrorInstance = ErrorGroupDetail["instances"][0];

// Cursor for error instances pagination
type ErrorInstanceCursor = {
  createdAt: string;
  runId: string;
};

const ErrorInstanceCursorSchema = z.object({
  createdAt: z.string(),
  runId: z.string(),
});

function encodeCursor(cursor: ErrorInstanceCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): ErrorInstanceCursor | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    const validated = ErrorInstanceCursorSchema.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data as ErrorInstanceCursor;
  } catch {
    return null;
  }
}

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
  stackTrace?: string;
  taskIdentifier: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
};

export type ErrorGroupOccurrences = Awaited<ReturnType<ErrorGroupPresenter["getOccurrences"]>>;
export type ErrorGroupActivity = ErrorGroupOccurrences["data"];

export class ErrorGroupPresenter extends BasePresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {
    super(undefined, replica);
  }

  public async call(
    organizationId: string,
    environmentId: string,
    { userId, projectId, fingerprint, cursor, pageSize = DEFAULT_PAGE_SIZE }: ErrorGroupOptions
  ) {
    const displayableEnvironment = await findDisplayableEnvironment(environmentId, userId);

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    // Run summary (aggregated) and instances queries in parallel
    const [summary, instancesResult] = await Promise.all([
      this.getSummary(organizationId, projectId, environmentId, fingerprint),
      this.getInstances(organizationId, projectId, environmentId, fingerprint, cursor, pageSize),
    ]);

    // Get stack trace from the most recent instance
    let stackTrace: string | undefined;
    if (instancesResult.instances.length > 0) {
      const firstInstance = instancesResult.instances[0];
      try {
        const errorData = JSON.parse(firstInstance.error_text) as Record<string, unknown>;
        stackTrace = (errorData.stack || errorData.stacktrace) as string | undefined;
      } catch {
        // no stack trace available
      }
    }

    // Build error group combining aggregated summary with instance stack trace
    let errorGroup: ErrorGroupSummary | undefined;
    if (summary) {
      errorGroup = {
        ...summary,
        stackTrace,
      };
    }

    // Transform instances
    const transformedInstances = instancesResult.instances.map((instance) => {
      let parsedError: any;
      try {
        parsedError = JSON.parse(instance.error_text);
      } catch {
        parsedError = { message: instance.error_text };
      }

      return {
        runId: instance.run_id,
        friendlyId: instance.friendly_id,
        taskIdentifier: instance.task_identifier,
        createdAt: new Date(parseInt(instance.created_at) * 1000),
        status: instance.status,
        error: parsedError,
        traceId: instance.trace_id,
        taskVersion: instance.task_version,
      };
    });

    return {
      errorGroup,
      instances: transformedInstances,
      runFriendlyIds: transformedInstances.map((i) => i.friendlyId),
      pagination: instancesResult.pagination,
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
    granularity: TimeGranularity;
    data: Array<{ date: Date; count: number }>;
  }> {
    const granularity = detectTimeGranularity(from, to);
    const intervalExpr = granularityToInterval(granularity);
    const stepMs = granularityToStepMs(granularity);

    const queryBuilder = this.clickhouse.errors.createOccurrencesQueryBuilder(intervalExpr);

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
    const startEpoch = Math.floor(from.getTime() / stepMs) * (stepMs / 1000);
    const endEpoch = Math.ceil(to.getTime() / 1000);
    for (let epoch = startEpoch; epoch <= endEpoch; epoch += stepMs / 1000) {
      buckets.push(epoch);
    }

    const byBucket = new Map<number, number>();
    for (const row of records ?? []) {
      byBucket.set(row.bucket_epoch, (byBucket.get(row.bucket_epoch) ?? 0) + row.count);
    }

    return {
      granularity,
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
  ): Promise<Omit<ErrorGroupSummary, "stackTrace"> | undefined> {
    const queryBuilder = this.clickhouse.errors.listQueryBuilder();

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
    };
  }

  private async getInstances(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprint: string,
    cursor: string | undefined,
    pageSize: number
  ) {
    const queryBuilder = this.clickhouse.errors.instancesQueryBuilder();

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint = {errorFingerprint: String}", {
      errorFingerprint: fingerprint,
    });
    queryBuilder.where("_is_deleted = 0");

    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      queryBuilder.where(
        `(created_at < {cursorCreatedAt: String} OR (created_at = {cursorCreatedAt: String} AND run_id < {cursorRunId: String}))`,
        {
          cursorCreatedAt: decodedCursor.createdAt,
          cursorRunId: decodedCursor.runId,
        }
      );
    }

    queryBuilder.orderBy("created_at DESC, run_id DESC");
    queryBuilder.limit(pageSize + 1);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    const results = records || [];
    const hasMore = results.length > pageSize;
    const instances = results.slice(0, pageSize);

    let nextCursor: string | undefined;
    if (hasMore && instances.length > 0) {
      const lastInstance = instances[instances.length - 1];
      nextCursor = encodeCursor({
        createdAt: lastInstance.created_at,
        runId: lastInstance.run_id,
      });
    }

    return {
      instances,
      pagination: {
        hasMore,
        nextCursor,
      },
    };
  }
}
