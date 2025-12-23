// TypeScript translation of posthog/hogql/database/database.py
//
// NOTE: This implementation requires database/ORM access for:
// - serialize() method (needs DataWarehouseTable, DataWarehouseSavedQuery queries)
// - create_for() method (needs Team, DataWarehouseJoin, DataWarehouseSavedQuery queries)
// Adapt these methods to your database/ORM setup

import type { ConstantType } from "./ast";
import type { TRQLContext, TRQLQueryModifiers, Team } from "./context";
import type {
  DatabaseField,
  ExpressionField,
  FieldOrTable,
  FieldTraverser,
  LazyJoin,
  Table,
  TableNode,
  VirtualTable,
} from "./models";
import type { TRQLTimings } from "./timings";
import { QueryError, ResolutionError } from "./errors";
import { TRQLTimings as TRQLTimingsClass } from "./timings";

// Type definitions for schema serialization (adapt to your schema types)
export interface DatabaseSchemaTable {
  fields: Record<string, DatabaseSchemaField>;
  id: string;
  name: string;
}

export interface DatabaseSchemaSystemTable extends DatabaseSchemaTable {
  fields: Record<string, DatabaseSchemaField>;
  id: string;
  name: string;
}

export interface DatabaseSchemaDataWarehouseTable extends DatabaseSchemaTable {
  fields: Record<string, DatabaseSchemaField>;
  id: string;
  name: string;
  format?: string;
  url_pattern?: string;
  schema?: DatabaseSchemaSchema;
  source?: DatabaseSchemaSource;
  row_count?: number;
}

export interface DatabaseSchemaViewTable extends DatabaseSchemaTable {
  fields: Record<string, DatabaseSchemaField>;
  id: string;
  name: string;
  query: { query: string };
  row_count?: number;
}

export interface DatabaseSchemaManagedViewTable extends DatabaseSchemaTable {
  fields: Record<string, DatabaseSchemaField>;
  id: string;
  name: string;
  kind: string;
  source_id?: string;
  query: { query: string };
}

export interface DatabaseSchemaEndpointTable extends DatabaseSchemaTable {
  fields: Record<string, DatabaseSchemaField>;
  id: string;
  name: string;
  query: { query: string };
  row_count?: number;
  status?: string;
}

export interface DatabaseSchemaField {
  name: string;
  trql_value: string;
  type: DatabaseSerializedFieldType;
  schema_valid: boolean;
  fields?: string[];
  table?: string;
  chain?: Array<string | number>;
  id?: string;
}

export interface DatabaseSchemaSchema {
  id: string;
  name: string;
  should_sync: boolean;
  incremental: boolean;
  status: string;
  last_synced_at: string;
}

export interface DatabaseSchemaSource {
  id: string;
  status: string;
  source_type: string;
  prefix: string;
  last_synced_at?: string | null;
}

export enum DatabaseSerializedFieldType {
  STRING = "string",
  INTEGER = "integer",
  FLOAT = "float",
  DECIMAL = "decimal",
  BOOLEAN = "boolean",
  DATE = "date",
  DATETIME = "datetime",
  UUID = "uuid",
  ARRAY = "array",
  JSON = "json",
  TUPLE = "tuple",
  UNKNOWN = "unknown",
  EXPRESSION = "expression",
  VIEW = "view",
  LAZY_TABLE = "lazy_table",
  VIRTUAL_TABLE = "virtual_table",
  FIELD_TRAVERSER = "field_traverser",
}

export interface SerializedField {
  key: string;
  name: string;
  type: DatabaseSerializedFieldType;
  schema_valid: boolean;
  fields?: string[];
  table?: string;
  chain?: Array<string | number>;
}

import { TableNodeImpl } from "./models";

export class Database {
  // Users can query from the tables below
  tables: TableNode;

  private _warehouseTableNames: string[] = [];
  private _warehouseSelfManagedTableNames: string[] = [];
  private _viewTableNames: string[] = [];
  private _coreTableNames: string[] = [];

  private _timezone?: string | null;
  private _weekStartDay?: string | null; // WeekStartDay enum

  private _serializationErrors: Record<string, string> = {};

  constructor(timezone?: string | null, weekStartDay?: string | null) {
    // Initialize with root TableNode
    this.tables = new TableNodeImpl("root");
    this._timezone = timezone || null;
    this._weekStartDay = weekStartDay || null;
  }

  getTimezone(): string {
    return this._timezone || "UTC";
  }

  getWeekStartDay(): string {
    return this._weekStartDay || "sunday"; // Adapt to your WeekStartDay enum
  }

