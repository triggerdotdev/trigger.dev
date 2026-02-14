import { logger, query, task } from "@trigger.dev/sdk";

// Type definition for a run row
type RunRow = {
  run_id: string;
  status: string;
  triggered_at: string;
  total_duration: number;
};

// Simple query example - just the query string, all defaults
export const simpleQueryTask = task({
  id: "simple-query",
  run: async () => {
    logger.info("Running simple query example");

    // Simplest usage - uses environment scope, json format, default period
    const result = await query.execute("SELECT * FROM runs LIMIT 10");

    logger.info("Query results (untyped)", {
      format: result.format,
      rowCount: result.results.length,
      firstRow: result.results[0],
    });

    // Type-safe query with explicit row type
    const typedResult = await query.execute<RunRow>(
      "SELECT run_id, status, triggered_at, total_duration FROM runs LIMIT 10"
    );

    logger.info("Query results (typed)", {
      format: typedResult.format,
      rowCount: typedResult.results.length,
      firstRow: typedResult.results[0],
    });

    // Now we have full type safety on the rows!
    typedResult.results.forEach((row, index) => {
      logger.info(`Run ${index + 1}`, {
        run_id: row.run_id, // TypeScript knows this is a string
        status: row.status, // TypeScript knows this is a string
        total_duration: row.total_duration, // TypeScript knows this is a number
      });
    });

    return {
      totalRows: typedResult.results.length,
      rows: typedResult.results,
    };
  },
});

// JSON query with all options and inline type
export const fullJsonQueryTask = task({
  id: "full-json-query",
  run: async () => {
    logger.info("Running full JSON query example with all options");

    // All options specified with inline type for aggregation
    const result = await query.execute<{
      status: string;
      count: number;
      avg_duration: number;
    }>(
      `SELECT
        status,
        COUNT(*) as count,
        AVG(total_duration) as avg_duration
      FROM runs
      WHERE status IN ('COMPLETED', 'FAILED')
      GROUP BY status`,
      {
        scope: "environment", // Query current environment only
        period: "30d", // Last 30 days of data
        // format defaults to "json"
      }
    );

    logger.info("Query completed", {
      format: result.format,
      rowCount: result.results.length,
    });

    // Log the aggregated results - now fully type-safe!
    result.results.forEach((row) => {
      logger.info("Status breakdown", {
        status: row.status, // string
        count: row.count, // number
        averageDuration: row.avg_duration, // number
      });
    });

    return {
      summary: result.results,
    };
  },
});

// CSV export example
export const csvQueryTask = task({
  id: "csv-query",
  run: async () => {
    logger.info("Running CSV query example");

    // Query with CSV format - automatically typed as discriminated union!
    const result = await query.execute(
      "SELECT run_id, status, triggered_at, total_duration FROM runs LIMIT 10",
      {
        scope: "project", // Query all environments in the project
        period: "7d", // Last 7 days
        format: "csv", // CSV format
      }
    );

    // result.format is "csv" and result.results is automatically typed as string!
    logger.info("CSV query completed", {
      format: result.format,
      dataLength: result.results.length,
      results: result.results,
    });

    return {
      format: result.format,
      csv: result.results,
    };
  },
});

// Organization-wide query with date range and type safety
export const orgQueryTask = task({
  id: "org-query",
  run: async () => {
    logger.info("Running organization-wide query");

    // Define the shape of our aggregated results
    type ProjectStats = {
      project: string;
      environment: string;
      total_runs: number;
      successful_runs: number;
      failed_runs: number;
    };

    const result = await query.execute<ProjectStats>(
      `SELECT
        project,
        environment,
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as successful_runs,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed_runs
      FROM runs
      GROUP BY project, environment
      ORDER BY total_runs DESC`,
      {
        scope: "organization", // Query across all projects
        from: "2025-02-01T00:00:00Z", // Custom date range
        to: "2025-02-11T23:59:59Z",
        // format defaults to "json"
      }
    );

    logger.info("Organization query completed", {
      format: result.format,
      projectCount: result.results.length,
    });

    // Full type safety on aggregated results
    result.results.forEach((row) => {
      const successRate = (row.successful_runs / row.total_runs) * 100;

      logger.info("Project stats", {
        project: row.project,
        environment: row.environment,
        totalRuns: row.total_runs,
        successfulRuns: row.successful_runs,
        failedRuns: row.failed_runs,
        successRate: `${successRate.toFixed(2)}%`,
      });
    });

    return {
      projects: result.results,
    };
  },
});
