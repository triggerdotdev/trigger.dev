import { z } from "zod";
import { ClickhouseWriter } from "./client/types.js";

export const LlmMetricsV1Input = z.object({
  organization_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  run_id: z.string(),
  task_identifier: z.string(),
  trace_id: z.string(),
  span_id: z.string(),

  gen_ai_system: z.string(),
  request_model: z.string(),
  response_model: z.string(),
  base_response_model: z.string(),
  matched_model_id: z.string(),
  operation_id: z.string(),
  finish_reason: z.string(),
  cost_source: z.string(),

  pricing_tier_id: z.string(),
  pricing_tier_name: z.string(),

  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  usage_details: z.record(z.string(), z.number()),

  input_cost: z.number(),
  output_cost: z.number(),
  total_cost: z.number(),
  cost_details: z.record(z.string(), z.number()),
  provider_cost: z.number(),

  ms_to_first_chunk: z.number(),
  tokens_per_second: z.number(),

  metadata: z.record(z.string(), z.string()),

  prompt_slug: z.string(),
  prompt_version: z.number(),

  start_time: z.string(),
  duration: z.string(),
});

export type LlmMetricsV1Input = z.input<typeof LlmMetricsV1Input>;

export function insertLlmMetrics(ch: ClickhouseWriter) {
  return ch.insertUnsafe<LlmMetricsV1Input>({
    name: "insertLlmMetrics",
    table: "trigger_dev.llm_metrics_v1",
  });
}
