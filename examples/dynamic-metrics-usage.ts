import { ClickHouse } from "@internal/clickhouse";
import { MetricQueryParams } from "@internal/clickhouse/metrics";

// Example usage of the dynamic metrics system with rollup types and aggregations
async function dynamicMetricsExamples() {
  const clickhouse = ClickHouse.fromEnv();

  try {
    // Example 1: Count distinct task identifiers per hour
    const distinctTasksQuery = clickhouse.metrics.getDynamic(
      "1h", // granularity
      "distinct", // rollup type
      "task_identifier", // column
      {
        // Optional ClickHouse settings
        max_execution_time: 30,
      }
    );

    const distinctQuery = distinctTasksQuery()
      .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
      .where("project_id = {projectId:String}", { projectId: "proj_456" })
      .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
      .where("_is_deleted = 0")
      .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
        startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      })
      .orderBy("timestamp ASC");

    const [distinctError, distinctResult] = await distinctQuery.execute();

    if (distinctError) {
      console.error("Error fetching distinct task metrics:", distinctError);
    } else {
      console.log("Distinct task metrics:", distinctResult);
    }

    // Example 2: Average duration by status with 15-minute granularity
    const avgDurationByStatusQuery = clickhouse.metrics.getDynamic(
      "15m", // granularity
      "avg", // rollup type
      "usage_duration_ms", // column
      {
        max_execution_time: 30,
      }
    );

    const avgDurationQuery = avgDurationByStatusQuery()
      .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
      .where("project_id = {projectId:String}", { projectId: "proj_456" })
      .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
      .where("_is_deleted = 0")
      .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
        startTime: new Date(Date.now() - 6 * 60 * 60 * 1000), // Last 6 hours
      })
      .where("usage_duration_ms > 0") // Only completed tasks
      .groupBy("status")
      .orderBy("timestamp ASC");

    const [avgDurationError, avgDurationResult] = await avgDurationQuery.execute();

    if (avgDurationError) {
      console.error("Error fetching average duration metrics:", avgDurationError);
    } else {
      console.log("Average duration by status:", avgDurationResult);
    }

    // Example 3: Maximum cost per task per day
    const maxCostQuery = clickhouse.metrics.getDynamic(
      "1d", // granularity
      "max", // rollup type
      "cost_in_cents", // column
      {
        max_execution_time: 60,
      }
    );

    const maxCostQueryBuilder = maxCostQuery()
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

    const [maxCostError, maxCostResult] = await maxCostQueryBuilder.execute();

    if (maxCostError) {
      console.error("Error fetching max cost metrics:", maxCostError);
    } else {
      console.log("Maximum cost per task:", maxCostResult);
    }

    // Example 4: Total cost by queue with 1-hour granularity
    const totalCostByQueueQuery = clickhouse.metrics.getDynamic(
      "1h", // granularity
      "sum", // rollup type
      "cost_in_cents", // column
      {
        max_execution_time: 30,
      }
    );

    const totalCostQuery = totalCostByQueueQuery()
      .where("organization_id = {organizationId:String}", { organizationId: "org_123" })
      .where("project_id = {projectId:String}", { projectId: "proj_456" })
      .where("environment_id = {environmentId:String}", { environmentId: "env_789" })
      .where("_is_deleted = 0")
      .where("created_at >= toUnixTimestamp({startTime:DateTime64})", {
        startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      })
      .where("cost_in_cents > 0")
      .groupBy("queue")
      .orderBy("timestamp ASC");

    const [totalCostError, totalCostResult] = await totalCostQuery.execute();

    if (totalCostError) {
      console.error("Error fetching total cost by queue:", totalCostError);
    } else {
      console.log("Total cost by queue:", totalCostResult);
    }

    // Example 5: Using createQuery with MetricQueryParams for complex scenarios
    const complexParams: MetricQueryParams = {
      organizationId: "org_123",
      projectId: "proj_456",
      environmentId: "env_789",
      startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
      endTime: new Date(),
      granularity: "1h",
      filters: {
        status: "COMPLETED_SUCCESSFULLY",
        queue: "task/important-queue",
      },
      groupBy: "task_identifier",
      rollup: {
        type: "avg",
        column: "usage_duration_ms",
      },
    };

    const complexQuery = clickhouse.metrics.createQuery(complexParams);
    const [complexError, complexResult] = await complexQuery.execute();

    if (complexError) {
      console.error("Error fetching complex metrics:", complexError);
    } else {
      console.log("Complex metrics result:", complexResult);
    }
  } finally {
    await clickhouse.close();
  }
}

