import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

export interface QueryPerformanceConfig {
  verySlowQueryThreshold?: number; // ms
  maxQueryLogLength: number;
}

export class QueryPerformanceMonitor {
  private config: QueryPerformanceConfig;

  constructor(config: Partial<QueryPerformanceConfig> = {}) {
    this.config = {
      maxQueryLogLength: 1000,
      ...config,
    };
  }

  onQuery(
    clientType: "writer" | "replica",
    log: {
      duration: number;
      query: string;
      params: string;
      target: string;
      timestamp: Date;
    }
  ) {
    if (this.config.verySlowQueryThreshold === undefined) {
      return;
    }

    const { duration, query, params, target, timestamp } = log;

    // Only log very slow queries as errors
    if (duration > this.config.verySlowQueryThreshold) {
      // Truncate long queries for readability
      const truncatedQuery =
        query.length > this.config.maxQueryLogLength
          ? query.substring(0, this.config.maxQueryLogLength) + "..."
          : query;

      logger.error("Prisma: very slow database query", {
        clientType,
        durationMs: duration,
        query: truncatedQuery,
        target,
        timestamp,
        paramCount: this.countParams(query),
        hasParams: params !== "[]" && params !== "",
      });
    }
  }

  private countParams(query: string): number {
    // Count the number of $1, $2, etc. parameters in the query
    const paramMatches = query.match(/\$\d+/g);
    return paramMatches ? paramMatches.length : 0;
  }
}

export const queryPerformanceMonitor = new QueryPerformanceMonitor({
  verySlowQueryThreshold: env.VERY_SLOW_QUERY_THRESHOLD_MS,
});
