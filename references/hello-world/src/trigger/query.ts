import { logger, query, task } from "@trigger.dev/sdk";

// Simple query example - just the query string, all defaults
export const simpleQueryTask = task({
  id: "simple-query",
  run: async () => {
    logger.info("Running simple query example");

    // Simplest usage - uses environment scope, json format, default period
    const result = await query.execute("SELECT * FROM runs LIMIT 10");

    logger.info("Query results", {
      rowCount: result.rows.length,
      firstRow: result.rows[0],
    });

    // Log all rows
    result.rows.forEach((row, index) => {
      logger.info(`Row ${index + 1}`, { row });
    });

    return {
      totalRows: result.rows.length,
      rows: result.rows,
    };
  },
});

// JSON query with all options
export const fullJsonQueryTask = task({
  id: "full-json-query",
  run: async () => {
    logger.info("Running full JSON query example with all options");

    // All options specified
    const result = await query.execute(
      `SELECT
        status,
        COUNT(*) as count,
        AVG(duration) as avg_duration
      FROM runs
      WHERE status IN ('COMPLETED', 'FAILED')
      GROUP BY status`,
      {
        scope: "environment", // Query current environment only
        period: "30d", // Last 30 days of data
        format: "json", // JSON format (default)
      }
    );

    logger.info("Query completed", {
      rowCount: result.rows.length,
    });

    // Log the aggregated results
    result.rows.forEach((row) => {
      logger.info("Status breakdown", {
        status: row.status,
        count: row.count,
        averageDuration: row.avg_duration,
      });
    });

    return {
      summary: result.rows,
    };
  },
});

// CSV export example
export const csvQueryTask = task({
  id: "csv-query",
  run: async () => {
    logger.info("Running CSV query example");

    // Query with CSV format - returns a string
    const csvData = await query.execute(
      "SELECT id, status, created_at, duration FROM runs LIMIT 100",
      {
        scope: "project", // Query all environments in the project
        period: "7d", // Last 7 days
        format: "csv", // CSV format
      }
    );

    logger.info("CSV query completed", {
      dataLength: csvData.length,
      preview: csvData.substring(0, 200), // Show first 200 chars
    });

    // Count the number of rows (lines - 1 for header)
    const lines = csvData.split("\n");
    const rowCount = lines.length - 1;

    logger.info("CSV stats", {
      totalRows: rowCount,
      headerLine: lines[0],
    });

    return {
      csv: csvData,
      rowCount,
    };
  },
});

// Organization-wide query with date range
export const orgQueryTask = task({
  id: "org-query",
  run: async () => {
    logger.info("Running organization-wide query");

    const result = await query.execute(
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
        format: "json",
      }
    );

    logger.info("Organization query completed", {
      projectCount: result.rows.length,
    });

    result.rows.forEach((row) => {
      logger.info("Project stats", {
        project: row.project,
        environment: row.environment,
        totalRuns: row.total_runs,
        successRate: `${((row.successful_runs / row.total_runs) * 100).toFixed(2)}%`,
      });
    });

    return {
      projects: result.rows,
    };
  },
});
