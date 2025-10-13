# ClickHouse Metrics System

This document explains how to use the ClickHouse metrics system for querying task run data from the `task_runs_v2` table.

## Overview

The metrics system provides a flexible way to query task run data with time-based aggregations, filtering, and grouping. It extends the existing ClickHouse query builder pattern to make metrics queries easy and type-safe.

## Key Features

- **Time-based aggregations**: Group data by configurable time intervals (seconds, minutes, hours, days)
- **Dynamic rollup types**: Count, sum, average, min, max, and distinct aggregations on any column
- **Multiple metric types**: Predefined count, duration, cost, status, and custom aggregations
- **Flexible filtering**: Filter by organization, project, environment, task identifier, status, and more
- **Grouping support**: Group results by task identifier, status, or other fields
- **Type safety**: Full TypeScript support with Zod schemas
- **Query builder pattern**: Chainable, composable query building

## Basic Usage

### 1. Initialize ClickHouse Client

```typescript
import { ClickHouse } from "@internal/clickhouse";

const clickhouse = ClickHouse.fromEnv();
```

### 2. Get Task Run Count Metrics

```typescript
const countMetrics = clickhouse.metrics.getTaskRunCount();

const query = countMetrics()
  .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
  .where("project_id = {projectId:String}", { projectId: "proj_456" })
  .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
  .where("_is_deleted = 0")
  .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
  })
  .groupBy("task_identifier")
  .orderBy("timestamp ASC");

const [error, result] = await query.execute();
```

### 3. Get Task Run Duration Metrics

```typescript
const durationMetrics = clickhouse.metrics.getTaskRunDuration();

const query = durationMetrics()
  .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
  .where("project_id = {projectId:String}", { projectId: "proj_456" })
  .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
  .where("_is_deleted = 0")
  .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
  })
  .where("usage_duration_ms > 0") // Only completed tasks
  .groupBy("task_identifier")
  .orderBy("timestamp ASC");

const [error, result] = await query.execute();
```

### 4. Get Custom Metrics

```typescript
// Get total cost per task
const costMetrics = clickhouse.metrics.getCustom("cost", "sum", "cost_in_cents");

const query = costMetrics()
  .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
  .where("project_id = {projectId:String}", { projectId: "proj_456" })
  .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
  .where("_is_deleted = 0")
  .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
    startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
  })
  .where("cost_in_cents > 0")
  .groupBy("task_identifier")
  .orderBy("timestamp ASC");

const [error, result] = await query.execute();
```

## Available Metric Types

### 1. Count Metrics

- **Function**: `clickhouse.metrics.getTaskRunCount()`
- **Aggregation**: `count()`
- **Use case**: Track number of task runs over time

### 2. Duration Metrics

- **Function**: `clickhouse.metrics.getTaskRunDuration()`
- **Aggregation**: `avg(usage_duration_ms)`
- **Use case**: Track average execution time

### 3. Cost Metrics

- **Function**: `clickhouse.metrics.getTaskRunCost()`
- **Aggregation**: `sum(cost_in_cents)`
- **Use case**: Track total cost per task

### 4. Status Metrics

- **Function**: `clickhouse.metrics.getTaskRunStatus()`
- **Aggregation**: `count()` grouped by status
- **Use case**: Track success/failure rates

### 5. Custom Metrics

- **Function**: `clickhouse.metrics.getCustom(name, aggregation, column)`
- **Aggregations**: `count`, `sum`, `avg`, `min`, `max`
- **Use case**: Custom business metrics

### 6. Dynamic Metrics (NEW)

- **Function**: `clickhouse.metrics.getDynamic(granularity, rollupType, column)`
- **Rollup Types**: `count`, `sum`, `avg`, `min`, `max`, `distinct`
- **Use case**: Completely flexible metrics with any aggregation on any column

## Dynamic Rollup Queries (NEW)

The dynamic metrics system allows you to specify the rollup type and aggregation directly in the query parameters. This provides maximum flexibility for creating custom metrics.

