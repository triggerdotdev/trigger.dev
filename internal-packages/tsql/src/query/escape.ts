// TypeScript port of posthog/hogql/escape_sql.py
// Keep this file in sync with the Python version

import { QueryError } from "./errors";

/**
 * Character escape maps for ClickHouse string escaping
 * Copied from clickhouse_driver.util.escape
 *
 * Note: In JavaScript, \a and \v are not recognized escape sequences like in Python.
 * We use the actual ASCII codes: \x07 for bell (Python's \a) and \x0B for vertical tab.
 */
const escapeCharsMap: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\r": "\\r",
  "\n": "\\n",
  "\t": "\\t",
  "\0": "\\0",
  "\x07": "\\a", // Bell character (ASCII 7) - Python's \a
  "\x0B": "\\v", // Vertical tab (ASCII 11) - use explicit code since JS \v may not work in all contexts
  "\\": "\\\\",
};

const singlequoteEscapeCharsMap: Record<string, string> = {
  ...escapeCharsMap,
  "'": "\\'",
};

const backquoteEscapeCharsMap: Record<string, string> = {
  ...escapeCharsMap,
  "`": "\\`",
};

/**
 * Sanitize an identifier by removing % characters
 */
export function safeIdentifier(identifier: string): string {
  if (identifier.includes("%")) {
    return identifier.replace(/%/g, "");
  }
  return identifier;
}

/**
 * Escape a string value for use as a parameter in ClickHouse
 * Copied from clickhouse_driver.util.escape_param
 */
export function escapeParamClickhouse(value: string): string {
  const escaped = value
    .split("")
    .map((c) => singlequoteEscapeCharsMap[c] || c)
    .join("");
  return `'${escaped}'`;
}

/**
 * Escape an identifier for use in TSQL/HogQL queries
 * Adapted from clickhouse_driver.util.escape with support for $ in identifiers
 */
export function escapeTSQLIdentifier(identifier: string | number): string {
  if (typeof identifier === "number") {
    // In TSQL we allow integers as identifiers to access array elements
    return String(identifier);
  }

  if (identifier.includes("%")) {
    throw new QueryError(
      `The TSQL identifier "${identifier}" is not permitted as it contains the "%" character`
    );
  }

  // TSQL allows dollars in the identifier (same regex as frontend escapePropertyAsTSQLIdentifier)
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier)) {
    return identifier;
  }

  const escaped = identifier
    .split("")
    .map((c) => backquoteEscapeCharsMap[c] || c)
    .join("");
  return `\`${escaped}\``;
}

/**
 * Escape an identifier for use in ClickHouse queries
 * Copied from clickhouse_driver.util.escape, adapted from single quotes to backquotes
 */
export function escapeClickHouseIdentifier(identifier: string): string {
  if (identifier.includes("%")) {
    throw new QueryError(
      `The identifier "${identifier}" is not permitted as it contains the "%" character`
    );
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return identifier;
  }

  const escaped = identifier
    .split("")
    .map((c) => backquoteEscapeCharsMap[c] || c)
    .join("");
  return `\`${escaped}\``;
}

/**
 * Type for values that can be escaped as SQL strings
 */
export type EscapableValue =
  | null
  | undefined
  | string
  | number
  | boolean
  | Date
  | EscapableValue[]
  | [EscapableValue, ...EscapableValue[]];

/**
 * SQL Value Escaper class that handles different types of values
 * Port of SQLValueEscaper from escape_sql.py
 */
export class SQLValueEscaper {
  private timezone: string;
  private dialect: "tsql" | "clickhouse";

  constructor(options: { timezone?: string; dialect?: "tsql" | "clickhouse" } = {}) {
    this.timezone = options.timezone || "UTC";
    this.dialect = options.dialect || "clickhouse";
  }

  visit(value: EscapableValue): string {
    if (value === null || value === undefined) {
      return this.visitNull();
    }
    if (typeof value === "string") {
      return this.visitString(value);
    }
    if (typeof value === "boolean") {
      return this.visitBoolean(value);
    }
    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        return this.visitInt(value);
      }
      return this.visitFloat(value);
    }
    if (value instanceof Date) {
      return this.visitDateTime(value);
    }
    if (Array.isArray(value)) {
      return this.visitArray(value);
    }

    throw new QueryError(`SQLValueEscaper cannot handle value of type ${typeof value}`);
  }

  private visitNull(): string {
    return "NULL";
  }

  private visitString(value: string): string {
    return escapeParamClickhouse(value);
  }

  private visitBoolean(value: boolean): string {
    if (this.dialect === "clickhouse") {
      return value ? "1" : "0";
    }
    return value ? "true" : "false";
  }

  private visitInt(value: number): string {
    return String(value);
  }

  private visitFloat(value: number): string {
    if (Number.isNaN(value)) {
      return "NaN";
    }
    if (!Number.isFinite(value)) {
      return value < 0 ? "-Inf" : "Inf";
    }
    return String(value);
  }

  private visitDateTime(value: Date): string {
    // Format: YYYY-MM-DD HH:MM:SS.ffffff
    const pad = (n: number, len: number = 2) => String(n).padStart(len, "0");

    const year = value.getUTCFullYear();
    const month = pad(value.getUTCMonth() + 1);
    const day = pad(value.getUTCDate());
    const hours = pad(value.getUTCHours());
    const minutes = pad(value.getUTCMinutes());
    const seconds = pad(value.getUTCSeconds());
    const ms = pad(value.getUTCMilliseconds(), 3);

    const datetimeString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}000`;

    if (this.dialect === "tsql") {
      return `toDateTime(${this.visitString(datetimeString)})`;
    }
    return `toDateTime64(${this.visitString(datetimeString)}, 6, ${this.visitString(this.timezone)})`;
  }

  private visitArray(value: EscapableValue[]): string {
    return `[${value.map((x) => this.visit(x)).join(", ")}]`;
  }
}

/**
 * Escape a value for use in a TSQL/HogQL query string
 */
export function escapeTSQLString(value: EscapableValue, timezone?: string): string {
  return new SQLValueEscaper({ timezone, dialect: "tsql" }).visit(value);
}

/**
 * Escape a value for use in a ClickHouse query string
 */
export function escapeClickHouseString(value: EscapableValue, timezone?: string): string {
  return new SQLValueEscaper({ timezone, dialect: "clickhouse" }).visit(value);
}

/**
 * Get the ClickHouse type string for a value
 * Used when creating parameterized query placeholders like {param: Type}
 */
export function getClickHouseType(value: unknown): string {
  if (value === null || value === undefined) {
    return "Nullable(String)";
  }
  if (typeof value === "string") {
    return "String";
  }
  if (typeof value === "boolean") {
    return "UInt8";
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      // Use Int64 for large integers, Int32 for smaller ones
      if (value > 2147483647 || value < -2147483648) {
        return "Int64";
      }
      return "Int32";
    }
    return "Float64";
  }
  if (value instanceof Date) {
    return "DateTime64(6)";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "Array(String)";
    }
    const itemType = getClickHouseType(value[0]);
    return `Array(${itemType})`;
  }
  // Default to String for unknown types
  return "String";
}

