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

type ConstantSupportedPrimitive = number | string | boolean | Date | null;
type ConstantSupportedData =
  | ConstantSupportedPrimitive
  | ConstantSupportedPrimitive[]
  | [ConstantSupportedPrimitive, ...ConstantSupportedPrimitive[]];

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

// Settings applied on top of all TSQL queries
interface TSQLGlobalSettings extends TSQLQuerySettings {
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
