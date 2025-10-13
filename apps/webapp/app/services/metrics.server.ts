import type { z } from "zod";
import type { ClickHouse, MetricQueryParams } from "@internal/clickhouse";
import type { MetricQueryParams as APIMetricQueryParams } from "../api/metric";

// Convert API params to ClickHouse params
function convertAPIParamsToClickHouseParams(
  apiParams: z.infer<typeof APIMetricQueryParams>,
  organizationId: string,
  projectId: string,
  environmentId: string
): MetricQueryParams {
  return {
    organizationId,
    projectId,
    environmentId,
    startTime: apiParams.startTime,
    endTime: apiParams.endTime,
    granularity: apiParams.granularity,
    filters: apiParams.filters,
    groupBy: apiParams.groupBy,
    rollup: apiParams.rollup,
  };
}

export class MetricsService {
  constructor(private clickhouse: ClickHouse) {}

  async getTaskRunMetrics(
    params: z.infer<typeof APIMetricQueryParams>,
    organizationId: string,
    projectId: string,
    environmentId: string,
    metricType: "count" | "duration" | "cost" | "status" = "count"
  ) {
    const clickhouseParams = convertAPIParamsToClickHouseParams(
      params,
      organizationId,
      projectId,
      environmentId
    );

    const query = this.clickhouse.metrics.createQuery(clickhouseParams, metricType);

    const [error, result] = await query.execute();

    if (error) {
      throw new Error(`Failed to fetch metrics: ${error.message}`);
    }

    return result;
  }

  // Specific metric methods
  async getTaskRunCount(
    params: z.infer<typeof APIMetricQueryParams>,
    organizationId: string,
    projectId: string,
    environmentId: string
  ) {
    return this.getTaskRunMetrics(params, organizationId, projectId, environmentId, "count");
  }

  async getTaskRunDuration(
    params: z.infer<typeof APIMetricQueryParams>,
    organizationId: string,
    projectId: string,
    environmentId: string
  ) {
    return this.getTaskRunMetrics(params, organizationId, projectId, environmentId, "duration");
  }

  async getTaskRunCost(
    params: z.infer<typeof APIMetricQueryParams>,
    organizationId: string,
    projectId: string,
    environmentId: string
  ) {
    return this.getTaskRunMetrics(params, organizationId, projectId, environmentId, "cost");
  }

  async getTaskRunStatus(
    params: z.infer<typeof APIMetricQueryParams>,
    organizationId: string,
    projectId: string,
    environmentId: string
  ) {
    return this.getTaskRunMetrics(params, organizationId, projectId, environmentId, "status");
  }

  // New method for dynamic rollup queries
  async getDynamicMetrics(
    params: z.infer<typeof APIMetricQueryParams>,
    organizationId: string,
    projectId: string,
    environmentId: string
  ) {
    if (!params.rollup) {
      throw new Error("rollup parameter is required for dynamic metrics");
    }

    const clickhouseParams = convertAPIParamsToClickHouseParams(
      params,
      organizationId,
      projectId,
      environmentId
    );

    const query = this.clickhouse.metrics.createQuery(clickhouseParams);

    const [error, result] = await query.execute();

    if (error) {
      throw new Error(`Failed to fetch dynamic metrics: ${error.message}`);
    }

    return result;
  }
}

