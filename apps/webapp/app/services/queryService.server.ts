import {
  executeTSQL,
  QueryError,
  type ClickHouseSettings,
  type ExecuteTSQLOptions,
  type FieldMappings,
  type TSQLQueryResult,
} from "@internal/clickhouse";
import type { CustomerQuerySource } from "@trigger.dev/database";
import type { TableSchema } from "@internal/tsql";
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
  "tableSchema" | "organizationId" | "projectId" | "environmentId" | "fieldMappings"
> & {
  tableSchema: TableSchema[];
  /** The scope of the query - determines tenant isolation */
  scope: QueryScope;
  /** Organization ID (required) */
  organizationId: string;
  /** Project ID (required for project/environment scope) */
  projectId: string;
  /** Environment ID (required for environment scope) */
  environmentId: string;
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
 * Execute a TSQL query against ClickHouse with tenant isolation
 * Handles building tenant options, field mappings, and optionally saves to history
 */
export async function executeQuery<TOut extends z.ZodSchema>(
  options: ExecuteQueryOptions<TOut>
): Promise<TSQLQueryResult<z.output<TOut>>> {
  const {
    scope,
    organizationId,
    projectId,
    environmentId,
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
    return [new QueryError(errorMessage, { query: options.query }), null];
  }

  try {
    // Build tenant IDs based on scope
    const tenantOptions: {
      organizationId: string;
      projectId?: string;
      environmentId?: string;
    } = {
      organizationId,
    };

    if (scope === "project" || scope === "environment") {
      tenantOptions.projectId = projectId;
    }

    if (scope === "environment") {
      tenantOptions.environmentId = environmentId;
    }

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
      ...tenantOptions,
      fieldMappings,
      whereClauseFallback,
      clickhouseSettings: {
        ...getDefaultClickhouseSettings(),
        ...baseOptions.clickhouseSettings, // Allow caller overrides if needed
      },
    });

    // If query succeeded and history options provided, save to history
    // Skip history for EXPLAIN queries (admin debugging) and when explicitly skipped (e.g., impersonating)
    if (result[0] === null && history && !history.skip && !baseOptions.explain) {
      // Check if this query is the same as the last one saved (avoid duplicate history entries)
      const lastQuery = await prisma.customerQuery.findFirst({
        where: {
          organizationId,
          source: history.source,
          userId: history.userId ?? null,
        },
        orderBy: { createdAt: "desc" },
        select: { query: true, scope: true },
      });

      const isDuplicate =
        lastQuery && lastQuery.query === options.query && lastQuery.scope === scopeToEnum[scope];

      if (!isDuplicate) {
        const stats = result[1].stats;
        const byteSeconds = parseFloat(stats.byte_seconds) || 0;
        const costInCents = byteSeconds * env.CENTS_PER_QUERY_BYTE_SECOND;

        await prisma.customerQuery.create({
          data: {
            query: options.query,
            scope: scopeToEnum[scope],
            stats: { ...stats },
            costInCents,
            source: history.source,
            organizationId,
            projectId: scope === "project" || scope === "environment" ? projectId : null,
            environmentId: scope === "environment" ? environmentId : null,
            userId: history.userId ?? null,
          },
        });
      }
    }

    return result;
  } finally {
    // Always release the concurrency slot
    await queryConcurrencyLimiter.release({
      key: organizationId,
      requestId,
    });
  }
}
