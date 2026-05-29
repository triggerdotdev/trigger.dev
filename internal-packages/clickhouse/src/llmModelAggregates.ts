import { z } from "zod";
import { ClickhouseQueryBuilder } from "./client/queryBuilder.js";
import type { ClickhouseReader } from "./client/types.js";

// --- Schemas ---

const ModelMetricsRow = z.object({
  response_model: z.string(),
  gen_ai_system: z.string(),
  minute: z.string(),
  call_count: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  total_cost: z.coerce.number(),
  ttfc_p50: z.coerce.number(),
  ttfc_p90: z.coerce.number(),
  ttfc_p95: z.coerce.number(),
  ttfc_p99: z.coerce.number(),
  tps_p50: z.coerce.number(),
  tps_p90: z.coerce.number(),
  tps_p95: z.coerce.number(),
  tps_p99: z.coerce.number(),
  duration_p50: z.coerce.number(),
  duration_p90: z.coerce.number(),
  duration_p95: z.coerce.number(),
  duration_p99: z.coerce.number(),
});

const ModelSummaryRow = z.object({
  response_model: z.string(),
  gen_ai_system: z.string(),
  call_count: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  total_cost: z.coerce.number(),
  ttfc_p50: z.coerce.number(),
  ttfc_p90: z.coerce.number(),
  tps_p50: z.coerce.number(),
  tps_p90: z.coerce.number(),
});

const PopularModelRow = z.object({
  response_model: z.string(),
  gen_ai_system: z.string(),
  call_count: z.coerce.number(),
  total_cost: z.coerce.number(),
  ttfc_p50: z.coerce.number(),
});

// --- Query builders ---

/** Get per-minute metrics for a specific model over a date range. */
export function getGlobalModelMetrics(reader: ClickhouseReader) {
  return new ClickhouseQueryBuilder(
    "getGlobalModelMetrics",
    `SELECT
      response_model,
      gen_ai_system,
      minute,
      sum(call_count) AS call_count,
      sum(total_input_tokens) AS total_input_tokens,
      sum(total_output_tokens) AS total_output_tokens,
      sum(total_cost) AS total_cost,
      quantilesMerge(0.5, 0.9, 0.95, 0.99)(ttfc_quantiles) AS ttfc_arr,
      ttfc_arr[1] AS ttfc_p50,
      ttfc_arr[2] AS ttfc_p90,
      ttfc_arr[3] AS ttfc_p95,
      ttfc_arr[4] AS ttfc_p99,
      quantilesMerge(0.5, 0.9, 0.95, 0.99)(tps_quantiles) AS tps_arr,
      tps_arr[1] AS tps_p50,
      tps_arr[2] AS tps_p90,
      tps_arr[3] AS tps_p95,
      tps_arr[4] AS tps_p99,
      quantilesMerge(0.5, 0.9, 0.95, 0.99)(duration_quantiles) AS dur_arr,
      dur_arr[1] AS duration_p50,
      dur_arr[2] AS duration_p90,
      dur_arr[3] AS duration_p95,
      dur_arr[4] AS duration_p99
    FROM trigger_dev.llm_model_aggregates_v1
    WHERE response_model = {responseModel: String}
      AND minute >= {startTime: DateTime}
      AND minute <= {endTime: DateTime}
    GROUP BY response_model, gen_ai_system, minute
    ORDER BY minute`,
    reader,
    ModelMetricsRow
  );
}

/** Get summary metrics for multiple models (for comparison). */
export function getGlobalModelComparison(reader: ClickhouseReader) {
  return new ClickhouseQueryBuilder(
    "getGlobalModelComparison",
    `SELECT
      response_model,
      gen_ai_system,
      sum(call_count) AS call_count,
      sum(total_input_tokens) AS total_input_tokens,
      sum(total_output_tokens) AS total_output_tokens,
      sum(total_cost) AS total_cost,
      quantilesMerge(0.5, 0.9)(ttfc_quantiles) AS ttfc_arr,
      ttfc_arr[1] AS ttfc_p50,
      ttfc_arr[2] AS ttfc_p90,
      quantilesMerge(0.5, 0.9)(tps_quantiles) AS tps_arr,
      tps_arr[1] AS tps_p50,
      tps_arr[2] AS tps_p90
    FROM trigger_dev.llm_model_aggregates_v1
    WHERE response_model IN {responseModels: Array(String)}
      AND minute >= {startTime: DateTime}
      AND minute <= {endTime: DateTime}
    GROUP BY response_model, gen_ai_system
    ORDER BY call_count DESC`,
    reader,
    ModelSummaryRow
  );
}

/** Get the most popular models by call count. */
export function getPopularModels(reader: ClickhouseReader) {
  return new ClickhouseQueryBuilder(
    "getPopularModels",
    `SELECT
      response_model,
      gen_ai_system,
      sum(call_count) AS call_count,
      sum(total_cost) AS total_cost,
      quantilesMerge(0.5)(ttfc_quantiles) AS ttfc_arr,
      ttfc_arr[1] AS ttfc_p50
    FROM trigger_dev.llm_model_aggregates_v1
    WHERE minute >= {startTime: DateTime}
      AND minute <= {endTime: DateTime}
    GROUP BY response_model, gen_ai_system
    ORDER BY call_count DESC
    LIMIT {limit: UInt32}`,
    reader,
    PopularModelRow
  );
}
