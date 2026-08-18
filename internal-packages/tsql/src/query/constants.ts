// TypeScript translation of posthog/hogql/constants.py

export type ConstantDataType =
  | "int"
  | "float"
  | "str"
  | "bool"
  | "array"
  | "tuple"
  | "date"
  | "datetime"
  | "uuid"
  | "unknown";

const KEYWORDS = ["true", "false", "null"] as const;
export const RESERVED_KEYWORDS = [...KEYWORDS, "team_id"] as const;

export enum LimitContext {
  QUERY = "query",
  QUERY_ASYNC = "query_async",
  EXPORT = "export",
  COHORT_CALCULATION = "cohort_calculation",
  HEATMAPS = "heatmaps",
  SAVED_QUERY = "saved_query",
  RETENTION = "retention",
}

// Settings applied at the SELECT level
export interface TSQLQuerySettings {
  optimize_aggregation_in_order?: boolean;
  date_time_output_format?: string;
  date_time_input_format?: string;
  join_algorithm?: string;
}