// Example showing different rollup types and their use cases
async function rollupTypeExamples() {
  const clickhouse = ClickHouse.fromEnv();

  const baseParams = {
    organizationId: "org_123",
    projectId: "proj_456",
    environmentId: "env_789",
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endTime: new Date(),
    granularity: "1h",
    filters: {
      task_identifier: "my-task",
    },
  };

  try {
    // COUNT: Number of task runs
    const countParams: MetricQueryParams = {
      ...baseParams,
      rollup: { type: "count", column: "*" },
    };
    const countQuery = clickhouse.metrics.createQuery(countParams);
    const [countError, countResult] = await countQuery.execute();
    console.log("Count metrics:", countResult);

    // SUM: Total cost or duration
    const sumParams: MetricQueryParams = {
      ...baseParams,
      rollup: { type: "sum", column: "cost_in_cents" },
    };
    const sumQuery = clickhouse.metrics.createQuery(sumParams);
    const [sumError, sumResult] = await sumQuery.execute();
    console.log("Sum metrics:", sumResult);

    // AVG: Average duration or cost
    const avgParams: MetricQueryParams = {
      ...baseParams,
      rollup: { type: "avg", column: "usage_duration_ms" },
    };
    const avgQuery = clickhouse.metrics.createQuery(avgParams);
    const [avgError, avgResult] = await avgQuery.execute();
    console.log("Average metrics:", avgResult);

    // MIN: Minimum duration
    const minParams: MetricQueryParams = {
      ...baseParams,
      rollup: { type: "min", column: "usage_duration_ms" },
    };
    const minQuery = clickhouse.metrics.createQuery(minParams);
    const [minError, minResult] = await minQuery.execute();
    console.log("Minimum metrics:", minResult);

    // MAX: Maximum duration or cost
    const maxParams: MetricQueryParams = {
      ...baseParams,
      rollup: { type: "max", column: "usage_duration_ms" },
    };
    const maxQuery = clickhouse.metrics.createQuery(maxParams);
    const [maxError, maxResult] = await maxQuery.execute();
    console.log("Maximum metrics:", maxResult);

    // DISTINCT: Unique task identifiers, run IDs, etc.
    const distinctParams: MetricQueryParams = {
      ...baseParams,
      rollup: { type: "distinct", column: "task_identifier" },
    };
    const distinctQuery = clickhouse.metrics.createQuery(distinctParams);
    const [distinctError, distinctResult] = await distinctQuery.execute();
    console.log("Distinct metrics:", distinctResult);
  } finally {
    await clickhouse.close();
  }
}

// Example showing different granularities
async function granularityExamples() {
  const clickhouse = ClickHouse.fromEnv();

  const baseParams = {
    organizationId: "org_123",
    projectId: "proj_456",
    environmentId: "env_789",
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
    endTime: new Date(),
    rollup: { type: "count", column: "*" },
  };

  try {
    // 30-second granularity (for real-time monitoring)
    const secondParams: MetricQueryParams = {
      ...baseParams,
      granularity: "30s",
    };
    const secondQuery = clickhouse.metrics.createQuery(secondParams);
    const [secondError, secondResult] = await secondQuery.execute();
    console.log("30-second granularity:", secondResult);

    // 1-minute granularity (for detailed analysis)
    const minuteParams: MetricQueryParams = {
      ...baseParams,
      granularity: "1m",
    };
    const minuteQuery = clickhouse.metrics.createQuery(minuteParams);
    const [minuteError, minuteResult] = await minuteQuery.execute();
    console.log("1-minute granularity:", minuteResult);

    // 5-minute granularity (for monitoring dashboards)
    const fiveMinuteParams: MetricQueryParams = {
      ...baseParams,
      granularity: "5m",
    };
    const fiveMinuteQuery = clickhouse.metrics.createQuery(fiveMinuteParams);
    const [fiveMinuteError, fiveMinuteResult] = await fiveMinuteQuery.execute();
    console.log("5-minute granularity:", fiveMinuteResult);

    // 1-hour granularity (for daily reports)
    const hourParams: MetricQueryParams = {
      ...baseParams,
      granularity: "1h",
    };
    const hourQuery = clickhouse.metrics.createQuery(hourParams);
    const [hourError, hourResult] = await hourQuery.execute();
    console.log("1-hour granularity:", hourResult);

    // 1-day granularity (for weekly/monthly reports)
    const dayParams: MetricQueryParams = {
      ...baseParams,
      granularity: "1d",
    };
    const dayQuery = clickhouse.metrics.createQuery(dayParams);
    const [dayError, dayResult] = await dayQuery.execute();
    console.log("1-day granularity:", dayResult);
  } finally {
    await clickhouse.close();
  }
}

export { dynamicMetricsExamples, rollupTypeExamples, granularityExamples };


