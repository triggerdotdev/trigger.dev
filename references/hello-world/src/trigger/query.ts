import { logger, query, task } from "@trigger.dev/sdk";
import type { QueryTable } from "@trigger.dev/sdk";

// Simple query example - tests different from/to formats
export const simpleQueryTask = task({
  id: "simple-query",
  run: async () => {
    logger.info("Running simple query example");

    // 1. Default: no from/to, uses default period
    const defaultResult = await query.execute("SELECT * FROM runs LIMIT 5");
    logger.info("Default (no from/to)", {
      rowCount: defaultResult.results.length,
      firstRow: defaultResult.results[0],
    });

    // 2. Using Date objects for from/to
    const withDates = await query.execute<
      QueryTable<"runs", "run_id" | "status" | "triggered_at">
    >("SELECT run_id, status, triggered_at FROM runs LIMIT 5", {
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date(),
    });
    logger.info("With Date objects", {
      rowCount: withDates.results.length,
      firstRow: withDates.results[0],
    });

    // 3. Using Unix timestamps in milliseconds (Date.now() returns ms)
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const withTimestamps = await query.execute<
      QueryTable<"runs", "run_id" | "status" | "triggered_at">
    >("SELECT run_id, status, triggered_at FROM runs LIMIT 5", {
      from: sevenDaysAgo,
      to: now,
    });
    logger.info("With Unix timestamps (ms)", {
      rowCount: withTimestamps.results.length,
      firstRow: withTimestamps.results[0],
    });

    // 4. Mixing Date and number
    const mixed = await query.execute<
      QueryTable<"runs", "run_id" | "status" | "triggered_at">
    >("SELECT run_id, status, triggered_at FROM runs LIMIT 5", {
      from: new Date("2025-01-01"),
      to: Date.now(),
    });
    logger.info("Mixed Date + timestamp", {
      rowCount: mixed.results.length,
      firstRow: mixed.results[0],
    });

    return {
      defaultRows: defaultResult.results.length,
      dateRows: withDates.results.length,
      timestampRows: withTimestamps.results.length,
      mixedRows: mixed.results.length,
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
        from: new Date("2025-02-01T00:00:00Z"), // Custom date range
        to: new Date("2025-02-11T23:59:59Z"),
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
