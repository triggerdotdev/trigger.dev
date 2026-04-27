// TypeScript translation of posthog/hogql/context.py

import type { LimitContext } from "./constants";
import type { Database } from "./database";
import type { PropertySwapper } from "./property_types";
import type { TSQLTimings } from "./timings";

export interface TSQLNotice {
  start?: number;
  end?: number;
  message: string;
  fix?: string;
}

export interface TSQLQueryModifiers {
  optimizeJoinedFilters?: boolean;
  debug?: boolean;
  timings?: boolean;
  useMaterializedViews?: boolean;
  formatCsvAllowDoubleQuotes?: boolean;
  convertToProjectTimezone?: boolean;
  usePreaggregatedTableTransforms?: boolean;
  optimizeProjections?: boolean;
}

export interface TSQLFieldAccess {
  input: string[];
  type?: "run";
  field?: string;
  sql: string;
}

export interface Team {
  id: number;
  project_id: number;
}

export interface TSQLContext {
  team_id?: number;
  team?: Team;
  database?: Database;
  values: Record<string, any>;
  within_non_tsql_query?: boolean;
  enable_select_queries?: boolean;
  limit_top_select?: boolean;
  limit_context?: LimitContext;
  output_format?: string | null;
  globals?: Record<string, any>;
  warnings: TSQLNotice[];
  notices: TSQLNotice[];
  errors: TSQLNotice[];
  timings: TSQLTimings;
  modifiers: TSQLQueryModifiers;
  debug?: boolean;
  property_swapper?: PropertySwapper;
}
