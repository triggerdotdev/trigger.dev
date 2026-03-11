import { z } from "zod";
import { ClickhouseWriter } from "./client/types.js";

export const LlmUsageV1Input = z.object({
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
  matched_model_id: z.string(),
  operation_name: z.string(),
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

  metadata: z.record(z.string(), z.string()),

  start_time: z.string(),
  duration: z.string(),
});

export type LlmUsageV1Input = z.input<typeof LlmUsageV1Input>;

export function insertLlmUsage(ch: ClickhouseWriter) {
  return ch.insertUnsafe<LlmUsageV1Input>({
    name: "insertLlmUsage",
    table: "trigger_dev.llm_usage_v1",
  });
}