  getSerializationErrors(): Record<string, string> {
    /** Return any errors encountered during serialization. */
    return { ...this._serializationErrors };
  }

  hasTable(tableName: string | string[]): boolean {
    const path = typeof tableName === "string" ? tableName.split(".") : tableName;
    return this.tables.has_child ? this.tables.has_child(path) : false;
  }

  getTableNode(tableName: string | string[]): TableNode {
    let path: string[];
    if (typeof tableName === "string") {
      path = tableName.split(".");
    } else {
      path = tableName;
    }

    // Handle edge case where tableName is a list with a single string containing dots
    if (path.length === 1 && path[0].includes(".")) {
      path = path[0].split(".");
    }

    if (!this.tables.get_child) {
      throw new ResolutionError(`TableNode.get_child not implemented`);
    }
    return this.tables.get_child(path);
  }

  getTable(tableName: string | string[]): Table {
    try {
      const node = this.getTableNode(tableName);
      if (!node.get) {
        throw new ResolutionError("TableNode.get not implemented");
      }
      const table = node.get();
      if (!table || typeof table !== "object" || !("fields" in table)) {
        throw new ResolutionError("Table is not set");
      }
      return table as Table;
    } catch (e) {
      const name = Array.isArray(tableName) ? tableName.join(".") : tableName;
      if (e instanceof ResolutionError) {
        throw new QueryError(`Unknown table \`${name}\`.`);
      }
      throw e;
    }
  }

  getAllTableNames(): string[] {
    const warehouseTableNames = this._warehouseTableNames.filter((x) => x.includes("."));

    return [
      ...this._coreTableNames,
      ...warehouseTableNames,
      ...this._warehouseSelfManagedTableNames,
      ...this._viewTableNames,
    ];
  }

  // Core tables exposed via SQL editor autocomplete and data management
  getCoreTableNames(): string[] {
    return [...this._coreTableNames, ...this.getSystemTableNames()];
  }

  getSystemTableNames(): string[] {
    const systemNode = this.tables.children["system"];
    if (systemNode && systemNode.resolve_all_table_names) {
      return ["query_log", ...systemNode.resolve_all_table_names()];
    }
    return ["query_log"];
  }

  getWarehouseTableNames(): string[] {
    return [...this._warehouseTableNames, ...this._warehouseSelfManagedTableNames];
  }

  getViewNames(): string[] {
    return this._viewTableNames;
  }

  addCoreTable(tableName: string, node: TableNode): void {
    if (this.tables.add_child) {
      this.tables.add_child(node);
    }
    this._coreTableNames.push(tableName);
  }

  private _addWarehouseTables(node: TableNode): void {
    if (this.tables.merge_with) {
      this.tables.merge_with(node);
    }
    if (node.resolve_all_table_names) {
      const names = node.resolve_all_table_names();
      this._warehouseTableNames.push(...names.sort());
    }
  }

  private _addWarehouseSelfManagedTables(node: TableNode): void {
    if (this.tables.merge_with) {
      this.tables.merge_with(node);
    }
    if (node.resolve_all_table_names) {
      const names = node.resolve_all_table_names();
      this._warehouseSelfManagedTableNames.push(...names.sort());
    }
  }

  private _addViews(node: TableNode): void {
    if (this.tables.merge_with) {
      this.tables.merge_with(node);
    }
    if (node.resolve_all_table_names) {
      const names = node.resolve_all_table_names();
      this._viewTableNames.push(...names.sort());
    }
  }

