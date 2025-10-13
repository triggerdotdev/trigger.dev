import { ClickHouse } from "@internal/clickhouse";
import { MetricQueryParams } from "@internal/clickhouse/metrics";

// Example usage of the metrics system
async function exampleUsage() {
  // Initialize ClickHouse client
  const clickhouse = ClickHouse.fromEnv();

  // Example 1: Get task run count metrics
  const countMetrics = clickhouse.metrics.getTaskRunCount();

  const countQuery = countMetrics()
    .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
    .where("project_id = {projectId:String}", { projectId: "proj_456" })
    .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
    .where("_is_deleted = 0")
    .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
      startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
    })
    .groupBy("task_identifier")
    .orderBy("timestamp ASC");

  const [countError, countResult] = await countQuery.execute();

  if (countError) {
    console.error("Error fetching count metrics:", countError);
  } else {
    console.log("Task run count metrics:", countResult);
  }

  // Example 2: Get task run duration metrics
  const durationMetrics = clickhouse.metrics.getTaskRunDuration();

  const durationQuery = durationMetrics()
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

  const [durationError, durationResult] = await durationQuery.execute();

  if (durationError) {
    console.error("Error fetching duration metrics:", durationError);
  } else {
    console.log("Task run duration metrics:", durationResult);
  }

  // Example 3: Get custom metrics (e.g., cost per task)
  const costMetrics = clickhouse.metrics.getCustom("cost", "sum", "cost_in_cents");

  const costQuery = costMetrics()
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

  const [costError, costResult] = await costQuery.execute();

  if (costError) {
    console.error("Error fetching cost metrics:", costError);
  } else {
    console.log("Task run cost metrics:", costResult);
  }

  // Example 4: Using the createQuery helper with MetricQueryParams
  const params: MetricQueryParams = {
    organizationId: "org_123",
    projectId: "proj_456",
    environmentId: "env_789",
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endTime: new Date(),
    granularity: "1h",
    filters: {
      task_identifier: "my-task",
    },
    groupBy: "status",
  };

  const statusQuery = clickhouse.metrics.createQuery(params, "status");
  const [statusError, statusResult] = await statusQuery.execute();

  if (statusError) {
    console.error("Error fetching status metrics:", statusError);
  } else {
    console.log("Task run status metrics:", statusResult);
  }

  // Clean up
  await clickhouse.close();
}

// Example of more advanced query with multiple filters
async function advancedMetricsExample() {
  const clickhouse = ClickHouse.fromEnv();

  // Get metrics for a specific task with custom time range and grouping
  const query = clickhouse.metrics
    .getTaskRunCount()
    .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
    .where("project_id = {projectId:String}", { projectId: "proj_456" })
    .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
    .where("_is_deleted = 0")
    .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
      startTime: new Date("2024-01-01T00:00:00Z"),
    })
    .where("created_at <= toUnixTimestamp({endTime:DateTime64})", {
      endTime: new Date("2024-01-31T23:59:59Z"),
    })
    .where("task_identifier = {taskIdentifier:String}", { taskIdentifier: "my-specific-task" })
    .where("status IN ('COMPLETED_SUCCESSFULLY', 'FAILED')")
    .groupBy("status")
    .orderBy("timestamp ASC")
    .limit(1000);

  const [error, result] = await query.execute();

  if (error) {
    console.error("Error:", error);
  } else {
    console.log("Advanced metrics result:", result);
  }

  await clickhouse.close();
}

export { exampleUsage, advancedMetricsExample };


