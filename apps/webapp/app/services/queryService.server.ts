import {
  executeTSQL,
  QueryError,
  type ClickHouseSettings,
  type ExecuteTSQLOptions,
  type FieldMappings,
  type TSQLQueryResult,
} from "@internal/clickhouse";
import type { CustomerQuerySource } from "@trigger.dev/database";
import type { TableSchema, WhereClauseCondition } from "@internal/tsql";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { clickhouseClient } from "./clickhouseInstance.server";
import {
  queryConcurrencyLimiter,
  DEFAULT_ORG_CONCURRENCY_LIMIT,
  GLOBAL_CONCURRENCY_LIMIT,
} from "./queryConcurrencyLimiter.server";
import { getLimit } from "./platform.v3.server";
import { timeFilters, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import parse from "parse-duration";
import { querySchemas } from "~/v3/querySchemas";

export type { TableSchema, TSQLQueryResult };

export type QueryScope = "organization" | "project" | "environment";

const scopeToEnum = {
  organization: "ORGANIZATION",
  project: "PROJECT",
  environment: "ENVIRONMENT",
} as const;

/**
 * Default ClickHouse settings for query protection
 * Based on PostHog's HogQL settings to prevent expensive queries
 */
function getDefaultClickhouseSettings(): ClickHouseSettings {
  return {
    // Query execution limits
    max_execution_time: env.QUERY_CLICKHOUSE_MAX_EXECUTION_TIME,
    timeout_overflow_mode: "throw",
    max_memory_usage: String(env.QUERY_CLICKHOUSE_MAX_MEMORY_USAGE),

    // AST complexity limits to prevent extremely complex queries
    max_ast_elements: String(env.QUERY_CLICKHOUSE_MAX_AST_ELEMENTS),
    max_expanded_ast_elements: String(env.QUERY_CLICKHOUSE_MAX_EXPANDED_AST_ELEMENTS),

    // Memory management for GROUP BY operations
    max_bytes_before_external_group_by: String(
      env.QUERY_CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY
    ),

    // Safety settings
    format_csv_allow_double_quotes: 0,
    readonly: "1", // Ensure queries are read-only
  };
}

export type ExecuteQueryOptions<TOut extends z.ZodSchema> = Omit<
  ExecuteTSQLOptions<TOut>,
  "tableSchema" | "fieldMappings" | "enforcedWhereClause" | "whereClauseFallback" | "schema"
> & {
  organizationId: string;
  projectId: string;
  environmentId: string;
  /** The scope of the query - determines tenant isolation */
  scope: QueryScope;
  period?: string | null;
  from?: string | null;
  to?: string | null;
  /** Filter to specific task identifiers */
  taskIdentifiers?: string[];
  /** Filter to specific queues */
  queues?: string[];
  /** History options for saving query to billing/audit */
  history?: {
    /** Where the query originated from */
    source: CustomerQuerySource;
    /** User ID (optional, null for API calls) */
    userId?: string | null;
    /** Skip saving to history (e.g., when impersonating) */
    skip?: boolean;
  };
  /** Custom per-org concurrency limit (overrides default) */
  customOrgConcurrencyLimit?: number;
};

/**
 * Extended result type that includes the optional queryId when saved to history
 */
export type ExecuteQueryResult<T> =
  | {
      success: true;
      result: T;
      queryId: string | null;
      periodClipped: number | null;
      maxQueryPeriod: number;
    }
  | { success: false; error: Error };

export async function getDefaultPeriod(organizationId: string): Promise<string> {
  const idealDefaultPeriodDays = 7;
  const maxQueryPeriod = await getLimit(organizationId, "queryPeriodDays", 30);
  if (maxQueryPeriod < idealDefaultPeriodDays) {
    return `${maxQueryPeriod}d`;
  }
  return `${idealDefaultPeriodDays}d`;
}

/**
 * Execute a TSQL query against ClickHouse with tenant isolation
 * Handles building tenant options, field mappings, and optionally saves to history
 * Returns [error, result, queryId] where queryId is the CustomerQuery ID if saved to history
 */
export async function executeQuery<TOut extends z.ZodSchema>(
  options: ExecuteQueryOptions<TOut>
): Promise<ExecuteQueryResult<Exclude<TSQLQueryResult<z.output<TOut>>[1], null>>> {
  const {
    period,
    from,
    to,
    scope,
    organizationId,
    projectId,
    environmentId,
    taskIdentifiers,
    queues,
    history,
    customOrgConcurrencyLimit,
    ...baseOptions
  } = options;

  // Generate unique request ID for concurrency tracking
  const requestId = crypto.randomUUID();
  const orgLimit = customOrgConcurrencyLimit ?? DEFAULT_ORG_CONCURRENCY_LIMIT;

  // Acquire concurrency slot
  const acquireResult = await queryConcurrencyLimiter.acquire({
    key: organizationId,
    requestId,
    keyLimit: orgLimit,
    globalLimit: GLOBAL_CONCURRENCY_LIMIT,
  });

  if (!acquireResult.success) {
    const errorMessage =
      acquireResult.reason === "key_limit"
        ? `You've exceeded your query concurrency of ${orgLimit} for this organization. Please try again later.`
        : "We're experiencing a lot of queries at the moment. Please try again later.";
    return { success: false, error: new QueryError(errorMessage, { query: options.query }) };
  }

  // Build time filter fallback for triggered_at column
  const defaultPeriod = await getDefaultPeriod(organizationId);
  const timeFilter = timeFilters({
    period: period ?? undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    defaultPeriod,
  });

  // Calculate the effective "from" date the user is requesting (for period clipping check)
  // This is null only when the user specifies just a "to" date (rare case)
  let requestedFromDate: Date | null = null;
  if (timeFilter.from) {
    requestedFromDate = new Date(timeFilter.from);
  } else if (!timeFilter.to) {
    // Period specified (or default) - calculate from now
    const periodMs = parse(timeFilter.period ?? defaultPeriod) ?? 7 * 24 * 60 * 60 * 1000;
    requestedFromDate = new Date(Date.now() - periodMs);
  }

  // Build the fallback WHERE condition based on what the user specified
  let triggeredAtFallback: WhereClauseCondition;
  if (timeFilter.from && timeFilter.to) {
    triggeredAtFallback = { op: "between", low: timeFilter.from, high: timeFilter.to };
  } else if (timeFilter.from) {
    triggeredAtFallback = { op: "gte", value: timeFilter.from };
  } else if (timeFilter.to) {
    triggeredAtFallback = { op: "lte", value: timeFilter.to };
  } else {
    triggeredAtFallback = { op: "gte", value: requestedFromDate! };
  }

  const maxQueryPeriod = await getLimit(organizationId, "queryPeriodDays", 30);
  const maxQueryPeriodDate = new Date(Date.now() - maxQueryPeriod * 24 * 60 * 60 * 1000);

  // Check if the requested time period exceeds the plan limit
  const periodClipped = requestedFromDate !== null && requestedFromDate < maxQueryPeriodDate;

  // Force tenant isolation and time period limits
  const enforcedWhereClause = {
    organization_id: { op: "eq", value: organizationId },
    project_id:
      scope === "project" || scope === "environment" ? { op: "eq", value: projectId } : undefined,
    environment_id: scope === "environment" ? { op: "eq", value: environmentId } : undefined,
    triggered_at: { op: "gte", value: maxQueryPeriodDate },
    // Optional filters for tasks and queues
    task_identifier:
      taskIdentifiers && taskIdentifiers.length > 0
        ? { op: "in", values: taskIdentifiers }
        : undefined,
    queue: queues && queues.length > 0 ? { op: "in", values: queues } : undefined,
  } satisfies Record<string, WhereClauseCondition | undefined>;

  // Compute the effective time range for timeBucket() interval calculation
  const timeRange = timeFilterFromTo({
    period: period ?? undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    defaultPeriod,
  });

  try {
    // Build field mappings for project_ref → project_id and environment_id → slug translation
    const projects = await prisma.project.findMany({
      where: { organizationId },
      select: { id: true, externalRef: true },
    });

    const environments = await prisma.runtimeEnvironment.findMany({
      where: { project: { organizationId } },
      select: { id: true, slug: true },
    });

    const fieldMappings: FieldMappings = {
      project: Object.fromEntries(projects.map((p) => [p.id, p.externalRef])),
      environment: Object.fromEntries(environments.map((e) => [e.id, e.slug])),
    };

    const result = await executeTSQL(clickhouseClient.reader, {
      ...baseOptions,
      schema: z.record(z.any()),
      tableSchema: querySchemas,
      transformValues: true,
      enforcedWhereClause,
      fieldMappings,
      whereClauseFallback: {
        triggered_at: triggeredAtFallback,
      },
      timeRange,
      clickhouseSettings: {
        ...getDefaultClickhouseSettings(),
        ...baseOptions.clickhouseSettings, // Allow caller overrides if needed
      },
      querySettings: {
        maxRows: env.QUERY_CLICKHOUSE_MAX_RETURNED_ROWS,
        ...baseOptions.querySettings, // Allow caller overrides if needed
      },
    });

    // If query failed, return early with no queryId
    if (result[0] !== null) {
      return { success: false, error: result[0] };
    }

    let queryId: string | null = null;

    // If query succeeded and history options provided, save to history
    // Skip history for EXPLAIN queries (admin debugging) and when explicitly skipped (e.g., impersonating)
    if (history && !history.skip && !baseOptions.explain) {
      // Check if this query is the same as the last one saved (avoid duplicate history entries)
      const lastQuery = await prisma.customerQuery.findFirst({
        where: {
          organizationId,
          source: history.source,
          userId: history.userId ?? null,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          query: true,
          scope: true,
          filterPeriod: true,
          filterFrom: true,
          filterTo: true,
        },
      });

      // Save the effective period used for the query (timeFilters() handles defaults)
      // Only save period if no custom from/to range was specified
      const historyTimeFilter = {
        period: timeFilter.from || timeFilter.to ? undefined : timeFilter.period,
        from: timeFilter.from,
        to: timeFilter.to,
      };
      const isDuplicate =
        lastQuery &&
        lastQuery.query === options.query &&
        lastQuery.scope === scopeToEnum[scope] &&
        lastQuery.filterPeriod === (timeFilter?.period ?? null) &&
        lastQuery.filterFrom?.getTime() === (timeFilter?.from?.getTime() ?? undefined) &&
        lastQuery.filterTo?.getTime() === (timeFilter?.to?.getTime() ?? undefined);

      if (isDuplicate && lastQuery) {
        // Return the existing query's ID for duplicate queries
        queryId = lastQuery.id;
      } else {
        const created = await prisma.customerQuery.create({
          data: {
            query: options.query,
            scope: scopeToEnum[scope],
            stats: { ...result[1].stats },
            source: history.source,
            organizationId,
            projectId: scope === "project" || scope === "environment" ? projectId : null,
            environmentId: scope === "environment" ? environmentId : null,
            userId: history.userId ?? null,
            filterPeriod: historyTimeFilter?.period ?? null,
            filterFrom: historyTimeFilter?.from ?? null,
            filterTo: historyTimeFilter?.to ?? null,
          },
        });
        queryId = created.id;
      }
    }

    return {
      success: true,
      result: result[1],
      queryId,
      periodClipped: periodClipped ? maxQueryPeriod : null,
      maxQueryPeriod,
    };
  } finally {
    // Always release the concurrency slot
    await queryConcurrencyLimiter.release({
      key: organizationId,
      requestId,
    });
  }
}
