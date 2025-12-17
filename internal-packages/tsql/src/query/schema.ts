// Schema definitions for TSQL query validation
// Defines allowed tables, columns, and tenant isolation configuration

import { QueryError } from "./errors";

/**
 * ClickHouse data types supported by TSQL
 */
export type ClickHouseType =
  | "String"
  | "UInt8"
  | "UInt16"
  | "UInt32"
  | "UInt64"
  | "Int8"
  | "Int16"
  | "Int32"
  | "Int64"
  | "Float32"
  | "Float64"
  | "Date"
  | "Date32"
  | "DateTime"
  | "DateTime64"
  | "UUID"
  | "Bool"
  | "JSON"
  | "Nullable(String)"
  | "Nullable(UInt8)"
  | "Nullable(UInt16)"
  | "Nullable(UInt32)"
  | "Nullable(UInt64)"
  | "Nullable(Int8)"
  | "Nullable(Int16)"
  | "Nullable(Int32)"
  | "Nullable(Int64)"
  | "Nullable(Float32)"
  | "Nullable(Float64)"
  | "Nullable(Date)"
  | "Nullable(Date32)"
  | "Nullable(DateTime)"
  | "Nullable(DateTime64)"
  | "Nullable(UUID)"
  | "Nullable(Bool)"
  | "LowCardinality(String)"
  | `Array(${string})`
  | `Map(${string}, ${string})`;

/**
 * Schema definition for a single column
 */
export interface ColumnSchema {
  /** The name of the column as exposed to TSQL queries */
  name: string;
  /** The actual ClickHouse column name (if different from `name`) */
  clickhouseName?: string;
  /** The ClickHouse data type */
  type: ClickHouseType;
  /** Whether this column can be selected */
  selectable?: boolean;
  /** Whether this column can be used in WHERE clauses */
  filterable?: boolean;
  /** Whether this column can be used in ORDER BY clauses */
  sortable?: boolean;
  /** Whether this column can be used in GROUP BY clauses */
  groupable?: boolean;
  /** Description of the column for documentation/autocomplete */
  description?: string;
  /** Allowed values for this column (for enum-like columns) */
  allowedValues?: string[];
  /**
   * Map of internal values to user-friendly display names (for enum-like columns)
   * Key: internal ClickHouse value (e.g., "COMPLETED_SUCCESSFULLY")
   * Value: user-friendly display name (e.g., "Completed")
   *
   * When set, users can write queries using the user-friendly names,
   * and results will display user-friendly names instead of internal values.
   */
  valueMap?: Record<string, string>;
}

/**
 * Configuration for tenant isolation columns
 * These columns are automatically added to WHERE clauses
 */
export interface TenantColumnConfig {
  /** The column name for organization ID filtering */
  organizationId: string;
  /** The column name for project ID filtering */
  projectId: string;
  /** The column name for environment ID filtering */
  environmentId: string;
}

/**
 * Schema definition for a table
 */
export interface TableSchema {
  /** The name of the table as exposed to TSQL queries */
  name: string;
  /** The fully qualified ClickHouse table name (e.g., "trigger_dev.task_runs_v2") */
  clickhouseName: string;
  /** Column definitions for this table */
  columns: Record<string, ColumnSchema>;
  /** Tenant isolation column configuration */
  tenantColumns: TenantColumnConfig;
  /** Description of the table for documentation/autocomplete */
  description?: string;
  /** Whether this table can be joined to other tables */
  joinable?: boolean;
}

/**
 * Schema registry containing all allowed tables
 */
export interface SchemaRegistry {
  /** Map of table names to their schemas */
  tables: Record<string, TableSchema>;
  /** Default tenant column names (used when a table doesn't specify its own) */
  defaultTenantColumns: TenantColumnConfig;
}

/**
 * Create a basic column schema with common defaults
 */
export function column(
  type: ClickHouseType,
  options: Partial<Omit<ColumnSchema, "name" | "type">> = {}
): Omit<ColumnSchema, "name"> {
  return {
    type,
    selectable: true,
    filterable: true,
    sortable: true,
    groupable: true,
    ...options,
  };
}

/**
 * Create a schema registry from a list of table schemas
 */
