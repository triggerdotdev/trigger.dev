// TypeScript translation of posthog/hogql/context.py
// Keep this file in sync with the Python version

import type { LimitContext } from "./constants";
import type { Database } from "./database";
import type { PropertySwapper } from "./property_types";
import type { HogQLTimings } from "./timings";

export interface HogQLNotice {
  start?: number;
  end?: number;
  message: string;
  fix?: string;
}

export interface HogQLQueryModifiers {
  optimizeJoinedFilters?: boolean;
  debug?: boolean;
  timings?: boolean;
  useMaterializedViews?: boolean;
  formatCsvAllowDoubleQuotes?: boolean;
  convertToProjectTimezone?: boolean;
  usePreaggregatedTableTransforms?: boolean;
  optimizeProjections?: boolean;
}

export interface HogQLFieldAccess {
  input: string[];
  type?: "run";
  field?: string;
  sql: string;
}

export interface Team {
  id: number;
  project_id: number;
}

export interface HogQLContext {
  team_id?: number;
  team?: Team;
  database?: Database;
  values: Record<string, any>;
  within_non_hogql_query?: boolean;
  enable_select_queries?: boolean;
  limit_top_select?: boolean;
  limit_context?: LimitContext;
  output_format?: string | null;
  globals?: Record<string, any>;
  warnings: HogQLNotice[];
  notices: HogQLNotice[];
  errors: HogQLNotice[];
  timings: HogQLTimings;
  modifiers: HogQLQueryModifiers;
  debug?: boolean;
  property_swapper?: PropertySwapper;
}