  serialize(context: TRQLContext, includeOnly?: Set<string>): Record<string, DatabaseSchemaTable> {
    // NOTE: This method requires database queries to fetch:
    // - DataWarehouseTable objects
    // - DataWarehouseSavedQuery objects
    // - External data sources and schemas
    //
    // Adapt this to your database/ORM setup

    const tables: Record<string, DatabaseSchemaTable> = {};

    if (!context.team_id) {
      throw new ResolutionError("Must provide team_id to serialize database");
    }

    // Core tables
    const coreTableNames = this.getCoreTableNames();
    for (const tableName of coreTableNames) {
      if (includeOnly && !includeOnly.has(tableName)) {
        continue;
      }

      let fieldInput: Record<string, FieldOrTable> = {};
      const table = this.getTable(tableName);
      if ("get_asterisk" in table && typeof table.get_asterisk === "function") {
        fieldInput = table.get_asterisk() || {};
      } else if ("fields" in table) {
        fieldInput = table.fields;
      }

      const fields = serializeFields(fieldInput, context, tableName.split("."), undefined);
      const fieldsDict: Record<string, DatabaseSchemaField> = {};
      for (const field of fields) {
        fieldsDict[field.name] = field;
      }
      tables[tableName] = {
        fields: fieldsDict,
        id: tableName,
        name: tableName,
      } as DatabaseSchemaTable;
    }

    // System tables
    const systemTables = this.getSystemTableNames();
    for (const tableKey of systemTables) {
      if (includeOnly && !includeOnly.has(tableKey)) {
        continue;
      }

      let systemFieldInput: Record<string, FieldOrTable> = {};
      const table = this.getTable(tableKey);
      if ("get_asterisk" in table && typeof table.get_asterisk === "function") {
        systemFieldInput = table.get_asterisk() || {};
      } else if ("fields" in table) {
        systemFieldInput = table.fields;
      }

      const fields = serializeFields(systemFieldInput, context, tableKey.split("."), undefined);
      const fieldsDict: Record<string, DatabaseSchemaField> = {};
      for (const field of fields) {
        fieldsDict[field.name] = field;
      }
      tables[tableKey] = {
        fields: fieldsDict,
        id: tableKey,
        name: tableKey,
      } as DatabaseSchemaSystemTable;
    }

    // NOTE: Data Warehouse Tables and Views processing requires database queries
    // Implement based on your database/ORM setup:
    // - Fetch DataWarehouseTable objects
    // - Fetch DataWarehouseSavedQuery objects
    // - Process and serialize them

    return tables;
  }

  static createFor(
    teamId?: number,
    options?: {
      team?: Team;
      modifiers?: TRQLQueryModifiers;
      timings?: TRQLTimings;
    }
  ): Database {
    // NOTE: This method requires extensive database/ORM access:
    // - Team model queries
    // - DataWarehouseTable queries
    // - DataWarehouseSavedQuery queries
    // - DataWarehouseJoin queries
    // - GroupTypeMapping queries
    // - Feature flag checks
    //
    // This is a skeleton structure - adapt to your setup

    const timings = options?.timings || new TRQLTimingsClass();
    const { team, modifiers } = options || {};

    // Validate team/teamId
    if (!teamId && !team) {
      throw new Error("Either team_id or team must be provided");
    }

    if (team && teamId && team.id !== teamId) {
      throw new Error("team_id and team must be the same");
    }

    // NOTE: Fetch team from database if not provided
    // const fetchedTeam = team || await Team.findById(teamId);

    // Create database instance
    const database = timings.measure("database", () => {
      // NOTE: Get timezone and week_start_day from team
      // const timezone = fetchedTeam.timezone;
      // const weekStartDay = fetchedTeam.week_start_day;
      return new Database(undefined, undefined);
    });

    // NOTE: Apply modifiers, setup tables, etc.
    // This requires extensive database access and table setup logic

    return database;
  }
}

// Helper functions

const TRQL_CHARACTERS_TO_BE_WRAPPED = ["@", "-", "!", "$", "+"];

function constantTypeToSerializedFieldType(
  constantType: ConstantType
): DatabaseSerializedFieldType | null {
  // Type checking for ConstantType subtypes
  // NOTE: In TypeScript, we need to check properties rather than instanceof
  // since these are interfaces, not classes

  if ("data_type" in constantType) {
    const dataType = constantType.data_type;
    if (dataType === "str") {
      return DatabaseSerializedFieldType.STRING;
    }
    if (dataType === "bool") {
      return DatabaseSerializedFieldType.BOOLEAN;
    }
    if (dataType === "date") {
      return DatabaseSerializedFieldType.DATE;
    }
    if (dataType === "datetime") {
      return DatabaseSerializedFieldType.DATETIME;
    }
    if (dataType === "uuid") {
      return DatabaseSerializedFieldType.STRING;
    }
    if (dataType === "array") {
      return DatabaseSerializedFieldType.ARRAY;
    }
    if (dataType === "tuple") {
      return DatabaseSerializedFieldType.JSON;
    }
    if (dataType === "int") {
      return DatabaseSerializedFieldType.INTEGER;
    }
    if (dataType === "float") {
      return DatabaseSerializedFieldType.FLOAT;
    }
  }

  // Fallback: check print_type if available
  if ("print_type" in constantType && typeof constantType.print_type === "function") {
    const printed = constantType.print_type();
    if (printed === "String" || printed === "JSON" || printed === "Array") {
      return printed === "String"
        ? DatabaseSerializedFieldType.STRING
        : printed === "JSON"
        ? DatabaseSerializedFieldType.JSON
        : DatabaseSerializedFieldType.ARRAY;
    }
    if (printed === "Boolean") return DatabaseSerializedFieldType.BOOLEAN;
    if (printed === "Date") return DatabaseSerializedFieldType.DATE;
    if (printed === "DateTime") return DatabaseSerializedFieldType.DATETIME;
    if (printed === "UUID") return DatabaseSerializedFieldType.STRING;
    if (printed === "Integer") return DatabaseSerializedFieldType.INTEGER;
    if (printed === "Float") return DatabaseSerializedFieldType.FLOAT;
    if (printed === "Decimal") return DatabaseSerializedFieldType.DECIMAL;
  }

  return null;
}

