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
  /**
   * For virtual (computed) columns: the raw ClickHouse SQL expression.
   * Use actual ClickHouse column names in the expression.
   *
   * When set, this column becomes a virtual column that doesn't exist in the
   * underlying table but is computed from the expression at query time.
   *
   * @example
   * ```typescript
   * {
   *   name: "execution_duration",
   *   type: "Nullable(Int64)",
   *   expression: "dateDiff('millisecond', started_at, completed_at)",
   *   description: "Time between started_at and completed_at in milliseconds"
   * }
   * ```
   */
  expression?: string;
  /**
   * Custom render type for UI display.
   *
   * When set, the UI can use this to render the column with a custom component
   * instead of the default renderer based on ClickHouseType.
   *
   * Common custom render types:
   * - "runStatus" - Task run status badges
   * - "cost" - Cost formatting (cents to dollars)
   * - "duration" - Duration formatting (ms to human-readable)
   *
   * Custom types can be defined by consumers without modifying this package.
   *
   * @example
   * ```typescript
   * {
   *   name: "status",
   *   type: "LowCardinality(String)",
   *   customRenderType: "runStatus",
   * }
   * ```
   */
  customRenderType?: string;
  /**
   * Example value for documentation purposes.
   *
   * Used in help/documentation UI to show users what values look like.
   *
   * @example
   * ```typescript
   * {
   *   name: "run_id",
   *   type: "String",
   *   example: "run_abc123",
   * }
   * ```
   */
  example?: string;
  /**
   * Name of the runtime field mapping to use for value translation.
   * When set, values are translated using the mapping provided at query time.
   *
   * Unlike `valueMap` which is static and defined in the schema, `fieldMapping`
   * references a mapping that is provided at runtime via `FieldMappings`.
   *
   * - During query compilation: external values → internal values
   * - During result transformation: internal values → external values (or null if unmapped)
   *
   * @example
   * ```typescript
   * {
   *   name: "project_ref",
   *   clickhouseName: "project_id",  // Maps to actual CH column
   *   type: "String",
   *   fieldMapping: "project",  // Uses runtime "project" mapping
   * }
   * ```
   */
  fieldMapping?: string;
}

/**
 * Runtime field mappings for dynamic value translation.
 *
 * Structure: mappingName → (internalValue → externalValue)
 *
 * @example
 * ```typescript
 * const fieldMappings: FieldMappings = {
 *   project: {
 *     "cm12345": "my-project-ref",
 *     "cm67890": "other-project-ref",
 *   },
 * };
 * ```
 */
export type FieldMappings = Record<string, Record<string, string>>;

/**
 * Metadata for a column in query results.
 *
 * This is returned by the TSQL compiler to describe each column in the SELECT clause,
 * allowing the UI to render columns appropriately without inspecting result values.
 */
export interface OutputColumnMetadata {
  /** Column name in the result set (after AS aliasing) */
  name: string;
  /** ClickHouse data type (from schema or inferred for computed expressions) */
  type: ClickHouseType;
  /**
   * Custom render type from schema, if specified.
   * When set, the UI should use a custom renderer instead of the default for the ClickHouseType.
   */
  customRenderType?: string;
  /**
   * Description from the schema column definition, if available.
   * Only present for columns or virtual columns defined in the table schema.
   */
  description?: string;
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
    throw new QueryError(
      `Column "${columnName}" on table "${tableName}" cannot be used in ORDER BY`
    );
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
    throw new QueryError(
      `Column "${columnName}" on table "${tableName}" cannot be used in GROUP BY`
    );
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
 * Check if a column is a virtual (computed) column
 *
 * Virtual columns have an expression property that defines how they are computed
 * from other columns. They don't exist in the underlying table.
 *
 * @param col - The column schema to check
 * @returns true if the column is virtual, false otherwise
 */
export function isVirtualColumn(col: ColumnSchema): boolean {
  return col.expression !== undefined && col.expression.length > 0;
}

/**
 * Get the expression for a virtual column
 *
 * @param col - The column schema
 * @returns The expression string, or undefined if not a virtual column
 */
export function getVirtualColumnExpression(col: ColumnSchema): string | undefined {
  return isVirtualColumn(col) ? col.expression : undefined;
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

// ============================================================
// Field Mapping Utilities (Runtime Dynamic Mappings)
// ============================================================

/**
 * Check if a column uses a runtime field mapping
 *
 * @param col - The column schema to check
 * @returns true if the column has a fieldMapping defined
 */
export function hasFieldMapping(col: ColumnSchema): boolean {
  return col.fieldMapping !== undefined && col.fieldMapping.length > 0;
}

/**
 * Get the external (user-facing) value for an internal ClickHouse value
 * using a runtime field mapping.
 *
 * @param mappings - The runtime field mappings
 * @param mappingName - The name of the mapping to use (from column's fieldMapping)
 * @param internalValue - The internal ClickHouse value
 * @returns The external value, or null if not found in the mapping
 */
export function getExternalValue(
  mappings: FieldMappings,
  mappingName: string,
  internalValue: string
): string | null {
  const mapping = mappings[mappingName];
  if (!mapping) {
    return null;
  }

  const externalValue = mapping[internalValue];
  return externalValue !== undefined ? externalValue : null;
}

/**
 * Get the internal ClickHouse value for an external (user-facing) value
 * using a runtime field mapping. This performs a reverse lookup.
 *
 * @param mappings - The runtime field mappings
 * @param mappingName - The name of the mapping to use (from column's fieldMapping)
 * @param externalValue - The external (user-facing) value
 * @returns The internal value, or null if not found in the mapping
 */
export function getInternalValueFromMapping(
  mappings: FieldMappings,
  mappingName: string,
  externalValue: string
): string | null {
  const mapping = mappings[mappingName];
  if (!mapping) {
    return null;
  }

  // Reverse lookup: find internal value by external value
  for (const [internal, external] of Object.entries(mapping)) {
    if (external === externalValue) {
      return internal;
    }
  }

  return null;
}

/**
 * Get the internal ClickHouse value for an external value (case-insensitive)
 * using a runtime field mapping.
 *
 * @param mappings - The runtime field mappings
 * @param mappingName - The name of the mapping to use
 * @param externalValue - The external (user-facing) value
 * @returns The internal value, or null if not found
 */
export function getInternalValueFromMappingCaseInsensitive(
  mappings: FieldMappings,
  mappingName: string,
  externalValue: string
): string | null {
  const mapping = mappings[mappingName];
  if (!mapping) {
    return null;
  }

  const lowerExternal = externalValue.toLowerCase();

  // Case-insensitive reverse lookup
  for (const [internal, external] of Object.entries(mapping)) {
    if (external.toLowerCase() === lowerExternal) {
      return internal;
    }
  }

  return null;
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