### Basic Dynamic Query

```typescript
// Count distinct task identifiers per hour
const distinctQuery = clickhouse.metrics.getDynamic(
  "1h", // granularity
  "distinct", // rollup type
  "task_identifier", // column
  {
    max_execution_time: 30, // Optional ClickHouse settings
  }
);

const query = distinctQuery()
  .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
  .where("project_id = {projectId:String}", { projectId: "proj_456" })
  .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
  .where("_is_deleted = 0")
  .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
  })
  .orderBy("timestamp ASC");

const [error, result] = await query.execute();
```

### Using createQuery with Rollup Parameters

For more complex scenarios, use the `createQuery` helper with `MetricQueryParams`:

```typescript
import { MetricQueryParams } from "@internal/clickhouse/metrics";

const params: MetricQueryParams = {
  organizationId: "org_123",
  projectId: "proj_456",
  environmentId: "env_789",
  startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endTime: new Date(),
  granularity: "1h",
  filters: {
    task_identifier: "my-task",
    status: "COMPLETED_SUCCESSFULLY",
  },
  groupBy: "status",
};

const query = clickhouse.metrics.createQuery(params, "status");
const [error, result] = await query.execute();

// Example 2: Using dynamic rollup
const dynamicParams: MetricQueryParams = {
  organizationId: "org_123",
  projectId: "proj_456",
  environmentId: "env_789",
  startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endTime: new Date(),
  granularity: "1h",
  filters: {
    status: "COMPLETED_SUCCESSFULLY",
  },
  groupBy: "task_identifier",
  rollup: {
    type: "avg",
    column: "usage_duration_ms",
  },
};

const dynamicQuery = clickhouse.metrics.createQuery(dynamicParams);
const [dynamicError, dynamicResult] = await dynamicQuery.execute();
```

## Rollup Types

The dynamic metrics system supports the following rollup types:

### COUNT
- **Type**: `"count"`
- **Column**: `"*"` (count all rows) or any column name
- **Use case**: Count total runs, count runs per status, etc.
- **Example**: `{ type: "count", column: "*" }`

### SUM
- **Type**: `"sum"`
- **Column**: Numeric columns like `"cost_in_cents"`, `"usage_duration_ms"`
- **Use case**: Total cost, total duration, etc.
- **Example**: `{ type: "sum", column: "cost_in_cents" }`

### AVERAGE
- **Type**: `"avg"`
- **Column**: Numeric columns like `"usage_duration_ms"`, `"cost_in_cents"`
- **Use case**: Average execution time, average cost per run, etc.
- **Example**: `{ type: "avg", column: "usage_duration_ms" }`

### MINIMUM
- **Type**: `"min"`
- **Column**: Numeric columns
- **Use case**: Fastest execution time, minimum cost, etc.
- **Example**: `{ type: "min", column: "usage_duration_ms" }`

### MAXIMUM
- **Type**: `"max"`
- **Column**: Numeric columns
- **Use case**: Slowest execution time, maximum cost, etc.
- **Example**: `{ type: "max", column: "usage_duration_ms" }`

### DISTINCT
- **Type**: `"distinct"`
- **Column**: Any column
- **Use case**: Unique task identifiers, unique run IDs, etc.
- **Example**: `{ type: "distinct", column: "task_identifier" }`

## Time Granularity

The system supports various time granularities:

- **Seconds**: `30s`, `60s`
- **Minutes**: `1m`, `5m`, `15m`, `30m`, `60m`
- **Hours**: `1h`, `6h`, `12h`, `24h`
- **Days**: `1d`, `7d`, `30d`

## Common Filter Patterns

### Basic Filters

```typescript
.where("organization_id = {organizationId:String}", { organizationId: "org_123" })
.where("project_id = {projectId:String}", { projectId: "proj_456" })
.where("environment_id = {environmentId:String}", { environmentId: "env_789" })
.where("_is_deleted = 0")
```

### Time Range Filters

