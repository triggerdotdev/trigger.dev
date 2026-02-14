import { logger, query, task } from "@trigger.dev/sdk";
import type { QueryTable } from "@trigger.dev/sdk";

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

    // Type-safe query using QueryTable with specific columns
    const typedResult = await query.execute<
      QueryTable<"runs", "run_id" | "status" | "triggered_at" | "total_duration">
    >("SELECT run_id, status, triggered_at, total_duration FROM runs LIMIT 10");

    logger.info("Query results (typed)", {
      format: typedResult.format,
      rowCount: typedResult.results.length,
      firstRow: typedResult.results[0],
    });

    // Full type safety on the rows - status is narrowly typed!
    typedResult.results.forEach((row, index) => {
      logger.info(`Run ${index + 1}`, {
        run_id: row.run_id, // string
        status: row.status, // RunFriendlyStatus ("Completed" | "Failed" | ...)
        total_duration: row.total_duration, // number | null
      });
    });

    return {
      totalRows: typedResult.results.length,
      rows: typedResult.results,
    };
  },
});

// JSON query with all options - aggregation queries use inline types
export const fullJsonQueryTask = task({
  id: "full-json-query",
  run: async () => {
    logger.info("Running full JSON query example with all options");

    // For aggregation queries, use inline types since the result shape
    // doesn't match a table row. For non-aggregated queries, use QueryTable.
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
      WHERE status IN ('Completed', 'Failed')
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

// Organization-wide query with QueryTable for full row access
export const orgQueryTask = task({
  id: "org-query",
  run: async () => {
    logger.info("Running organization-wide query");

    // Use QueryTable to get typed rows for specific columns
    const result = await query.execute<
      QueryTable<"runs", "run_id" | "project" | "environment" | "status" | "task_identifier" | "machine">
    >(
      `SELECT run_id, project, environment, status, task_identifier, machine
      FROM runs
      ORDER BY triggered_at DESC
      LIMIT 50`,
      {
        scope: "organization", // Query across all projects
        from: "2025-02-01T00:00:00Z", // Custom date range
        to: "2025-02-11T23:59:59Z",
      }
    );

    logger.info("Organization query completed", {
      format: result.format,
      runCount: result.results.length,
    });

    // Fully typed - status is RunFriendlyStatus, machine is MachinePresetName
    result.results.forEach((row) => {
      logger.info("Run info", {
        runId: row.run_id, // string
        project: row.project, // string
        environment: row.environment, // string
        status: row.status, // "Completed" | "Failed" | "Executing" | ...
        task: row.task_identifier, // string
        machine: row.machine, // "micro" | "small-1x" | "small-2x" | ...
      });
    });

    return {
      runs: result.results,
    };
  },
});
