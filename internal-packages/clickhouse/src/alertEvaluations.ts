import { z } from "zod";
import { ClickhouseWriter } from "./client/types.js";

export const AlertEvaluationV1Input = z.object({
  alert_definition_id: z.string(),
  organization_id: z.string(),
  project_id: z.string().default(""),
  environment_id: z.string().default(""),
  evaluated_at: z.string(), // ISO 8601 datetime string
  state: z.enum(["ok", "firing"]),
  state_changed: z.number().int().min(0).max(1).default(0),
  value: z.number().nullable().default(null),
  conditions: z.string(), // JSON serialized conditions
  query_duration_ms: z.number().int().default(0),
  error_message: z.string().default(""),
});

export type AlertEvaluationV1Input = z.input<typeof AlertEvaluationV1Input>;

export function insertAlertEvaluations(ch: ClickhouseWriter) {
  return ch.insertUnsafe<AlertEvaluationV1Input>({
    name: "insertAlertEvaluations",
    table: "trigger_dev.alert_evaluations_v1",
    settings: {},
  });
}
