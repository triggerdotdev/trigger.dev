// TypeScript port of posthog/hogql/context.py
// Adapted for ClickHouse client's {param: Type} syntax

import { getClickHouseType } from "./escape";
import { SchemaRegistry, FieldMappings } from "./schema";

/**
 * Settings that control query execution behavior
 */
export interface QuerySettings {
  /** Maximum number of rows to return */
  maxRows?: number;
  /** Timezone for date/time operations */
  timezone?: string;
  /** Whether to allow full table scans */
  allowFullTableScans?: boolean;
  /** Query timeout in seconds */
  timeoutSeconds?: number;
}

/**
 * Default query settings
 */
export const DEFAULT_QUERY_SETTINGS: Required<QuerySettings> = {
  maxRows: 10000,
  timezone: "UTC",
  allowFullTableScans: false,
  timeoutSeconds: 60,
};

/**
 * A warning or notice collected during query printing
 */
export interface QueryNotice {
  code: string;
  message: string;
  start?: number;
  end?: number;
}

/**
 * Context for the TRQL to ClickHouse printer
 *
 * Holds:
 * - Tenant IDs for automatic WHERE clause injection
 * - Schema registry for table/column validation
 * - Parameter accumulator for SQL injection safety
 * - Query settings and execution options
 * - Field mappings for runtime value translation
 */
export class PrinterContext {
  /** Accumulated parameter values for parameterized query */
  private values: Record<string, unknown> = {};

  /** Counter for generating unique parameter names */
  private paramCounter = 0;

  /** Warnings collected during printing */
  readonly warnings: QueryNotice[] = [];

  /** Errors collected during printing */
  readonly errors: QueryNotice[] = [];

  /** Runtime field mappings for dynamic value translation */
  readonly fieldMappings: FieldMappings;

  constructor(
    /** The organization ID for tenant isolation (required) */
    public readonly organizationId: string,
    /** The project ID for tenant isolation (optional - omit to query across all projects) */
    public readonly projectId: string | undefined,
    /** The environment ID for tenant isolation (optional - omit to query across all environments) */
    public readonly environmentId: string | undefined,
    /** Schema registry containing allowed tables and columns */
    public readonly schema: SchemaRegistry,
    /** Query execution settings */
    public readonly settings: QuerySettings = {},
    /** Runtime field mappings for dynamic value translation */
    fieldMappings: FieldMappings = {}
  ) {
    // Initialize with default settings
    this.settings = { ...DEFAULT_QUERY_SETTINGS, ...settings };
    this.fieldMappings = fieldMappings;
  }

  /**
   * Get the timezone setting
   */
  get timezone(): string {
    return this.settings.timezone ?? DEFAULT_QUERY_SETTINGS.timezone;
  }

  /**
   * Get the max rows setting
   */
  get maxRows(): number {
    return this.settings.maxRows ?? DEFAULT_QUERY_SETTINGS.maxRows;
  }

  /**
   * Add a value to the parameter map and return a ClickHouse placeholder
   *
   * @param value The value to parameterize
   * @returns A placeholder string like "{trql_val_0: String}"
   */
  addValue(value: unknown): string {
    const key = `trql_val_${this.paramCounter++}`;
    this.values[key] = value;
    const chType = getClickHouseType(value);
    return `{${key}: ${chType}}`;
  }

  /**
   * Add a value with a specific key (for named parameters)
   *
   * @param key The parameter name
   * @param value The value
   * @returns A placeholder string like "{key: Type}"
   */
  addNamedValue(key: string, value: unknown): string {
    this.values[key] = value;
    const chType = getClickHouseType(value);
    return `{${key}: ${chType}}`;
  }

  /**
   * Get all accumulated parameter values
   */
  getParams(): Record<string, unknown> {
    return { ...this.values };
  }

  /**
   * Add a warning notice
   */
  addWarning(code: string, message: string, start?: number, end?: number): void {
    this.warnings.push({ code, message, start, end });
  }

  /**
   * Add an error notice
   */
  addError(code: string, message: string, start?: number, end?: number): void {
    this.errors.push({ code, message, start, end });
  }

  /**
   * Check if any errors were collected
   */
  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  /**
   * Create a child context that shares the same parameter accumulator
   * Useful for handling subqueries while keeping parameters unified
   */
  createChildContext(): PrinterContext {
    const child = new PrinterContext(
      this.organizationId,
      this.projectId,
      this.environmentId,
      this.schema,
      this.settings,
      this.fieldMappings
    );
    // Share the same values map so parameters are unified
    child.values = this.values;
    // Share the same counter reference via closure
    const parentThis = this;
    Object.defineProperty(child, "paramCounter", {
      get() {
        return parentThis.paramCounter;
      },
      set(v: number) {
        parentThis.paramCounter = v;
      },
    });
    return child;
  }
}

/**
 * Options for creating a printer context
 */
export interface PrinterContextOptions {
  /** The organization ID for tenant isolation (required) */
  organizationId: string;
  /** The project ID for tenant isolation (optional - omit to query across all projects) */
  projectId?: string;
  /** The environment ID for tenant isolation (optional - omit to query across all environments) */
  environmentId?: string;
  schema: SchemaRegistry;
  settings?: QuerySettings;
  /**
   * Runtime field mappings for dynamic value translation.
   * Maps internal ClickHouse values to external user-facing values.
   */
  fieldMappings?: FieldMappings;
}

/**
 * Create a new PrinterContext
 */
export function createPrinterContext(options: PrinterContextOptions): PrinterContext {
  return new PrinterContext(
    options.organizationId,
    options.projectId,
    options.environmentId,
    options.schema,
    options.settings,
    options.fieldMappings
  );
}

