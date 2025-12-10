import type { QueryParams } from "@internal/clickhouse/client/queryBuilder.js";

/**
 * Configuration object that represents a parsed TSQL query
 * This can be used to build a ClickhouseQueryBuilder
 * The structure matches ClickhouseQueryBuilder's API
 */
export interface QueryConfig {
  /**
   * The base SELECT query without WHERE, GROUP BY, ORDER BY, LIMIT clauses
   * Example: "SELECT id, name FROM users"
   */
  baseQuery: string;

  /**
   * WHERE clause conditions
   * Each entry represents a call to queryBuilder.where(clause, params)
   * The clauses will be joined with AND by the query builder
   */
  whereClauses: Array<{
    clause: string;
    params?: QueryParams;
  }>;

  /**
   * GROUP BY clause string
   * Will be passed to queryBuilder.groupBy()
   */
  groupBy?: string;

  /**
   * ORDER BY clause string
   * Will be passed to queryBuilder.orderBy()
   */
  orderBy?: string;

  /**
   * LIMIT value
   * Will be passed to queryBuilder.limit()
   */
  limit?: number;
}
