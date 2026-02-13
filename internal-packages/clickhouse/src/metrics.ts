import { z } from "zod";
import { ClickhouseWriter } from "./client/types.js";

export const MetricsV1Input = z.object({
  organization_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  metric_name: z.string(),
  metric_type: z.string(),
  metric_subject: z.string(),
  bucket_start: z.string(),
  count: z.number(),
  sum_value: z.number(),
  max_value: z.number(),
  min_value: z.number(),
  last_value: z.number(),
  attributes: z.unknown(),
});

export type MetricsV1Input = z.input<typeof MetricsV1Input>;

export function insertMetrics(ch: ClickhouseWriter) {
  return ch.insertUnsafe<MetricsV1Input>({
    name: "insertMetrics",
    table: "trigger_dev.metrics_v1",
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      input_format_json_throw_on_bad_escape_sequence: 0,
      input_format_json_use_string_type_for_ambiguous_paths_in_named_tuples_inference_from_objects: 1,
    },
  });
}