export function createSchemaRegistry(
  tables: TableSchema[],
  defaultTenantColumns?: TenantColumnConfig
): SchemaRegistry {
  const tableMap: Record<string, TableSchema> = {};
  for (const table of tables) {
    tableMap[table.name] = table;
  }
  return {
    tables: tableMap,
    defaultTenantColumns: defaultTenantColumns ?? {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };
}

/**
 * Look up a table schema by name
 */
export function findTable(schema: SchemaRegistry, tableName: string): TableSchema | undefined {
  return schema.tables[tableName];
}

/**
 * Look up a column schema by table and column name
 */
export function findColumn(
  schema: SchemaRegistry,
  tableName: string,
  columnName: string
): ColumnSchema | undefined {
  const table = findTable(schema, tableName);
  if (!table) return undefined;
  return table.columns[columnName];
}

/**
 * Validate that a table exists in the schema
 * @throws QueryError if the table is not found
 */
export function validateTable(schema: SchemaRegistry, tableName: string): TableSchema {
  const table = findTable(schema, tableName);
  if (!table) {
    const availableTables = Object.keys(schema.tables).join(", ");
    throw new QueryError(
      `Table "${tableName}" is not accessible. Available tables: ${availableTables || "(none)"}`
    );
  }
  return table;
}

/**
 * Validate that a column exists in a table and can be selected
 * @throws QueryError if the column is not found or not selectable
 */
export function validateSelectColumn(
  schema: SchemaRegistry,
  tableName: string,
  columnName: string
): ColumnSchema {
  const table = validateTable(schema, tableName);
  const col = table.columns[columnName];
  if (!col) {
    const availableColumns = Object.keys(table.columns).join(", ");
    throw new QueryError(
      `Column "${columnName}" does not exist on table "${tableName}". Available columns: ${availableColumns}`
    );
  }
  if (col.selectable === false) {
    throw new QueryError(`Column "${columnName}" on table "${tableName}" is not selectable`);
  }
  return col;
}

/**
 * Validate that a column can be used in a WHERE clause
 * @throws QueryError if the column is not filterable
 */
export function validateFilterColumn(
  schema: SchemaRegistry,
  tableName: string,
  columnName: string
): ColumnSchema {
  const table = validateTable(schema, tableName);
  const col = table.columns[columnName];
  if (!col) {
    throw new QueryError(`Column "${columnName}" does not exist on table "${tableName}"`);
  }
  if (col.filterable === false) {
    throw new QueryError(`Column "${columnName}" on table "${tableName}" cannot be used in WHERE`);
  }
  return col;
}

/**
 * Validate that a column can be used in ORDER BY
 * @throws QueryError if the column is not sortable
 */
export function validateSortColumn(
  schema: SchemaRegistry,
  tableName: string,
  columnName: string
): ColumnSchema {
  const table = validateTable(schema, tableName);
  const col = table.columns[columnName];
  if (!col) {
    throw new QueryError(`Column "${columnName}" does not exist on table "${tableName}"`);
  }
  if (col.sortable === false) {
    throw new QueryError(`Column "${columnName}" on table "${tableName}" cannot be used in ORDER BY`);
  }
  return col;
}

/**
 * Validate that a column can be used in GROUP BY
 * @throws QueryError if the column is not groupable
 */
export function validateGroupColumn(
  schema: SchemaRegistry,
  tableName: string,
  columnName: string
): ColumnSchema {
  const table = validateTable(schema, tableName);
  const col = table.columns[columnName];
  if (!col) {
    throw new QueryError(`Column "${columnName}" does not exist on table "${tableName}"`);
  }
  if (col.groupable === false) {
    throw new QueryError(`Column "${columnName}" on table "${tableName}" cannot be used in GROUP BY`);
  }
  return col;
}

/**
 * Get the actual ClickHouse column name (handles aliasing)
 */
export function getClickHouseColumnName(col: ColumnSchema): string {
  return col.clickhouseName ?? col.name;
}

/**
 * Get the user-friendly display value for an internal value (case-insensitive)
 * Used for transforming query results back to user-friendly format
 *
 * @param col - The column schema
 * @param internalValue - The internal ClickHouse value
 * @returns The user-friendly display value, or the original value if no mapping exists
 */
export function getUserFriendlyValue(col: ColumnSchema, internalValue: string): string {
  if (!col.valueMap) {
    return internalValue;
  }

  // Direct lookup first (case-sensitive for exact match)
  if (col.valueMap[internalValue] !== undefined) {
    return col.valueMap[internalValue];
  }

  // Case-insensitive fallback
  const lowerValue = internalValue.toLowerCase();
  for (const [internal, friendly] of Object.entries(col.valueMap)) {
    if (internal.toLowerCase() === lowerValue) {
      return friendly;
    }
  }

  return internalValue;
}

/**
 * Get the internal ClickHouse value for a user-friendly value (case-insensitive)
 * Used for transforming user queries to internal format
 *
 * @param col - The column schema
 * @param userValue - The user-friendly display value
 * @returns The internal ClickHouse value, or the original value if no mapping exists
 */
export function getInternalValue(col: ColumnSchema, userValue: string): string {
  if (!col.valueMap) {
    return userValue;
  }

  const lowerUserValue = userValue.toLowerCase();

  // Search for matching user-friendly value (case-insensitive)
  for (const [internal, friendly] of Object.entries(col.valueMap)) {
    if (friendly.toLowerCase() === lowerUserValue) {
      return internal;
    }
  }

  return userValue;
}

/**
 * Get all allowed user-friendly values for a column
 * Used for validation and autocomplete
 *
 * @param col - The column schema
 * @returns Array of allowed user-friendly values, or allowedValues if no valueMap exists
 */
export function getAllowedUserValues(col: ColumnSchema): string[] {
  if (col.valueMap) {
    return Object.values(col.valueMap);
  }
  return col.allowedValues ?? [];
}

/**
 * Check if a user-provided value is valid for a column (case-insensitive)
 *
 * @param col - The column schema
 * @param userValue - The user-provided value to validate
 * @returns true if the value is valid, false otherwise
 */
export function isValidUserValue(col: ColumnSchema, userValue: string): boolean {
  const allowedValues = getAllowedUserValues(col);
  if (allowedValues.length === 0) {
    return true; // No restrictions
  }

  const lowerUserValue = userValue.toLowerCase();
  return allowedValues.some((v) => v.toLowerCase() === lowerUserValue);
}

/**
 * Get all column names available for autocomplete
 */
export function getTableColumnNames(schema: SchemaRegistry, tableName: string): string[] {
  const table = findTable(schema, tableName);
  if (!table) return [];
  return Object.keys(table.columns);
}

/**
 * Get all table names available for autocomplete
 */
export function getAllTableNames(schema: SchemaRegistry): string[] {
  return Object.keys(schema.tables);
}