export function serializeFields(
  fieldInput: Record<string, FieldOrTable>,
  context: TRQLContext,
  tableChain: string[],
  dbColumns?: Record<string, any> // DataWarehouseTableColumns
): DatabaseSchemaField[] {
  // NOTE: This requires resolve_types_from_table from resolver
  // Import as needed: import { resolveTypesFromTable } from '../resolver';

  const fieldOutput: DatabaseSchemaField[] = [];

  for (const [fieldKey, field] of Object.entries(fieldInput)) {
    let schemaValid = true;

    if (dbColumns) {
      const column = dbColumns[fieldKey];
      if (typeof column === "string") {
        schemaValid = true;
      } else if (column && typeof column === "object") {
        schemaValid = column.valid !== false;
      }
    }

    let trqlValue: string;
    if (TRQL_CHARACTERS_TO_BE_WRAPPED.some((char) => fieldKey.includes(char))) {
      trqlValue = `\`${fieldKey}\``;
    } else {
      trqlValue = fieldKey;
    }

    if ("hidden" in field && field.hidden) {
      continue;
    }

    if ("name" in field && "get_constant_type" in field) {
      // DatabaseField
      const dbField = field as DatabaseField;
      let fieldType: DatabaseSerializedFieldType;

      // Determine field type based on DatabaseField subclass
      // NOTE: You'll need to check instanceof or use type guards
      // For now, using a simplified approach
      if (dbField.get_constant_type) {
        const constantType = dbField.get_constant_type();
        fieldType =
          constantTypeToSerializedFieldType(constantType) || DatabaseSerializedFieldType.UNKNOWN;
      } else {
        fieldType = DatabaseSerializedFieldType.UNKNOWN;
      }

      fieldOutput.push({
        name: fieldKey,
        trql_value: trqlValue,
        type: fieldType,
        schema_valid: schemaValid,
      });
    } else if ("expr" in field) {
      // ExpressionField
      const exprField = field as ExpressionField;
      // NOTE: Requires resolve_types_from_table
      // const resolvedExpr = resolveTypesFromTable(exprField.expr, tableChain, context, 'trql');
      // const constantType = resolvedExpr.type?.resolve_constant_type(context);
      // const fieldType = constantTypeToSerializedFieldType(constantType) || DatabaseSerializedFieldType.EXPRESSION;

      fieldOutput.push({
        name: fieldKey,
        trql_value: trqlValue,
        type: DatabaseSerializedFieldType.EXPRESSION,
        schema_valid: schemaValid,
      });
    } else if ("resolve_table" in field) {
      // LazyJoin
      const lazyJoin = field as LazyJoin;
      if (lazyJoin.resolve_table) {
        const resolvedTable = lazyJoin.resolve_table(context);
        const type =
          "id" in resolvedTable && resolvedTable.id
            ? DatabaseSerializedFieldType.VIEW
            : DatabaseSerializedFieldType.LAZY_TABLE;

        fieldOutput.push({
          name: fieldKey,
          trql_value: trqlValue,
          type,
          schema_valid: schemaValid,
          table: resolvedTable.to_printed_trql ? resolvedTable.to_printed_trql() : fieldKey,
          fields: "fields" in resolvedTable ? Object.keys(resolvedTable.fields) : [],
          id: "id" in resolvedTable && resolvedTable.id ? String(resolvedTable.id) : fieldKey,
        });
      }
    } else if ("fields" in field && !("resolve_table" in field)) {
      // VirtualTable
      const virtualTable = field as VirtualTable;
      fieldOutput.push({
        name: fieldKey,
        trql_value: trqlValue,
        type: DatabaseSerializedFieldType.VIRTUAL_TABLE,
        schema_valid: schemaValid,
        table: virtualTable.to_printed_trql ? virtualTable.to_printed_trql() : fieldKey,
        fields: Object.keys(virtualTable.fields),
      });
    } else if ("chain" in field) {
      // FieldTraverser
      const traverser = field as FieldTraverser;
      fieldOutput.push({
        name: fieldKey,
        trql_value: trqlValue,
        type: DatabaseSerializedFieldType.FIELD_TRAVERSER,
        schema_valid: schemaValid,
        chain: traverser.chain,
      });
    }
  }

  return fieldOutput;
}
