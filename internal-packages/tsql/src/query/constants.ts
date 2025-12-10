// TypeScript translation of posthog/hogql/constants.py
// Keep this file in sync with the Python version

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

export type ConstantSupportedPrimitive = number | string | boolean | Date | null;
export type ConstantSupportedData =
  | ConstantSupportedPrimitive
  | ConstantSupportedPrimitive[]
  | [ConstantSupportedPrimitive, ...ConstantSupportedPrimitive[]];

export const KEYWORDS = ["true", "false", "null"] as const;
export const RESERVED_KEYWORDS = [...KEYWORDS, "team_id"] as const;

export const DEFAULT_RETURNED_ROWS = 100;
export const MAX_SELECT_RETURNED_ROWS = 50000;
export const MAX_SELECT_RETENTION_LIMIT = 100000;
export const MAX_SELECT_HEATMAPS_LIMIT = 1000000;
export const MAX_SELECT_COHORT_CALCULATION_LIMIT = 1000000000;
export const MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY = 22 * 1024 * 1024 * 1024;
export const CSV_EXPORT_LIMIT = 300000;
export const CSV_EXPORT_BREAKDOWN_LIMIT_INITIAL = 512;
export const CSV_EXPORT_BREAKDOWN_LIMIT_LOW = 64;
export const BREAKDOWN_VALUES_LIMIT = 25;
export const BREAKDOWN_VALUES_LIMIT_FOR_COUNTRIES = 300;

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
export interface HogQLQuerySettings {
  optimize_aggregation_in_order?: boolean;
  date_time_output_format?: string;
  date_time_input_format?: string;
  join_algorithm?: string;
}

// Settings applied on top of all HogQL queries
export interface HogQLGlobalSettings extends HogQLQuerySettings {
  readonly?: number;
  max_execution_time?: number;
  max_memory_usage?: number;
  max_threads?: number;
  allow_experimental_object_type?: boolean;
  format_csv_allow_double_quotes?: boolean;
  max_ast_elements?: number;
  max_expanded_ast_elements?: number;
  max_bytes_before_external_group_by?: number;
  allow_experimental_analyzer?: boolean;
  transform_null_in?: boolean;
  optimize_min_equality_disjunction_chain_length?: number;
  allow_experimental_join_condition?: boolean;
  preferred_block_size_bytes?: number;
  use_hive_partitioning?: number;
}
