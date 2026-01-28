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
import { type z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { clickhouseClient } from "./clickhouseInstance.server";
import {
  queryConcurrencyLimiter,
  DEFAULT_ORG_CONCURRENCY_LIMIT,
  GLOBAL_CONCURRENCY_LIMIT,
} from "./queryConcurrencyLimiter.server";

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
  "tableSchema" | "fieldMappings"
> & {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  tableSchema: TableSchema[];
  /** The scope of the query - determines tenant isolation */
  scope: QueryScope;
  /** History options for saving query to billing/audit */
  history?: {
    /** Where the query originated from */
    source: CustomerQuerySource;
    /** User ID (optional, null for API calls) */
    userId?: string | null;
    /** Skip saving to history (e.g., when impersonating) */
    skip?: boolean;
    /** Time filter settings to save with the query */
    timeFilter?: {
      /** Period like "7d", "24h", etc. */
      period?: string;
      /** Custom start date */
      from?: Date;
      /** Custom end date */
      to?: Date;
    };
  };
  /** Custom per-org concurrency limit (overrides default) */
  customOrgConcurrencyLimit?: number;
};

/**
 * Extended result type that includes the optional queryId when saved to history
 */
export type ExecuteQueryResult<T> =
  | [error: Error, result: null, queryId: null]
  | [error: null, result: T, queryId: string | null];

/**
 * Execute a TSQL query against ClickHouse with tenant isolation
 * Handles building tenant options, field mappings, and optionally saves to history
 * Returns [error, result, queryId] where queryId is the CustomerQuery ID if saved to history
 */
export async function executeQuery<TOut extends z.ZodSchema>(
  options: ExecuteQueryOptions<TOut>
): Promise<ExecuteQueryResult<Exclude<TSQLQueryResult<z.output<TOut>>[1], null>>> {
  const {
    scope,
    organizationId,
    projectId,
    environmentId,
    enforcedWhereClause,
    history,
    customOrgConcurrencyLimit,
    whereClauseFallback,
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
      return [new QueryError(errorMessage, { query: options.query }), null, null];
    }

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
      enforcedWhereClause,
      fieldMappings,
      whereClauseFallback,
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
      return [result[0], null, null];
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
        select: { id: true, query: true, scope: true, filterPeriod: true, filterFrom: true, filterTo: true },
      });

      const timeFilter = history.timeFilter;
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
            filterPeriod: history.timeFilter?.period ?? null,
            filterFrom: history.timeFilter?.from ?? null,
            filterTo: history.timeFilter?.to ?? null,
          },
        });
        queryId = created.id;
      }
    }

    return [null, result[1], queryId];
  } finally {
    // Always release the concurrency slot
    await queryConcurrencyLimiter.release({
      key: organizationId,
      requestId,
    });
  }
}