```typescript
.where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
  startTime: new Date(Date.now() - 24 * 60 * 60 * 1000)
})
.where("created_at <= toUnixTimestamp({endTime:DateTime64})", {
  endTime: new Date()
})
```

### Task-Specific Filters

```typescript
.where("task_identifier = {taskIdentifier:String}", { taskIdentifier: "my-task" })
.where("status IN ('COMPLETED_SUCCESSFULLY', 'FAILED')")
.where("queue = {queue:String}", { queue: "task/my-task" })
```

### Completion Filters

```typescript
.where("usage_duration_ms > 0") // Only completed tasks
.where("cost_in_cents > 0") // Only tasks with cost
.where("completed_at IS NOT NULL") // Only finished tasks
```

## Grouping and Ordering

### Grouping

```typescript
.groupBy("task_identifier") // Group by task
.groupBy("status") // Group by status
.groupBy("queue") // Group by queue
```

### Ordering

```typescript
.orderBy("timestamp ASC") // Chronological order
.orderBy("timestamp DESC") // Reverse chronological
.orderBy("value DESC") // By metric value
```

## Result Format

All metrics queries return data in this format:

```typescript
interface MetricResult {
  metric: string;
  data: MetricDataPoint[];
}

interface MetricDataPoint {
  timestamp: string; // ISO timestamp
  value: number; // The metric value
  label?: string; // Grouping label (e.g., task_identifier, status)
}
```

## Performance Considerations

1. **Use appropriate time ranges**: Limit queries to reasonable time periods
2. **Filter early**: Apply organization/project/environment filters first
3. **Use FINAL**: The queries automatically use `FINAL` to handle deduplication
4. **Limit results**: Use `.limit()` for large result sets
5. **Index usage**: The schema is optimized for queries by organization_id, project_id, environment_id, created_at

## Integration with Webapp

The metrics system integrates with the webapp through the `MetricsService`:

```typescript
import { MetricsService } from "../services/metrics.server";

const metricsService = new MetricsService(clickhouse);

const result = await metricsService.getTaskRunCount(
  apiParams,
  organizationId,
  projectId,
  environmentId
);
```

## Error Handling

Always check for errors in the result tuple:

```typescript
const [error, result] = await query.execute();

if (error) {
  console.error("Query failed:", error);
  return;
}

// Use result safely
console.log("Metrics:", result);
```

## Example: Complete Dashboard Query

```typescript
async function getDashboardMetrics(
  organizationId: string,
  projectId: string,
  environmentId: string
) {
  const clickhouse = ClickHouse.fromEnv();

  try {
    // Get task run counts by status for the last 7 days
    const statusQuery = clickhouse.metrics
      .getTaskRunStatus()
      .where("organization_id = {organizationId:String}", { organizationId })
      .where("project_id = {projectId:String}", { projectId })
      .where("environment_id = {environmentId:String}", { environmentId })
      .where("_is_deleted = 0")
      .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
        startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      })
      .groupBy("status")
      .orderBy("timestamp ASC");

    const [statusError, statusResult] = await statusQuery.execute();

    if (statusError) {
      throw new Error(`Status metrics failed: ${statusError.message}`);
    }

    // Get average duration by task for the last 24 hours
    const durationQuery = clickhouse.metrics
      .getTaskRunDuration()
      .where("organization_id = {organizationId:String}", { organizationId })
      .where("project_id = {projectId:String}", { projectId })
      .where("environment_id = {environmentId:String}", { environmentId })
      .where("_is_deleted = 0")
      .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
        startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .where("usage_duration_ms > 0")
      .groupBy("task_identifier")
      .orderBy("timestamp ASC");

    const [durationError, durationResult] = await durationQuery.execute();

    if (durationError) {
      throw new Error(`Duration metrics failed: ${durationError.message}`);
    }

    return {
      status: statusResult,
      duration: durationResult,
    };
  } finally {
    await clickhouse.close();
  }
}
```

This system provides a powerful and flexible way to query task run metrics while maintaining type safety and performance.

