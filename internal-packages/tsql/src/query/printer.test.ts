import { describe, it, expect, beforeEach } from "vitest";
import { parseTSQLSelect, parseTSQLExpr } from "../index.js";
import { ClickHousePrinter, printToClickHouse, type PrintResult } from "./printer.js";
import { createPrinterContext, PrinterContext } from "./printer_context.js";
import { createSchemaRegistry, column, type TableSchema, type SchemaRegistry } from "./schema.js";
import { QueryError, SyntaxError } from "./errors.js";

/**
 * Test table schemas
 */
const taskRunsSchema: TableSchema = {
  name: "task_runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    id: { name: "id", ...column("String") },
    status: { name: "status", ...column("String") },
    task_identifier: { name: "task_identifier", ...column("String") },
    created_at: { name: "created_at", ...column("DateTime64") },
    updated_at: { name: "updated_at", ...column("DateTime64") },
    started_at: { name: "started_at", ...column("Nullable(DateTime64)") },
    completed_at: { name: "completed_at", ...column("Nullable(DateTime64)") },
    duration_ms: { name: "duration_ms", ...column("Nullable(UInt64)") },
    organization_id: { name: "organization_id", ...column("String") },
    project_id: { name: "project_id", ...column("String") },
    environment_id: { name: "environment_id", ...column("String") },
    queue_name: { name: "queue_name", ...column("String") },
    is_test: { name: "is_test", ...column("UInt8") },
  },
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
};

const taskEventsSchema: TableSchema = {
  name: "task_events",
  clickhouseName: "trigger_dev.task_events_v2",
  columns: {
    id: { name: "id", ...column("String") },
    run_id: { name: "run_id", ...column("String") },
    event_type: { name: "event_type", ...column("String") },
    timestamp: { name: "timestamp", ...column("DateTime64") },
    payload: { name: "payload", ...column("String") },
    organization_id: { name: "organization_id", ...column("String") },
    project_id: { name: "project_id", ...column("String") },
    environment_id: { name: "environment_id", ...column("String") },
  },
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
};

/**
 * Schema with user-friendly names that map to internal ClickHouse names
 */
const runsSchema: TableSchema = {
  name: "runs", // User writes: FROM runs
  clickhouseName: "trigger_dev.task_runs_v2", // ClickHouse sees this
  columns: {
    id: { name: "id", clickhouseName: "run_id", ...column("String") },
    friendly_id: { name: "friendly_id", ...column("String") }, // No mapping
    created: { name: "created", clickhouseName: "created_at", ...column("DateTime64") },
    updated: { name: "updated", clickhouseName: "updated_at", ...column("DateTime64") },
    status: { name: "status", ...column("String") },
    task: { name: "task", clickhouseName: "task_identifier", ...column("String") },
    org_id: { name: "org_id", clickhouseName: "organization_id", ...column("String") },
    proj_id: { name: "proj_id", clickhouseName: "project_id", ...column("String") },
    env_id: { name: "env_id", clickhouseName: "environment_id", ...column("String") },
  },
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
};

/**
 * Helper to create a test context
 */
function createTestContext(
  overrides: Partial<Parameters<typeof createPrinterContext>[0]> = {}
): PrinterContext {
  const schema = createSchemaRegistry([taskRunsSchema, taskEventsSchema]);
  return createPrinterContext({
    schema,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_test123" },
      project_id: { op: "eq", value: "proj_test456" },
      environment_id: { op: "eq", value: "env_test789" },
    },
    ...overrides,
  });
}

/**
 * Helper to print a query and get SQL + params
 */
function printQuery(query: string, context?: PrinterContext) {
  const ast = parseTSQLSelect(query);
  const ctx = context ?? createTestContext();
  return printToClickHouse(ast, ctx);
}

describe("ClickHousePrinter", () => {
  describe("Basic SELECT statements", () => {
    it("should expand SELECT * to individual columns", () => {
      const { sql, params, columns } = printQuery("SELECT * FROM task_runs");

      // SELECT * should be expanded to individual columns
      expect(sql).toContain("SELECT ");
      expect(sql).not.toContain("SELECT *"); // Should NOT contain literal *
      expect(sql).toContain("FROM trigger_dev.task_runs_v2");

      // Should include all columns from the schema
      expect(sql).toContain("id");
      expect(sql).toContain("status");
      expect(sql).toContain("task_identifier");
      expect(sql).toContain("created_at");
      expect(sql).toContain("is_test");

      // Should include tenant guards in WHERE
      expect(sql).toContain("organization_id");
      expect(sql).toContain("project_id");
      expect(sql).toContain("environment_id");

      // Should return column metadata for all expanded columns
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.some((c) => c.name === "id")).toBe(true);
      expect(columns.some((c) => c.name === "status")).toBe(true);
    });

    it("should print SELECT with specific columns", () => {
      const { sql, params } = printQuery("SELECT id, status, created_at FROM task_runs");

      expect(sql).toContain("SELECT id, status, created_at");
      expect(sql).toContain("FROM trigger_dev.task_runs_v2");
    });

    it("should print SELECT DISTINCT", () => {
      const { sql } = printQuery("SELECT DISTINCT status FROM task_runs");

      expect(sql).toContain("SELECT DISTINCT status");
    });

    it("should print SELECT with aliases", () => {
      const { sql } = printQuery("SELECT id AS run_id, status AS run_status FROM task_runs");

      expect(sql).toContain("id AS run_id");
      expect(sql).toContain("status AS run_status");
    });

    it("should expand SELECT * with column name mapping", () => {
      const schema = createSchemaRegistry([runsSchema]);
      const ctx = createPrinterContext({
        schema,
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_test" },
          project_id: { op: "eq", value: "proj_test" },
          environment_id: { op: "eq", value: "env_test" },
        },
      });

      const { sql, columns } = printQuery("SELECT * FROM runs", ctx);

      // Should expand to all columns from runsSchema with proper aliases
      expect(sql).not.toContain("SELECT *");
      // Should have AS clauses for columns with different clickhouseName
      expect(sql).toContain("run_id AS id"); // id -> run_id with alias back to id
      expect(sql).toContain("created_at AS created"); // created -> created_at with alias back
      expect(sql).toContain("status"); // status stays as-is

      // Should return column metadata with user-facing names
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.some((c) => c.name === "id")).toBe(true);
      expect(columns.some((c) => c.name === "created")).toBe(true);
      expect(columns.some((c) => c.name === "status")).toBe(true);
    });

    it("should expand table.* for specific table", () => {
      const { sql, columns } = printQuery("SELECT task_runs.* FROM task_runs");

      // Should expand to all columns from task_runs
      expect(sql).not.toContain("task_runs.*");
      expect(sql).toContain("id");
      expect(sql).toContain("status");

      // Should return column metadata
      expect(columns.length).toBeGreaterThan(0);
    });

    it("should include virtual columns in SELECT * expansion", () => {
      // Schema with virtual columns
      const schemaWithVirtual: TableSchema = {
        name: "runs",
        clickhouseName: "trigger_dev.task_runs_v2",
        columns: {
          id: { name: "id", ...column("String") },
          started_at: { name: "started_at", ...column("Nullable(DateTime64)") },
          completed_at: { name: "completed_at", ...column("Nullable(DateTime64)") },
          // Virtual column with expression
          duration: {
            name: "duration",
            ...column("Nullable(Int64)"),
            expression: "dateDiff('millisecond', started_at, completed_at)",
            description: "Execution duration in ms",
          },
          org_id: { name: "org_id", clickhouseName: "organization_id", ...column("String") },
          proj_id: { name: "proj_id", clickhouseName: "project_id", ...column("String") },
          env_id: { name: "env_id", clickhouseName: "environment_id", ...column("String") },
        },
        tenantColumns: {
          organizationId: "organization_id",
          projectId: "project_id",
          environmentId: "environment_id",
        },
      };

      const schema = createSchemaRegistry([schemaWithVirtual]);
      const ctx = createPrinterContext({
        schema,
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_test" },
          project_id: { op: "eq", value: "proj_test" },
          environment_id: { op: "eq", value: "env_test" },
        },
      });

      const { sql, columns } = printQuery("SELECT * FROM runs", ctx);

      // Should include virtual column with its expression
      expect(sql).toContain("dateDiff('millisecond', started_at, completed_at)");
      expect(sql).toContain("AS duration");

      // Should include regular columns
      expect(sql).toContain("id");

      // Metadata should include the virtual column
      expect(columns.some((c) => c.name === "duration")).toBe(true);
      const durationCol = columns.find((c) => c.name === "duration");
      expect(durationCol?.description).toBe("Execution duration in ms");
    });
  });

  describe("Table and column name mapping", () => {
    function createMappedContext() {
      const schema = createSchemaRegistry([runsSchema]);
    return createPrinterContext({
      schema,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_test" },
        project_id: { op: "eq", value: "proj_test" },
        environment_id: { op: "eq", value: "env_test" },
      },
    });
  }

  it("should map user-friendly table name to ClickHouse name", () => {
      const ctx = createMappedContext();
      const { sql } = printQuery("SELECT * FROM runs", ctx);

      // Table name should be mapped
      expect(sql).toContain("FROM trigger_dev.task_runs_v2");
      expect(sql).not.toContain("FROM runs");
    });

    it("should map user-friendly column names to ClickHouse names", () => {
      const ctx = createMappedContext();
      const { sql } = printQuery("SELECT id, created, status FROM runs", ctx);

      // id -> run_id, created -> created_at, status stays as status
      expect(sql).toContain("run_id");
      expect(sql).toContain("created_at");
      expect(sql).toContain("status");
    });

    it("should map column names in WHERE clause", () => {
      const ctx = createMappedContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE task = 'my-task'", ctx);

      // task -> task_identifier
      expect(sql).toContain("task_identifier");
      expect(sql).not.toMatch(/\btask\b.*=/); // task should not appear as column
    });

    it("should map column names in ORDER BY", () => {
      const ctx = createMappedContext();
      const { sql } = printQuery("SELECT * FROM runs ORDER BY created DESC", ctx);

      // created -> created_at
      expect(sql).toContain("ORDER BY created_at DESC");
    });

    it("should map column names in GROUP BY", () => {
      const ctx = createMappedContext();
      const { sql } = printQuery("SELECT task, count(*) FROM runs GROUP BY task", ctx);

      // task -> task_identifier in both SELECT and GROUP BY
      expect(sql).toContain("task_identifier");
      expect(sql).toContain("GROUP BY task_identifier");
    });

    it("should preserve unmapped column names", () => {
      const ctx = createMappedContext();
      const { sql } = printQuery("SELECT friendly_id, status FROM runs", ctx);

      // friendly_id has no clickhouseName, should stay as-is
      expect(sql).toContain("friendly_id");
      expect(sql).toContain("status");
    });

    it("should handle qualified column references (table.column)", () => {
      const ctx = createMappedContext();
      const { sql } = printQuery("SELECT runs.id, runs.created FROM runs", ctx);

      // Should still map the column names
      expect(sql).toContain("run_id");
      expect(sql).toContain("created_at");
    });

    it("should add AS alias for columns with different clickhouseName to preserve user-facing name in results", () => {
      const ctx = createMappedContext();
      const { sql, columns } = printQuery("SELECT id, created, status FROM runs", ctx);

      // Columns with clickhouseName should be aliased back to user-facing name
      // id -> run_id AS id, created -> created_at AS created
      expect(sql).toContain("run_id AS id");
      expect(sql).toContain("created_at AS created");
      // status has no clickhouseName mapping, should not have alias
      expect(sql).not.toContain("status AS");

      // Column metadata should use user-facing names
      expect(columns.map((c) => c.name)).toEqual(["id", "created", "status"]);
    });

    it("should add AS alias for qualified column references with different clickhouseName", () => {
      const ctx = createMappedContext();
      const { sql, columns } = printQuery("SELECT runs.id, runs.task FROM runs", ctx);

      // Should add aliases to preserve user-facing names
      expect(sql).toContain("run_id AS id");
      expect(sql).toContain("task_identifier AS task");

      // Column metadata should use user-facing names
      expect(columns.map((c) => c.name)).toEqual(["id", "task"]);
    });

    it("should not add redundant alias when user provides explicit AS", () => {
      const ctx = createMappedContext();
      const { sql, columns } = printQuery("SELECT id AS my_id FROM runs", ctx);

      // Should use the clickhouse name with user's explicit alias
      expect(sql).toContain("run_id AS my_id");
      // Should NOT have double aliasing
      expect(sql).not.toContain("run_id AS id AS my_id");

      // Column metadata should use the explicit alias
      expect(columns.map((c) => c.name)).toEqual(["my_id"]);
    });
  });

  describe("WHERE clauses", () => {
    it("should print WHERE with equality comparison", () => {
      const { sql, params } = printQuery("SELECT * FROM task_runs WHERE status = 'completed'");

      expect(sql).toContain("WHERE");
      expect(sql).toContain("equals(");
      // Value should be parameterized
      expect(Object.values(params)).toContain("completed");
    });

    it("should print WHERE with multiple conditions", () => {
      const { sql } = printQuery(
        "SELECT * FROM task_runs WHERE status = 'completed' AND is_test = 0"
      );

      expect(sql).toContain("and(");
      expect(sql).toContain("equals(");
    });

    it("should print WHERE with OR conditions", () => {
      const { sql } = printQuery(
        "SELECT * FROM task_runs WHERE status = 'completed' OR status = 'failed'"
      );

      expect(sql).toContain("or(");
    });

    it("should print WHERE with NOT", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE NOT status = 'pending'");

      expect(sql).toContain("not(");
    });

    it("should print WHERE with BETWEEN", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE duration_ms BETWEEN 100 AND 1000");

      expect(sql).toContain("BETWEEN");
    });

    it("should print WHERE with IN", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE status IN ('completed', 'failed')");

      expect(sql).toContain("in(");
    });

    it("should print WHERE with NOT IN", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE status NOT IN ('pending')");

      expect(sql).toContain("notIn(");
    });

    it("should print WHERE with LIKE", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE task_identifier LIKE 'email%'");

      expect(sql).toContain("like(");
    });

    it("should print WHERE with ILIKE", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE task_identifier ILIKE '%Email%'");

      expect(sql).toContain("ilike(");
    });

    it("should handle NULL comparisons", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE started_at = NULL");

      expect(sql).toContain("isNull(");
    });

    it("should handle != NULL comparisons", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE started_at != NULL");

      expect(sql).toContain("isNotNull(");
    });

    it("should handle IS NULL syntax", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE started_at IS NULL");

      expect(sql).toContain("isNull(started_at)");
    });

    it("should handle IS NOT NULL syntax", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE started_at IS NOT NULL");

      expect(sql).toContain("isNotNull(started_at)");
    });
  });

  describe("nullValue transformation for JSON columns", () => {
    // Create a schema with JSON columns that have nullValue set
    const jsonSchema: TableSchema = {
      name: "runs",
      clickhouseName: "trigger_dev.task_runs_v2",
      columns: {
        id: { name: "id", ...column("String") },
        error: {
          name: "error",
          ...column("JSON"),
          nullValue: "'{}'", // Empty object represents NULL
        },
        output: {
          name: "output",
          ...column("JSON"),
          nullValue: "'{}'", // Empty object represents NULL
        },
        status: { name: "status", ...column("String") },
        organization_id: { name: "organization_id", ...column("String") },
        project_id: { name: "project_id", ...column("String") },
        environment_id: { name: "environment_id", ...column("String") },
      },
      tenantColumns: {
        organizationId: "organization_id",
        projectId: "project_id",
        environmentId: "environment_id",
      },
    };

    function createJsonContext() {
      const schema = createSchemaRegistry([jsonSchema]);
    return createPrinterContext({
      schema,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_test" },
        project_id: { op: "eq", value: "proj_test" },
        environment_id: { op: "eq", value: "env_test" },
      },
    });
  }

  it("should transform IS NULL to equals empty object for JSON columns with nullValue", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE error IS NULL", ctx);

      // Should use equals with '{}' instead of isNull
      expect(sql).toContain("equals(error, '{}')");
      expect(sql).not.toContain("isNull(error)");
    });

    it("should transform IS NOT NULL to notEquals empty object for JSON columns with nullValue", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE error IS NOT NULL", ctx);

      // Should use notEquals with '{}' instead of isNotNull
      expect(sql).toContain("notEquals(error, '{}')");
      expect(sql).not.toContain("isNotNull(error)");
    });

    it("should transform = NULL to equals empty object for JSON columns with nullValue", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE error = NULL", ctx);

      expect(sql).toContain("equals(error, '{}')");
      expect(sql).not.toContain("isNull(error)");
    });

    it("should transform != NULL to notEquals empty object for JSON columns with nullValue", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE error != NULL", ctx);

      expect(sql).toContain("notEquals(error, '{}')");
      expect(sql).not.toContain("isNotNull(error)");
    });

    it("should not affect regular columns without nullValue", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE status IS NULL", ctx);

      // Regular column should still use isNull
      expect(sql).toContain("isNull(status)");
    });

    it("should work with multiple JSON column NULL checks", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery(
        "SELECT * FROM runs WHERE error IS NOT NULL AND output IS NULL",
        ctx
      );

      expect(sql).toContain("notEquals(error, '{}')");
      expect(sql).toContain("equals(output, '{}')");
    });

    it("should allow GROUP BY on JSON columns without error", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery(
        "SELECT error, count() AS error_count FROM runs WHERE error IS NOT NULL GROUP BY error",
        ctx
      );

      // Should filter with notEquals
      expect(sql).toContain("notEquals(error, '{}')");
      // Should group by the raw column
      expect(sql).toContain("GROUP BY error");
    });

    it("should cast JSON subfield to String with underscore alias in SELECT and GROUP BY", () => {
      const ctx = createJsonContext();
      const { sql, columns } = printQuery(
        "SELECT error.data.name, count() AS error_count FROM runs GROUP BY error.data.name",
        ctx
      );

      // SELECT should use .:String type hint with underscore alias
      expect(sql).toContain("error.data.name.:String AS error_data_name");
      // GROUP BY should use .:String type hint (no alias needed)
      expect(sql).toContain("GROUP BY error.data.name.:String");

      // Column metadata should have the underscore alias name
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "error_data_name", type: "String" })
      );
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "error_count", type: "UInt64" })
      );
    });

    it("should cast JSON subfield to String with multiple fields and underscore aliases", () => {
      const ctx = createJsonContext();
      const { sql, columns } = printQuery(
        "SELECT error.name, error.message, count() AS cnt FROM runs GROUP BY error.name, error.message",
        ctx
      );

      // SELECT should have type hints with underscore aliases
      expect(sql).toContain("error.name.:String AS error_name");
      expect(sql).toContain("error.message.:String AS error_message");
      // GROUP BY should have type hints
      expect(sql).toContain("GROUP BY error.name.:String, error.message.:String");

      // Column metadata should have correct names
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "error_name", type: "String" })
      );
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "error_message", type: "String" })
      );
    });

    it("should not cast non-JSON columns in GROUP BY", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery("SELECT status, count() AS cnt FROM runs GROUP BY status", ctx);

      // Regular columns should not have type hints
      expect(sql).toContain("GROUP BY status");
      expect(sql).not.toContain(".:String");
    });

    it("should NOT add .:String type hint for JSON subfield in WHERE comparison", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery(
        "SELECT id FROM runs WHERE error.data.name = 'test'",
        ctx
      );

      // WHERE clause should NOT have .:String type hint (it breaks the query)
      expect(sql).toContain("equals(error.data.name,");
      expect(sql).not.toContain("error.data.name.:String");
    });

    it("should NOT add .:String for JSON subfield in WHERE with LIKE", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery(
        "SELECT id FROM runs WHERE error.message LIKE '%error%'",
        ctx
      );

      // WHERE clause should NOT have .:String type hint
      expect(sql).toContain("like(error.message,");
      expect(sql).not.toContain("error.message.:String");
    });

    it("should NOT add .:String in SELECT or WHERE when no GROUP BY", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery(
        "SELECT error.data.name FROM runs WHERE error.data.name = 'test'",
        ctx
      );

      // SELECT should NOT have .:String (no GROUP BY, so no need for type hint)
      expect(sql).toContain("error.data.name AS error_data_name");
      expect(sql).not.toContain(".:String");
      // WHERE should NOT have .:String
      expect(sql).toContain("equals(error.data.name,");
    });

    it("should add .:String in GROUP BY but not in WHERE for same query", () => {
      const ctx = createJsonContext();
      const { sql } = printQuery(
        "SELECT error.data.name, count() AS cnt FROM runs WHERE error.data.name = 'test' GROUP BY error.data.name",
        ctx
      );

      // SELECT should have .:String
      expect(sql).toContain("error.data.name.:String AS error_data_name");
      // GROUP BY should have .:String
      expect(sql).toContain("GROUP BY error.data.name.:String");
      // WHERE should NOT have .:String
      expect(sql).toContain("equals(error.data.name,");
      expect(sql).not.toMatch(/equals\(error\.data\.name\.:String/);
    });
  });

  describe("textColumn optimization for JSON columns", () => {
    // Create a schema with JSON columns that have textColumn set
    const textColumnSchema: TableSchema = {
      name: "runs",
      clickhouseName: "trigger_dev.task_runs_v2",
      columns: {
        id: { name: "id", ...column("String") },
        output: {
          name: "output",
          ...column("JSON"),
          nullValue: "'{}'",
          textColumn: "output_text",
        },
        error: {
          name: "error",
          ...column("JSON"),
          nullValue: "'{}'",
          textColumn: "error_text",
        },
        status: { name: "status", ...column("String") },
        organization_id: { name: "organization_id", ...column("String") },
        project_id: { name: "project_id", ...column("String") },
        environment_id: { name: "environment_id", ...column("String") },
      },
      tenantColumns: {
        organizationId: "organization_id",
        projectId: "project_id",
        environmentId: "environment_id",
      },
    };

    function createTextColumnContext() {
      const schema = createSchemaRegistry([textColumnSchema]);
    return createPrinterContext({
      schema,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_test" },
        project_id: { op: "eq", value: "proj_test" },
        environment_id: { op: "eq", value: "env_test" },
      },
    });
  }

  describe("SELECT clause", () => {
    it("should use text column when selecting bare JSON column", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT output FROM runs", ctx);

        // Should use the text column with an alias to preserve the column name
        expect(sql).toContain("output_text AS output");
      });

      it("should use text column for multiple JSON columns", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT output, error FROM runs", ctx);

        expect(sql).toContain("output_text AS output");
        expect(sql).toContain("error_text AS error");
      });

      it("should use JSON column for subfield access without .:String when no GROUP BY", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT output.data.name FROM runs", ctx);

        // Should use the original JSON column without .:String (no GROUP BY)
        expect(sql).toContain("output.data.name AS output_data_name");
        expect(sql).not.toContain("output_text");
        expect(sql).not.toContain(".:String");
      });
    });

    describe("SELECT * expansion", () => {
      it("should use text columns when expanding SELECT *", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT * FROM runs", ctx);

        // Should use text columns for JSON columns
        expect(sql).toContain("output_text AS output");
        expect(sql).toContain("error_text AS error");
      });
    });

    describe("WHERE clause", () => {
      it("should use text column for exact equality comparison", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT id FROM runs WHERE output = '{}'", ctx);

        expect(sql).toContain("equals(output_text,");
        expect(sql).not.toMatch(/equals\(output,/);
      });

      it("should use text column for inequality comparison", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT id FROM runs WHERE output != '{}'", ctx);

        expect(sql).toContain("notEquals(output_text,");
      });

      it("should use text column for LIKE comparison", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT id FROM runs WHERE output LIKE '%error%'", ctx);

        expect(sql).toContain("like(output_text,");
        expect(sql).not.toMatch(/like\(output,/);
      });

      it("should use text column for ILIKE comparison", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT id FROM runs WHERE error ILIKE '%failed%'", ctx);

        expect(sql).toContain("ilike(error_text,");
      });

      it("should use text column for NOT LIKE comparison", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT id FROM runs WHERE output NOT LIKE '%test%'", ctx);

        expect(sql).toContain("notLike(output_text,");
      });

      it("should use JSON column for subfield comparison without .:String", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery(
          "SELECT id FROM runs WHERE output.data.name = 'test'",
          ctx
        );

        // Should use the original JSON column, not the text column
        // And should NOT have .:String in WHERE (breaks the query)
        expect(sql).toContain("equals(output.data.name,");
        expect(sql).not.toContain("output_text");
        expect(sql).not.toContain("output.data.name.:String");
      });

      it("should still use nullValue transformation for IS NULL", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT id FROM runs WHERE output IS NULL", ctx);

        // NULL check should use the text column with nullValue
        expect(sql).toContain("equals(output_text, '{}')");
      });

      it("should still use nullValue transformation for IS NOT NULL", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT id FROM runs WHERE error IS NOT NULL", ctx);

        expect(sql).toContain("notEquals(error_text, '{}')");
      });
    });

    describe("edge cases", () => {
      it("should work with columns without textColumn defined", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT status FROM runs WHERE status = 'completed'", ctx);

        // Regular column should work as before
        expect(sql).toContain("status");
        expect(sql).not.toContain("status_text");
      });

      it("should use text column for aliased JSON columns in SELECT", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT output AS result FROM runs", ctx);

        // Should use text column with user's alias
        expect(sql).toContain("output_text AS result");
      });

      it("should use text column for table-qualified JSON columns in SELECT", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery("SELECT runs.output FROM runs", ctx);

        // Should use text column
        expect(sql).toContain("output_text AS output");
      });

      it("should use text column in both SELECT and WHERE for same query", () => {
        const ctx = createTextColumnContext();
        const { sql } = printQuery(
          "SELECT output FROM runs WHERE output LIKE '%test%'",
          ctx
        );

        // SELECT should use text column
        expect(sql).toContain("output_text AS output");
        // WHERE should use text column
        expect(sql).toContain("like(output_text,");
      });
    });

    describe("JOINs with textColumn", () => {
      // Create a second schema with the same JSON column names to test JOIN ambiguity
      const runsSchemaWithTextColumn: TableSchema = {
        name: "runs",
        clickhouseName: "trigger_dev.task_runs_v2",
        columns: {
          id: { name: "id", ...column("String") },
          output: {
            name: "output",
            ...column("JSON"),
            nullValue: "'{}'",
            textColumn: "output_text",
          },
          organization_id: { name: "organization_id", ...column("String") },
          project_id: { name: "project_id", ...column("String") },
          environment_id: { name: "environment_id", ...column("String") },
        },
        tenantColumns: {
          organizationId: "organization_id",
          projectId: "project_id",
          environmentId: "environment_id",
        },
      };

      const eventsSchemaWithTextColumn: TableSchema = {
        name: "events",
        clickhouseName: "trigger_dev.task_events_v2",
        columns: {
          id: { name: "id", ...column("String") },
          run_id: { name: "run_id", ...column("String") },
          output: {
            name: "output",
            ...column("JSON"),
            nullValue: "'{}'",
            textColumn: "output_text",
          },
          organization_id: { name: "organization_id", ...column("String") },
          project_id: { name: "project_id", ...column("String") },
          environment_id: { name: "environment_id", ...column("String") },
        },
        tenantColumns: {
          organizationId: "organization_id",
          projectId: "project_id",
          environmentId: "environment_id",
        },
      };

      function createJoinTextColumnContext() {
        const schema = createSchemaRegistry([runsSchemaWithTextColumn, eventsSchemaWithTextColumn]);
        return createPrinterContext({
          schema,
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_test" },
            project_id: { op: "eq", value: "proj_test" },
            environment_id: { op: "eq", value: "env_test" },
          },
        });
      }

      it("should qualify text column with table alias in JOIN WHERE clause to avoid ambiguity", () => {
        const ctx = createJoinTextColumnContext();
        const { sql } = printQuery(
          `SELECT r.id FROM runs r JOIN events e ON r.id = e.run_id WHERE r.output = '{}'`,
          ctx
        );

        // The text column should be table-qualified to avoid ambiguity
        // since both tables have an output_text column
        expect(sql).toContain("equals(r.output_text,");
        // Should NOT have unqualified output_text in the comparison
        expect(sql).not.toMatch(/equals\(output_text,/);
      });

      it("should qualify text column with table alias for LIKE in JOIN", () => {
        const ctx = createJoinTextColumnContext();
        const { sql } = printQuery(
          `SELECT r.id FROM runs r JOIN events e ON r.id = e.run_id WHERE e.output LIKE '%error%'`,
          ctx
        );

        // Should use table-qualified text column
        expect(sql).toContain("like(e.output_text,");
        expect(sql).not.toMatch(/like\(output_text,/);
      });

      it("should handle multiple qualified text column comparisons in JOIN", () => {
        const ctx = createJoinTextColumnContext();
        const { sql } = printQuery(
          `SELECT r.id FROM runs r JOIN events e ON r.id = e.run_id WHERE r.output = '{}' AND e.output != '{}'`,
          ctx
        );

        // Both comparisons should be table-qualified
        expect(sql).toContain("equals(r.output_text,");
        expect(sql).toContain("notEquals(e.output_text,");
      });
    });
  });

  describe("dataPrefix for JSON columns", () => {
    // Create a schema with JSON columns that have dataPrefix set
    const dataPrefixSchema: TableSchema = {
      name: "runs",
      clickhouseName: "trigger_dev.task_runs_v2",
      columns: {
        id: { name: "id", ...column("String") },
        output: {
          name: "output",
          ...column("JSON"),
          nullValue: "'{}'",
          dataPrefix: "data",
        },
        error: {
          name: "error",
          ...column("JSON"),
          nullValue: "'{}'",
          dataPrefix: "data",
        },
        status: { name: "status", ...column("String") },
        organization_id: { name: "organization_id", ...column("String") },
        project_id: { name: "project_id", ...column("String") },
        environment_id: { name: "environment_id", ...column("String") },
      },
      tenantColumns: {
        organizationId: "organization_id",
        projectId: "project_id",
        environmentId: "environment_id",
      },
    };

    function createDataPrefixContext() {
      const schema = createSchemaRegistry([dataPrefixSchema]);
    return createPrinterContext({
      schema,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_test" },
        project_id: { op: "eq", value: "proj_test" },
        environment_id: { op: "eq", value: "env_test" },
      },
    });
  }

  describe("SELECT clause", () => {
    it("should inject dataPrefix into JSON subfield path", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery("SELECT output.message FROM runs", ctx);

        // Should transform output.message to output.data.message
        expect(sql).toContain("output.data.message");
      });

      it("should generate clean alias without dataPrefix", () => {
        const ctx = createDataPrefixContext();
        const { sql, columns } = printQuery("SELECT output.message FROM runs", ctx);

        // Alias should be output_message, not output_data_message
        expect(sql).toContain("AS output_message");
        expect(sql).not.toContain("AS output_data_message");
        expect(columns).toContainEqual(
          expect.objectContaining({ name: "output_message" })
        );
      });

      it("should handle nested paths with dataPrefix", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery("SELECT output.user.name FROM runs", ctx);

        // Should transform output.user.name to output.data.user.name
        expect(sql).toContain("output.data.user.name");
        // Alias should be output_user_name
        expect(sql).toContain("AS output_user_name");
      });

      it("should work with multiple JSON columns with dataPrefix", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery("SELECT output.msg, error.code FROM runs", ctx);

        expect(sql).toContain("output.data.msg");
        expect(sql).toContain("error.data.code");
        expect(sql).toContain("AS output_msg");
        expect(sql).toContain("AS error_code");
      });

      it("should not affect bare JSON column selection", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery("SELECT output FROM runs", ctx);

        // Bare column should not have dataPrefix injected
        expect(sql).not.toContain("output.data");
        expect(sql).toMatch(/SELECT\s+output[\s,]/);
      });
    });

    describe("WHERE clause", () => {
      it("should inject dataPrefix into WHERE comparison", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery(
          "SELECT id FROM runs WHERE output.status = 'success'",
          ctx
        );

        // Should transform output.status to output.data.status
        expect(sql).toContain("output.data.status");
      });

      it("should inject dataPrefix into LIKE comparison", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery(
          "SELECT id FROM runs WHERE error.message LIKE '%failed%'",
          ctx
        );

        expect(sql).toContain("error.data.message");
      });
    });

    describe("GROUP BY clause", () => {
      it("should inject dataPrefix into GROUP BY", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery(
          "SELECT output.type, count() AS cnt FROM runs GROUP BY output.type",
          ctx
        );

        // Should inject dataPrefix in both SELECT and GROUP BY
        expect(sql).toContain("output.data.type");
        expect(sql).toContain("GROUP BY output.data.type");
      });
    });

    describe("edge cases", () => {
      it("should not affect columns without dataPrefix", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery("SELECT status FROM runs", ctx);

        // Regular column should not be affected
        expect(sql).toContain("status");
        expect(sql).not.toContain("status.data");
      });

      it("should work with explicit alias on JSON subfield", () => {
        const ctx = createDataPrefixContext();
        const { sql } = printQuery("SELECT output.message AS msg FROM runs", ctx);

        // Should inject dataPrefix but use user's alias
        expect(sql).toContain("output.data.message");
        expect(sql).toContain("AS msg");
      });
    });
  });

  describe("ORDER BY clauses", () => {
    it("should print ORDER BY ASC", () => {
      const { sql } = printQuery("SELECT * FROM task_runs ORDER BY created_at ASC");

      expect(sql).toContain("ORDER BY created_at ASC");
    });

    it("should print ORDER BY DESC", () => {
      const { sql } = printQuery("SELECT * FROM task_runs ORDER BY created_at DESC");

      expect(sql).toContain("ORDER BY created_at DESC");
    });

    it("should print ORDER BY with multiple columns", () => {
      const { sql } = printQuery("SELECT * FROM task_runs ORDER BY status ASC, created_at DESC");

      expect(sql).toContain("ORDER BY status ASC, created_at DESC");
    });
  });

  describe("LIMIT and OFFSET", () => {
    it("should print LIMIT", () => {
      const { sql } = printQuery("SELECT * FROM task_runs LIMIT 10");

      expect(sql).toContain("LIMIT 10");
    });

    it("should print LIMIT with OFFSET", () => {
      const { sql } = printQuery("SELECT * FROM task_runs LIMIT 10 OFFSET 20");

      expect(sql).toContain("LIMIT 10");
      expect(sql).toContain("OFFSET 20");
    });

    it("should cap LIMIT to maxRows setting", () => {
      const context = createTestContext({ settings: { maxRows: 100 } });
      const { sql } = printQuery("SELECT * FROM task_runs LIMIT 1000", context);

      expect(sql).toContain("LIMIT 100");
    });

    it("should add default LIMIT when none specified", () => {
      const context = createTestContext({ settings: { maxRows: 10000 } });
      const { sql } = printQuery("SELECT * FROM task_runs", context);

      expect(sql).toContain("LIMIT 10000");
    });
  });

  describe("GROUP BY clauses", () => {
    it("should print GROUP BY", () => {
      const { sql } = printQuery("SELECT status, count(*) FROM task_runs GROUP BY status");

      expect(sql).toContain("GROUP BY status");
    });

    it("should print GROUP BY with multiple columns", () => {
      const { sql } = printQuery(
        "SELECT status, queue_name, count(*) FROM task_runs GROUP BY status, queue_name"
      );

      expect(sql).toContain("GROUP BY status, queue_name");
    });

    it("should print GROUP BY with HAVING", () => {
      const { sql } = printQuery(
        "SELECT status, count(*) as cnt FROM task_runs GROUP BY status HAVING cnt > 10"
      );

      expect(sql).toContain("GROUP BY status");
      expect(sql).toContain("HAVING");
      expect(sql).toContain("greater(");
    });
  });

  describe("Aggregate functions", () => {
    it("should print COUNT", () => {
      const { sql } = printQuery("SELECT count(*) FROM task_runs");

      expect(sql).toContain("count(*)");
    });

    it("should print COUNT DISTINCT", () => {
      const { sql } = printQuery("SELECT count(DISTINCT status) FROM task_runs");

      expect(sql).toContain("count(DISTINCT status)");
    });

    it("should print SUM", () => {
      const { sql } = printQuery("SELECT sum(duration_ms) FROM task_runs");

      expect(sql).toContain("sum(duration_ms)");
    });

    it("should print AVG", () => {
      const { sql } = printQuery("SELECT avg(duration_ms) FROM task_runs");

      expect(sql).toContain("avg(duration_ms)");
    });

    it("should print MIN and MAX", () => {
      const { sql } = printQuery("SELECT min(created_at), max(created_at) FROM task_runs");

      expect(sql).toContain("min(created_at)");
      expect(sql).toContain("max(created_at)");
    });
  });

  describe("Arithmetic operations", () => {
    it("should print addition", () => {
      const { sql } = printQuery("SELECT duration_ms + 100 FROM task_runs");

      expect(sql).toContain("plus(duration_ms, 100)");
    });

    it("should print subtraction", () => {
      const { sql } = printQuery("SELECT duration_ms - 100 FROM task_runs");

      expect(sql).toContain("minus(duration_ms, 100)");
    });

    it("should print multiplication", () => {
      const { sql } = printQuery("SELECT duration_ms * 2 FROM task_runs");

      expect(sql).toContain("multiply(duration_ms, 2)");
    });

    it("should print division", () => {
      const { sql } = printQuery("SELECT duration_ms / 1000 FROM task_runs");

      expect(sql).toContain("divide(duration_ms, 1000)");
    });

    it("should print modulo", () => {
      const { sql } = printQuery("SELECT duration_ms % 60 FROM task_runs");

      expect(sql).toContain("modulo(duration_ms, 60)");
    });
  });

  describe("Tenant isolation", () => {
    it("should inject tenant guards for single table", () => {
      const context = createTestContext({
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_abc" },
          project_id: { op: "eq", value: "proj_def" },
          environment_id: { op: "eq", value: "env_ghi" },
        },
      });
      const { sql, params } = printQuery("SELECT * FROM task_runs", context);

      // Should have WHERE clause with tenant columns
      expect(sql).toContain("WHERE");
      expect(sql).toContain("organization_id");
      expect(sql).toContain("project_id");
      expect(sql).toContain("environment_id");

      // Values should be parameterized
      expect(Object.values(params)).toContain("org_abc");
      expect(Object.values(params)).toContain("proj_def");
      expect(Object.values(params)).toContain("env_ghi");
    });

    it("should combine tenant guards with user WHERE clause", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE status = 'completed'");

      // Should have both tenant guard AND user condition
      expect(sql).toContain("and(");
      expect(sql).toContain("organization_id");
      expect(sql).toContain("equals(");
    });
  });

  describe("SQL injection prevention", () => {
    it("should parameterize string values", () => {
      const { sql, params } = printQuery(
        "SELECT * FROM task_runs WHERE status = 'DROP TABLE users'"
      );

      // The malicious string should be in params, not in SQL
      expect(sql).not.toContain("DROP TABLE");
      expect(Object.values(params)).toContain("DROP TABLE users");
    });

    it("should safely handle identifiers with special characters", () => {
      // This should either escape or reject
      expect(() => {
        printQuery("SELECT * FROM task_runs WHERE `weird`column` = 'test'");
      }).toThrow();
    });

    it("should only allow tables defined in schema", () => {
      // Users cannot query arbitrary tables - only those in the schema
      expect(() => {
        printQuery("SELECT * FROM system_tables");
      }).toThrow();

      expect(() => {
        printQuery("SELECT * FROM unknown_table");
      }).toThrow();
    });

    it("should parameterize numeric values inline", () => {
      const { sql, params } = printQuery("SELECT * FROM task_runs WHERE duration_ms > 1000");

      // Numbers can be inlined safely
      expect(sql).toContain("1000");
    });

    it("should handle boolean values safely", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE is_test = 1");

      expect(sql).toContain("equals(is_test, 1)");
    });
  });

  describe("Subqueries", () => {
    it("should print subquery in FROM clause", () => {
      const { sql } = printQuery(`
        SELECT status, cnt
        FROM (
          SELECT status, count(*) as cnt
          FROM task_runs
          GROUP BY status
        )
      `);

      expect(sql).toContain("SELECT status, cnt");
      expect(sql).toContain("FROM (");
      expect(sql).toContain("count(*)");
    });

    it("should print subquery in WHERE clause", () => {
      const { sql } = printQuery(`
        SELECT * FROM task_runs
        WHERE id IN (SELECT run_id FROM task_events WHERE event_type = 'completed')
      `);

      expect(sql).toContain("in(id,");
      expect(sql).toContain("SELECT run_id FROM");
    });
  });

  describe("UNION queries", () => {
    it("should print UNION ALL", () => {
      const { sql } = printQuery(`
        SELECT id, status FROM task_runs WHERE status = 'completed'
        UNION ALL
        SELECT id, status FROM task_runs WHERE status = 'failed'
      `);

      expect(sql).toContain("UNION ALL");
    });
  });

  describe("Window functions", () => {
    it("should print ROW_NUMBER", () => {
      const { sql } = printQuery(`
        SELECT id, status, row_number() OVER (PARTITION BY status ORDER BY created_at DESC) as rn
        FROM task_runs
      `);

      expect(sql).toContain("row_number()");
      expect(sql).toContain("OVER (");
      expect(sql).toContain("PARTITION BY status");
      expect(sql).toContain("ORDER BY created_at DESC");
    });
  });

  describe("Functions", () => {
    it("should print toDateTime with column argument", () => {
      const { sql } = printQuery("SELECT toDateTime(created_at) FROM task_runs");

      expect(sql).toContain("toDateTime(created_at)");
    });

    it("should print toDateTime with string and timezone arguments", () => {
      const { sql, params } = printQuery(
        "SELECT toDateTime('2024-01-15 10:30:00', 'UTC') FROM task_runs"
      );

      // String values are parameterized for security
      expect(sql).toContain("toDateTime(");
      expect(sql).toMatch(/toDateTime\(\{tsql_val_\d+: String\}, \{tsql_val_\d+: String\}\)/);
      expect(Object.values(params)).toContain("2024-01-15 10:30:00");
      expect(Object.values(params)).toContain("UTC");
    });

    it("should print toDateTime with timezone containing special characters", () => {
      const { sql, params } = printQuery(
        "SELECT toDateTime('2024-01-15 10:30:00', 'America/New_York') FROM task_runs"
      );

      // String values are parameterized for security
      expect(sql).toContain("toDateTime(");
      expect(sql).toMatch(/toDateTime\(\{tsql_val_\d+: String\}, \{tsql_val_\d+: String\}\)/);
      expect(Object.values(params)).toContain("2024-01-15 10:30:00");
      expect(Object.values(params)).toContain("America/New_York");
    });

    it("should print toDateTime64 with precision and timezone", () => {
      const { sql, params } = printQuery(
        "SELECT toDateTime64('2024-01-15 10:30:00.500000', 6, 'Europe/London') FROM task_runs"
      );

      // String values are parameterized, but numeric precision is inline
      expect(sql).toContain("toDateTime64(");
      expect(sql).toMatch(/toDateTime64\(\{tsql_val_\d+: String\}, 6, \{tsql_val_\d+: String\}\)/);
      expect(Object.values(params)).toContain("2024-01-15 10:30:00.500000");
      expect(Object.values(params)).toContain("Europe/London");
    });

    it("should print now()", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE created_at > now()");

      expect(sql).toContain("now()");
    });

    it("should print string functions", () => {
      const { sql } = printQuery("SELECT lower(status), upper(queue_name) FROM task_runs");

      expect(sql).toContain("lower(status)");
      expect(sql).toContain("upper(queue_name)");
    });

    it("should print conditional functions", () => {
      const { sql } = printQuery("SELECT if(is_test = 1, 'test', 'prod') FROM task_runs");

      expect(sql).toContain("if(");
    });

    it("should print coalesce", () => {
      const { sql } = printQuery("SELECT coalesce(started_at, created_at) FROM task_runs");

      expect(sql).toContain("coalesce(started_at, created_at)");
    });
  });

  describe("Arrays and tuples", () => {
    it("should print array literals", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE status IN ['completed', 'failed']");

      expect(sql).toContain("[");
      expect(sql).toContain("]");
    });

    it("should print tuple", () => {
      const { sql } = printQuery("SELECT tuple(id, status) FROM task_runs");

      expect(sql).toContain("tuple(id, status)");
    });
  });

  describe("Error handling", () => {
    it("should throw QueryError for unknown tables", () => {
      expect(() => {
        printQuery("SELECT * FROM unknown_table");
      }).toThrow(QueryError);
    });

    it("should throw QueryError for unknown functions", () => {
      expect(() => {
        printQuery("SELECT unknown_function(id) FROM task_runs");
      }).toThrow(QueryError);
    });

    it("should throw QueryError for nested aggregations", () => {
      expect(() => {
        printQuery("SELECT sum(count(*)) FROM task_runs");
      }).toThrow(QueryError);
    });

    it("should throw SyntaxError for malformed queries", () => {
      expect(() => {
        parseTSQLSelect("SELECT * FORM task_runs"); // typo: FORM instead of FROM
      }).toThrow();
    });
  });

  describe("Pretty printing", () => {
    it("should format SQL with newlines when pretty=true", () => {
      const ast = parseTSQLSelect(
        "SELECT id, status FROM task_runs WHERE status = 'completed' ORDER BY created_at"
      );
      const context = createTestContext();
      const printer = new ClickHousePrinter(context, { pretty: true });
      const { sql } = printer.print(ast);

      expect(sql).toContain("\n");
    });

    it("should produce single-line SQL when pretty=false", () => {
      const ast = parseTSQLSelect(
        "SELECT id, status FROM task_runs WHERE status = 'completed' ORDER BY created_at"
      );
      const context = createTestContext();
      const printer = new ClickHousePrinter(context, { pretty: false });
      const { sql } = printer.print(ast);

      // Count newlines - there should be very few or none in the main query structure
      const newlineCount = (sql.match(/\n/g) || []).length;
      expect(newlineCount).toBeLessThan(3);
    });
  });

  describe("Parameter generation", () => {
    it("should generate unique parameter names", () => {
      const { params } = printQuery(`
        SELECT * FROM task_runs
        WHERE status = 'completed' AND queue_name = 'email' AND task_identifier = 'send'
      `);

      // Should have multiple unique parameter keys
      const keys = Object.keys(params);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("should include correct types in placeholders", () => {
      const { sql, params } = printQuery("SELECT * FROM task_runs WHERE status = 'test'");

      // Should have String type in placeholder
      expect(sql).toMatch(/\{tsql_val_\d+: String\}/);
    });
  });
});

describe("Value mapping (valueMap)", () => {
  /**
   * Schema with valueMap for status column
   */
  const statusMappedSchema: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      id: { name: "id", ...column("String") },
      status: {
        name: "status",
        ...column("String"),
        valueMap: {
          COMPLETED_SUCCESSFULLY: "Completed",
          COMPLETED_WITH_ERRORS: "Completed with errors",
          SYSTEM_FAILURE: "System failure",
          PENDING: "Pending",
          EXECUTING: "Running",
          FAILED: "Failed",
        },
      },
      organization_id: { name: "organization_id", ...column("String") },
      project_id: { name: "project_id", ...column("String") },
      environment_id: { name: "environment_id", ...column("String") },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  function createValueMapContext() {
    const schema = createSchemaRegistry([statusMappedSchema]);
  return createPrinterContext({
    schema,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_test" },
      project_id: { op: "eq", value: "proj_test" },
      environment_id: { op: "eq", value: "env_test" },
    },
  });
}

it("should transform user-friendly value to internal value in equality comparison", () => {
    const ctx = createValueMapContext();
    const { sql, params } = printQuery("SELECT * FROM runs WHERE status = 'Completed'", ctx);

    // The user-friendly value "Completed" should be transformed to "COMPLETED_SUCCESSFULLY"
    expect(Object.values(params)).toContain("COMPLETED_SUCCESSFULLY");
    expect(Object.values(params)).not.toContain("Completed");
  });

  it("should transform user-friendly values in IN clause", () => {
    const ctx = createValueMapContext();
    const { sql, params } = printQuery(
      "SELECT * FROM runs WHERE status IN ('Completed', 'Failed', 'Running')",
      ctx
    );

    // All user-friendly values should be transformed
    expect(Object.values(params)).toContain("COMPLETED_SUCCESSFULLY");
    expect(Object.values(params)).toContain("FAILED");
    expect(Object.values(params)).toContain("EXECUTING");
    expect(Object.values(params)).not.toContain("Completed");
    expect(Object.values(params)).not.toContain("Failed");
    expect(Object.values(params)).not.toContain("Running");
  });

  it("should handle case-insensitive value matching", () => {
    const ctx = createValueMapContext();
    const { params: params1 } = printQuery("SELECT * FROM runs WHERE status = 'completed'", ctx);
    const { params: params2 } = printQuery("SELECT * FROM runs WHERE status = 'COMPLETED'", ctx);
    const { params: params3 } = printQuery("SELECT * FROM runs WHERE status = 'Completed'", ctx);

    // All variations should map to the same internal value
    expect(Object.values(params1)).toContain("COMPLETED_SUCCESSFULLY");
    expect(Object.values(params2)).toContain("COMPLETED_SUCCESSFULLY");
    expect(Object.values(params3)).toContain("COMPLETED_SUCCESSFULLY");
  });

  it("should pass through values without mapping if not in valueMap", () => {
    const ctx = createValueMapContext();
    const { params } = printQuery("SELECT * FROM runs WHERE status = 'UNKNOWN_STATUS'", ctx);

    // Value not in valueMap should pass through unchanged
    expect(Object.values(params)).toContain("UNKNOWN_STATUS");
  });

  it("should transform values in NOT IN clause", () => {
    const ctx = createValueMapContext();
    const { sql, params } = printQuery(
      "SELECT * FROM runs WHERE status NOT IN ('Pending', 'System failure')",
      ctx
    );

    expect(Object.values(params)).toContain("PENDING");
    expect(Object.values(params)).toContain("SYSTEM_FAILURE");
  });

  it("should transform values in != comparison", () => {
    const ctx = createValueMapContext();
    const { params } = printQuery("SELECT * FROM runs WHERE status != 'Failed'", ctx);

    expect(Object.values(params)).toContain("FAILED");
  });

  it("should not transform values for columns without valueMap", () => {
    const ctx = createValueMapContext();
    const { params } = printQuery("SELECT * FROM runs WHERE id = 'Completed'", ctx);

    // 'id' column has no valueMap, so "Completed" should pass through unchanged
    expect(Object.values(params)).toContain("Completed");
  });
});

describe("WHERE transform (whereTransform)", () => {
  /**
   * Schema with whereTransform for batch_id column (strips prefix)
   */
  const prefixedIdSchema: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      id: { name: "id", ...column("String") },
      batch_id: {
        name: "batch_id",
        ...column("String"),
        // Transform strips the "batch_" prefix from user input
        whereTransform: (value: string) => value.replace(/^batch_/, ""),
        // Expression adds the prefix back in SELECT
        expression: "if(batch_id = '', NULL, concat('batch_', batch_id))",
      },
      schedule_id: {
        name: "schedule_id",
        ...column("String"),
        // Transform strips the "sched_" prefix
        whereTransform: (value: string) => value.replace(/^sched_/, ""),
      },
      organization_id: { name: "organization_id", ...column("String") },
      project_id: { name: "project_id", ...column("String") },
      environment_id: { name: "environment_id", ...column("String") },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  function createPrefixedContext() {
    const schema = createSchemaRegistry([prefixedIdSchema]);
  return createPrinterContext({
    schema,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_test123" },
      project_id: { op: "eq", value: "proj_test456" },
      environment_id: { op: "eq", value: "env_test789" },
    },
  });
}

it("should strip prefix from value in equality comparison", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery("SELECT * FROM runs WHERE batch_id = 'batch_abc123'", ctx);

    // The "batch_" prefix should be stripped, leaving just "abc123"
    expect(Object.values(params)).toContain("abc123");
    expect(Object.values(params)).not.toContain("batch_abc123");
  });

  it("should strip prefix from values in IN clause", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery(
      "SELECT * FROM runs WHERE batch_id IN ('batch_abc', 'batch_def', 'batch_ghi')",
      ctx
    );

    // All prefixes should be stripped
    expect(Object.values(params)).toContain("abc");
    expect(Object.values(params)).toContain("def");
    expect(Object.values(params)).toContain("ghi");
    expect(Object.values(params)).not.toContain("batch_abc");
  });

  it("should strip prefix from value in NOT IN clause", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery("SELECT * FROM runs WHERE batch_id NOT IN ('batch_xyz')", ctx);

    expect(Object.values(params)).toContain("xyz");
    expect(Object.values(params)).not.toContain("batch_xyz");
  });

  it("should strip prefix from value in != comparison", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery("SELECT * FROM runs WHERE batch_id != 'batch_test'", ctx);

    expect(Object.values(params)).toContain("test");
    expect(Object.values(params)).not.toContain("batch_test");
  });

  it("should handle values without the prefix (pass through unchanged)", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery("SELECT * FROM runs WHERE batch_id = 'raw_value'", ctx);

    // If no prefix to strip, the value passes through unchanged
    expect(Object.values(params)).toContain("raw_value");
  });

  it("should not transform values for columns without whereTransform", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery("SELECT * FROM runs WHERE id = 'batch_abc123'", ctx);

    // 'id' column has no whereTransform, so value passes through unchanged
    expect(Object.values(params)).toContain("batch_abc123");
  });

  it("should use expression for SELECT output (virtual column)", () => {
    const ctx = createPrefixedContext();
    const { sql } = printQuery("SELECT batch_id FROM runs", ctx);

    // The expression should be used in SELECT
    expect(sql).toContain("if(batch_id = '', NULL, concat('batch_', batch_id))");
  });

  it("should use raw column in WHERE but expression in SELECT", () => {
    const ctx = createPrefixedContext();
    const { sql, params } = printQuery(
      "SELECT batch_id FROM runs WHERE batch_id = 'batch_abc123'",
      ctx
    );

    // SELECT should use the expression (adds prefix)
    expect(sql).toContain("if(batch_id = '', NULL, concat('batch_', batch_id))");

    // WHERE should use table-qualified raw column (not the expression), and value should be stripped
    // The WHERE clause should compare `runs.batch_id` directly (table-qualified to avoid alias conflict)
    expect(sql).toMatch(/WHERE.*equals\(`?runs`?\.`?batch_id`?,/);
    expect(sql).not.toMatch(/WHERE.*concat\('batch_'/);

    // The value should have prefix stripped
    expect(Object.values(params)).toContain("abc123");
  });

  it("should work with different prefix patterns", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery("SELECT * FROM runs WHERE schedule_id = 'sched_xyz789'", ctx);

    // The "sched_" prefix should be stripped
    expect(Object.values(params)).toContain("xyz789");
    expect(Object.values(params)).not.toContain("sched_xyz789");
  });

  it("should transform values in tuple/array for IN expressions", () => {
    const ctx = createPrefixedContext();
    const { params } = printQuery(
      "SELECT * FROM runs WHERE batch_id IN ['batch_a', 'batch_b']",
      ctx
    );

    // Both prefixes should be stripped
    expect(Object.values(params)).toContain("a");
    expect(Object.values(params)).toContain("b");
  });

  it("should use raw column in GROUP BY for columns with whereTransform", () => {
    const ctx = createPrefixedContext();
    const { sql } = printQuery(
      "SELECT batch_id, COUNT() as count FROM runs GROUP BY batch_id",
      ctx
    );

    // SELECT should use the expression (adds prefix)
    expect(sql).toContain("if(batch_id = '', NULL, concat('batch_', batch_id))");

    // GROUP BY should use table-qualified raw column (not the expression)
    // This avoids the "not in GROUP BY keys" error from ClickHouse
    expect(sql).toMatch(/GROUP BY.*`?runs`?\.`?batch_id`?/);
    expect(sql).not.toMatch(/GROUP BY.*concat\('batch_'/);
  });

  it("should work with GROUP BY and WHERE together", () => {
    const ctx = createPrefixedContext();
    const { sql, params } = printQuery(
      "SELECT batch_id, COUNT() as count FROM runs WHERE batch_id != NULL GROUP BY batch_id",
      ctx
    );

    // SELECT should use expression
    expect(sql).toContain("if(batch_id = '', NULL, concat('batch_', batch_id))");

    // Both WHERE and GROUP BY should use raw column
    expect(sql).toMatch(/WHERE.*`?runs`?\.`?batch_id`?/);
    expect(sql).toMatch(/GROUP BY.*`?runs`?\.`?batch_id`?/);
  });
});

describe("Edge cases", () => {
  it("should handle empty string values", () => {
    const { sql, params } = printQuery("SELECT * FROM task_runs WHERE status = ''");

    expect(Object.values(params)).toContain("");
  });

  it("should handle special characters in strings", () => {
    const { sql, params } = printQuery("SELECT * FROM task_runs WHERE status = 'test\nvalue'");

    // The string value should be parameterized
    expect(Object.keys(params).length).toBeGreaterThan(0);
  });

  it("should handle large numbers", () => {
    // Use a number that JavaScript can safely represent
    const { sql } = printQuery("SELECT * FROM task_runs WHERE duration_ms > 1000000000000");

    expect(sql).toContain("1000000000000");
  });

  it("should handle negative numbers", () => {
    const { sql } = printQuery("SELECT * FROM task_runs WHERE duration_ms > -1000");

    // Negative numbers might be expressed as subtraction or negate
    expect(sql).toMatch(/-1000|minus|negate/);
  });

  it("should handle floating point numbers", () => {
    const { sql } = printQuery("SELECT * FROM task_runs WHERE duration_ms > 1.5");

    expect(sql).toContain("1.5");
  });
});

describe("Virtual columns", () => {
  /**
   * Schema with virtual (computed) columns
   */
  const virtualColumnSchema: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      run_id: { name: "run_id", ...column("String") },
      status: { name: "status", ...column("String") },
      started_at: { name: "started_at", ...column("Nullable(DateTime64)") },
      completed_at: { name: "completed_at", ...column("Nullable(DateTime64)") },
      usage_duration_ms: { name: "usage_duration_ms", ...column("UInt32") },
      // Virtual column: execution_duration computes the time between started_at and completed_at
      execution_duration: {
        name: "execution_duration",
        ...column("Nullable(Int64)"),
        expression: "dateDiff('millisecond', started_at, completed_at)",
        description: "Time between started_at and completed_at in milliseconds",
      },
      // Virtual column: is_long_running checks if execution took more than 60 seconds
      is_long_running: {
        name: "is_long_running",
        ...column("UInt8"),
        expression:
          "if(completed_at IS NOT NULL AND started_at IS NOT NULL, dateDiff('second', started_at, completed_at) > 60, 0)",
      },
      // Virtual column with simple arithmetic
      usage_duration_seconds: {
        name: "usage_duration_seconds",
        ...column("Float64"),
        expression: "usage_duration_ms / 1000.0",
      },
      organization_id: { name: "organization_id", ...column("String") },
      project_id: { name: "project_id", ...column("String") },
      environment_id: { name: "environment_id", ...column("String") },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  function createVirtualColumnContext() {
    const schema = createSchemaRegistry([virtualColumnSchema]);
  return createPrinterContext({
    schema,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_test" },
      project_id: { op: "eq", value: "proj_test" },
      environment_id: { op: "eq", value: "env_test" },
    },
  });
}

describe("SELECT clause", () => {
  it("should expand bare virtual column to expression with alias", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT execution_duration FROM runs", ctx);

      // Virtual column should be expanded to its expression with AS alias
      expect(sql).toContain("(dateDiff('millisecond', started_at, completed_at))");
      expect(sql).toContain("AS execution_duration");
    });

    it("should expand virtual column with explicit alias", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT execution_duration AS dur FROM runs", ctx);

      // Virtual column should use the user-provided alias
      expect(sql).toContain("(dateDiff('millisecond', started_at, completed_at))");
      expect(sql).toContain("AS dur");
      expect(sql).not.toContain("AS execution_duration");
    });

    it("should expand qualified virtual column reference", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT runs.execution_duration FROM runs", ctx);

      // Qualified reference should also expand
      expect(sql).toContain("(dateDiff('millisecond', started_at, completed_at))");
      expect(sql).toContain("AS execution_duration");
    });

    it("should handle multiple virtual columns in SELECT", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery(
        "SELECT run_id, execution_duration, is_long_running FROM runs",
        ctx
      );

      expect(sql).toContain("run_id");
      expect(sql).toContain("(dateDiff('millisecond', started_at, completed_at))");
      expect(sql).toContain("AS execution_duration");
      expect(sql).toContain(
        "(if(completed_at IS NOT NULL AND started_at IS NOT NULL, dateDiff('second', started_at, completed_at) > 60, 0))"
      );
      expect(sql).toContain("AS is_long_running");
    });

    it("should mix regular and virtual columns correctly", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery(
        "SELECT run_id, status, execution_duration, started_at FROM runs",
        ctx
      );

      // Regular columns should be normal
      expect(sql).toMatch(/\brun_id\b/);
      expect(sql).toMatch(/\bstatus\b/);
      expect(sql).toMatch(/\bstarted_at\b/);
      // Virtual column should be expanded
      expect(sql).toContain(
        "(dateDiff('millisecond', started_at, completed_at)) AS execution_duration"
      );
    });
  });

  describe("WHERE clause", () => {
    it("should expand virtual column in WHERE equality", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE execution_duration > 1000", ctx);

      // Virtual column in WHERE should expand without AS
      expect(sql).toContain("greater((dateDiff('millisecond', started_at, completed_at)), 1000)");
    });

    it("should expand virtual column in WHERE with comparison operators", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE execution_duration >= 5000", ctx);

      expect(sql).toContain(
        "greaterOrEquals((dateDiff('millisecond', started_at, completed_at)), 5000)"
      );
    });

    it("should expand virtual column in WHERE with multiple conditions", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery(
        "SELECT * FROM runs WHERE execution_duration > 1000 AND is_long_running = 1",
        ctx
      );

      expect(sql).toContain("(dateDiff('millisecond', started_at, completed_at))");
      expect(sql).toContain(
        "(if(completed_at IS NOT NULL AND started_at IS NOT NULL, dateDiff('second', started_at, completed_at) > 60, 0))"
      );
    });

    it("should expand qualified virtual column in WHERE", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE runs.execution_duration > 1000", ctx);

      expect(sql).toContain("greater((dateDiff('millisecond', started_at, completed_at)), 1000)");
    });
  });

  describe("ORDER BY clause", () => {
    it("should expand virtual column in ORDER BY", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT * FROM runs ORDER BY execution_duration DESC", ctx);

      expect(sql).toContain("ORDER BY (dateDiff('millisecond', started_at, completed_at)) DESC");
    });

    it("should expand virtual column in ORDER BY with multiple columns", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery(
        "SELECT * FROM runs ORDER BY status ASC, execution_duration DESC",
        ctx
      );

      expect(sql).toContain("status ASC");
      expect(sql).toContain("(dateDiff('millisecond', started_at, completed_at)) DESC");
    });
  });

  describe("GROUP BY clause", () => {
    it("should use alias for virtual column in GROUP BY", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery(
        "SELECT is_long_running, count(*) FROM runs GROUP BY is_long_running",
        ctx
      );

      // SELECT should have the expression with alias
      expect(sql).toContain(
        "(if(completed_at IS NOT NULL AND started_at IS NOT NULL, dateDiff('second', started_at, completed_at) > 60, 0)) AS is_long_running"
      );
      // GROUP BY should use the alias, not the expression (ClickHouse allows this)
      expect(sql).toContain("GROUP BY is_long_running");
      // Should NOT have the expression in GROUP BY
      expect(sql).not.toContain("GROUP BY (if(completed_at IS NOT NULL AND started_at IS NOT NULL");
    });

    it("should use alias for virtual column in GROUP BY with WHERE and aggregation", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery(
        "SELECT execution_duration, count() AS duration_count FROM runs WHERE execution_duration IS NOT NULL GROUP BY execution_duration ORDER BY duration_count DESC LIMIT 100",
        ctx
      );

      // SELECT should have the expression with alias
      expect(sql).toContain(
        "(dateDiff('millisecond', started_at, completed_at)) AS execution_duration"
      );
      // GROUP BY should use the alias, not the expression
      expect(sql).toContain("GROUP BY execution_duration");
      // Should NOT have the expression in GROUP BY
      expect(sql).not.toContain("GROUP BY (dateDiff('millisecond'");
      // WHERE should still use the expression
      expect(sql).toContain("isNotNull((dateDiff('millisecond', started_at, completed_at)))");
    });
  });

  describe("Complex expressions", () => {
    it("should handle arithmetic virtual columns", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT usage_duration_seconds FROM runs", ctx);

      expect(sql).toContain("(usage_duration_ms / 1000.0)");
      expect(sql).toContain("AS usage_duration_seconds");
    });

    it("should handle virtual column in arithmetic expression", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT execution_duration / 1000 AS dur_seconds FROM runs", ctx);

      // The virtual column expression should be wrapped in the arithmetic
      expect(sql).toContain("divide((dateDiff('millisecond', started_at, completed_at)), 1000)");
      expect(sql).toContain("AS dur_seconds");
    });
  });

  describe("Regular columns unchanged", () => {
    it("should not affect regular columns without expression", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery("SELECT run_id, status, started_at FROM runs", ctx);

      // Regular columns should appear as-is
      expect(sql).toContain("run_id, status, started_at");
      // No extra parentheses or AS for regular columns in basic SELECT
      expect(sql).not.toMatch(/\(run_id\)/);
      expect(sql).not.toMatch(/\(status\)/);
    });
  });
});

describe("Expression columns with division (cost/invocation_cost pattern)", () => {
  /**
   * Schema mimicking the real runsSchema with cost-based expression columns
   * These use division expressions like base_cost_in_cents / 100.0
   */
  const costExpressionSchema: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      run_id: { name: "run_id", ...column("String") },
      status: { name: "status", ...column("String") },
      cost_in_cents: { name: "cost_in_cents", ...column("Float64") },
      base_cost_in_cents: { name: "base_cost_in_cents", ...column("Float64") },
      // Virtual column: compute_cost = cost_in_cents / 100.0
      compute_cost: {
        name: "compute_cost",
        ...column("Float64"),
        expression: "cost_in_cents / 100.0",
        description: "Compute cost in dollars",
      },
      // Virtual column: invocation_cost = base_cost_in_cents / 100.0
      invocation_cost: {
        name: "invocation_cost",
        ...column("Float64"),
        expression: "base_cost_in_cents / 100.0",
        description: "Invocation cost in dollars",
      },
      organization_id: { name: "organization_id", ...column("String") },
      project_id: { name: "project_id", ...column("String") },
      environment_id: { name: "environment_id", ...column("String") },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  function createCostExpressionContext() {
    const schema = createSchemaRegistry([costExpressionSchema]);
  return createPrinterContext({
    schema,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_test" },
      project_id: { op: "eq", value: "proj_test" },
      environment_id: { op: "eq", value: "env_test" },
    },
  });
}

describe("WHERE clause with division expression columns", () => {
  it("should expand invocation_cost > 100 to (base_cost_in_cents / 100.0) > 100", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE invocation_cost > 100", ctx);

      // Virtual column should be expanded to its expression in the comparison
      expect(sql).toContain("greater((base_cost_in_cents / 100.0), 100)");
    });

    it("should expand invocation_cost >= 0.01 correctly", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE invocation_cost >= 0.01", ctx);

      expect(sql).toContain("greaterOrEquals((base_cost_in_cents / 100.0), 0.01)");
    });

    it("should expand invocation_cost < 1.5 correctly", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE invocation_cost < 1.5", ctx);

      expect(sql).toContain("less((base_cost_in_cents / 100.0), 1.5)");
    });

    it("should expand invocation_cost = 0 correctly", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE invocation_cost = 0", ctx);

      expect(sql).toContain("equals((base_cost_in_cents / 100.0), 0)");
    });

    it("should expand compute_cost in BETWEEN correctly", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT * FROM runs WHERE compute_cost BETWEEN 1.0 AND 10.0", ctx);

      expect(sql).toContain("(cost_in_cents / 100.0) BETWEEN 1 AND 10");
    });

    it("should handle multiple expression columns in WHERE with AND", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery(
        "SELECT * FROM runs WHERE invocation_cost > 0.5 AND compute_cost < 5.0",
        ctx
      );

      expect(sql).toContain("greater((base_cost_in_cents / 100.0), 0.5)");
      expect(sql).toContain("less((cost_in_cents / 100.0), 5)");
    });

    it("should handle expression column with OR condition", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery(
        "SELECT * FROM runs WHERE invocation_cost > 10 OR status = 'COMPLETED'",
        ctx
      );

      expect(sql).toContain("or(");
      expect(sql).toContain("greater((base_cost_in_cents / 100.0), 10)");
    });
  });

  describe("SELECT clause with division expression columns", () => {
    it("should expand invocation_cost in SELECT with alias", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT run_id, invocation_cost FROM runs", ctx);

      expect(sql).toContain("(base_cost_in_cents / 100.0) AS invocation_cost");
    });

    it("should expand both cost columns correctly", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT compute_cost, invocation_cost FROM runs", ctx);

      expect(sql).toContain("(cost_in_cents / 100.0) AS compute_cost");
      expect(sql).toContain("(base_cost_in_cents / 100.0) AS invocation_cost");
    });
  });

  describe("ORDER BY clause with division expression columns", () => {
    it("should expand invocation_cost in ORDER BY DESC", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT * FROM runs ORDER BY invocation_cost DESC", ctx);

      expect(sql).toContain("ORDER BY (base_cost_in_cents / 100.0) DESC");
    });

    it("should expand compute_cost in ORDER BY ASC", () => {
      const ctx = createCostExpressionContext();
      const { sql } = printQuery("SELECT * FROM runs ORDER BY compute_cost ASC", ctx);

      expect(sql).toContain("ORDER BY (cost_in_cents / 100.0) ASC");
    });
  });
});

describe("Column metadata", () => {
  /**
   * Schema with customRenderType for testing
   */
  const schemaWithRenderTypes: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      run_id: { name: "run_id", ...column("String") },
      friendly_id: { name: "friendly_id", ...column("String") },
      status: {
        name: "status",
        ...column("LowCardinality(String)"),
        customRenderType: "runStatus",
      },
      created_at: { name: "created_at", ...column("DateTime64") },
      started_at: { name: "started_at", ...column("Nullable(DateTime64)") },
      completed_at: { name: "completed_at", ...column("Nullable(DateTime64)") },
      usage_duration_ms: {
        name: "usage_duration_ms",
        ...column("UInt32"),
        customRenderType: "duration",
      },
      cost_in_cents: {
        name: "cost_in_cents",
        ...column("Float64"),
        customRenderType: "cost",
      },
      organization_id: { name: "organization_id", ...column("String") },
      project_id: { name: "project_id", ...column("String") },
      environment_id: { name: "environment_id", ...column("String") },
      is_test: { name: "is_test", ...column("UInt8") },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  function createMetadataTestContext() {
    const schema = createSchemaRegistry([schemaWithRenderTypes]);
  return createPrinterContext({
    schema,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: "org_test" },
      project_id: { op: "eq", value: "proj_test" },
      environment_id: { op: "eq", value: "env_test" },
    },
  });
}

describe("Basic column metadata", () => {
  it("should return column metadata for simple field references", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT run_id, created_at FROM runs", ctx);

      expect(columns).toHaveLength(2);
      expect(columns[0]).toEqual({
        name: "run_id",
        type: "String",
      });
      expect(columns[1]).toEqual({
        name: "created_at",
        type: "DateTime64",
      });
    });

    it("should include customRenderType when defined in schema", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT status, usage_duration_ms, cost_in_cents FROM runs",
        ctx
      );

      expect(columns).toHaveLength(3);
      expect(columns[0]).toEqual({
        name: "status",
        type: "LowCardinality(String)",
        customRenderType: "runStatus",
      });
      expect(columns[1]).toEqual({
        name: "usage_duration_ms",
        type: "UInt32",
        customRenderType: "duration",
      });
      expect(columns[2]).toEqual({
        name: "cost_in_cents",
        type: "Float64",
        customRenderType: "cost",
      });
    });

    it("should use alias as output name when AS is used", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT run_id AS id, status AS run_status FROM runs", ctx);

      expect(columns).toHaveLength(2);
      expect(columns[0].name).toBe("id");
      expect(columns[0].type).toBe("String");
      expect(columns[1].name).toBe("run_status");
      expect(columns[1].type).toBe("LowCardinality(String)");
      expect(columns[1].customRenderType).toBe("runStatus");
    });
  });

  describe("Type inference for aggregations", () => {
    it("should infer UInt64 for COUNT", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT COUNT(*) AS total FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("total");
      expect(columns[0].type).toBe("UInt64");
    });

    it("should infer UInt64 for COUNT with column", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT COUNT(run_id) AS run_count FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("run_count");
      expect(columns[0].type).toBe("UInt64");
    });

    it("should infer Float64 for AVG", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT AVG(usage_duration_ms) AS avg_duration FROM runs",
        ctx
      );

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("avg_duration");
      expect(columns[0].type).toBe("Float64");
    });

    it("should infer Int64 for SUM", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT SUM(usage_duration_ms) AS total_duration FROM runs",
        ctx
      );

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("total_duration");
      expect(columns[0].type).toBe("Int64");
    });

    it("should preserve column type for MIN/MAX", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT MIN(created_at) AS first_run, MAX(created_at) AS last_run FROM runs",
        ctx
      );

      expect(columns).toHaveLength(2);
      expect(columns[0].name).toBe("first_run");
      expect(columns[0].type).toBe("DateTime64");
      expect(columns[1].name).toBe("last_run");
      expect(columns[1].type).toBe("DateTime64");
    });
  });

  describe("Type inference for computed expressions", () => {
    it("should infer Int64 for dateDiff", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT dateDiff('millisecond', started_at, completed_at) AS duration FROM runs",
        ctx
      );

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("duration");
      expect(columns[0].type).toBe("Int64");
    });

    it("should infer Float64 for division", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT usage_duration_ms / 1000 AS duration_seconds FROM runs",
        ctx
      );

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("duration_seconds");
      expect(columns[0].type).toBe("Float64");
    });

    it("should infer Int64 for integer arithmetic", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT usage_duration_ms + 100 AS adjusted_duration FROM runs",
        ctx
      );

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("adjusted_duration");
      // UInt32 + Int64 constant = Int64
      expect(columns[0].type).toBe("Int64");
    });

    it("should infer String for string functions", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT concat(run_id, '-', status) AS combined FROM runs",
        ctx
      );

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("combined");
      expect(columns[0].type).toBe("String");
    });
  });

  describe("Mixed columns with and without customRenderType", () => {
    it("should handle a mix of regular and custom-rendered columns", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT run_id, status, created_at, usage_duration_ms, cost_in_cents FROM runs",
        ctx
      );

      expect(columns).toHaveLength(5);

      // run_id - no customRenderType
      expect(columns[0].name).toBe("run_id");
      expect(columns[0].type).toBe("String");
      expect(columns[0].customRenderType).toBeUndefined();

      // status - has customRenderType
      expect(columns[1].name).toBe("status");
      expect(columns[1].customRenderType).toBe("runStatus");

      // created_at - no customRenderType
      expect(columns[2].name).toBe("created_at");
      expect(columns[2].type).toBe("DateTime64");
      expect(columns[2].customRenderType).toBeUndefined();

      // usage_duration_ms - has customRenderType
      expect(columns[3].name).toBe("usage_duration_ms");
      expect(columns[3].customRenderType).toBe("duration");

      // cost_in_cents - has customRenderType
      expect(columns[4].name).toBe("cost_in_cents");
      expect(columns[4].customRenderType).toBe("cost");
    });

    it("should handle aggregations mixed with regular columns", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT status, COUNT(*) AS count, AVG(usage_duration_ms) AS avg_duration FROM runs GROUP BY status",
        ctx
      );

      expect(columns).toHaveLength(3);

      // status - from schema with customRenderType
      expect(columns[0].name).toBe("status");
      expect(columns[0].customRenderType).toBe("runStatus");

      // count - aggregation inferred type, COUNT doesn't preserve customRenderType
      expect(columns[1].name).toBe("count");
      expect(columns[1].type).toBe("UInt64");
      expect(columns[1].customRenderType).toBeUndefined();

      // avg_duration - aggregation inferred type, AVG preserves customRenderType from source column
      // (average duration is still a duration)
      expect(columns[2].name).toBe("avg_duration");
      expect(columns[2].type).toBe("Float64");
      expect(columns[2].customRenderType).toBe("duration");
    });

    it("should propagate customRenderType for value-preserving aggregates (SUM, AVG, MIN, MAX)", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT SUM(usage_duration_ms) AS total_duration, AVG(cost_in_cents) AS avg_cost, MIN(usage_duration_ms) AS min_duration, MAX(cost_in_cents) AS max_cost FROM runs",
        ctx
      );

      expect(columns).toHaveLength(4);

      // SUM preserves customRenderType
      expect(columns[0].name).toBe("total_duration");
      expect(columns[0].customRenderType).toBe("duration");

      // AVG preserves customRenderType
      expect(columns[1].name).toBe("avg_cost");
      expect(columns[1].customRenderType).toBe("cost");

      // MIN preserves customRenderType
      expect(columns[2].name).toBe("min_duration");
      expect(columns[2].customRenderType).toBe("duration");

      // MAX preserves customRenderType
      expect(columns[3].name).toBe("max_cost");
      expect(columns[3].customRenderType).toBe("cost");
    });

    it("should NOT propagate customRenderType for COUNT aggregates", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT COUNT(*), COUNT(usage_duration_ms), COUNT(DISTINCT status) FROM runs",
        ctx
      );

      expect(columns).toHaveLength(3);

      // COUNT(*) - no customRenderType
      expect(columns[0].customRenderType).toBeUndefined();

      // COUNT(duration_column) - still no customRenderType (it's a count, not a duration)
      expect(columns[1].customRenderType).toBeUndefined();

      // COUNT(DISTINCT ...) - no customRenderType
      expect(columns[2].customRenderType).toBeUndefined();
    });
  });

  describe("Implicit column names for expressions without aliases", () => {
    it("should generate implicit name for COUNT()", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT COUNT() FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("count");
      expect(columns[0].type).toBe("UInt64");
    });

    it("should generate implicit name for COUNT(*)", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT COUNT(*) FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("count");
      expect(columns[0].type).toBe("UInt64");
    });

    it("should generate implicit name for COUNT with column argument", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT COUNT(run_id) FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("count");
      expect(columns[0].type).toBe("UInt64");
    });

    it("should generate implicit name for SUM", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT SUM(usage_duration_ms) FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("sum");
      expect(columns[0].type).toBe("Int64");
    });

    it("should generate implicit name for AVG", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT AVG(usage_duration_ms) FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("avg");
      expect(columns[0].type).toBe("Float64");
    });

    it("should generate implicit names for multiple aggregations without aliases", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT COUNT(), status FROM runs GROUP BY status", ctx);

      expect(columns).toHaveLength(2);
      expect(columns[0].name).toBe("count");
      expect(columns[0].type).toBe("UInt64");
      expect(columns[1].name).toBe("status");
      expect(columns[1].type).toBe("LowCardinality(String)");
    });

    it("should generate implicit name for arithmetic expressions", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT usage_duration_ms + 100 FROM runs", ctx);

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe("plus");
    });

    it("should generate implicit name for constant values", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery("SELECT 42, 'hello' FROM runs", ctx);

      expect(columns).toHaveLength(2);
      expect(columns[0].name).toBe("42");
      expect(columns[1].name).toBe("'hello'");
    });

    it("should mix explicit aliases with implicit names", () => {
      const ctx = createMetadataTestContext();
      const { columns } = printQuery(
        "SELECT COUNT() AS total, AVG(usage_duration_ms), status AS run_status FROM runs GROUP BY status",
        ctx
      );

      expect(columns).toHaveLength(3);
      expect(columns[0].name).toBe("total");
      expect(columns[1].name).toBe("avg");
      expect(columns[2].name).toBe("run_status");
    });

    it("should add AS clause to generated SQL for implicit names", () => {
      const ctx = createMetadataTestContext();
      const { sql, columns } = printQuery("SELECT COUNT(), status FROM runs GROUP BY status", ctx);

      // The SQL should include an explicit AS clause for the COUNT()
      expect(sql).toContain("count() AS count");
      expect(columns[0].name).toBe("count");
    });

    it("should add AS clause for multiple aggregations", () => {
      const ctx = createMetadataTestContext();
      const { sql, columns } = printQuery(
        "SELECT COUNT(), SUM(usage_duration_ms), AVG(usage_duration_ms) FROM runs",
        ctx
      );

      // All aggregations should have AS clauses
      expect(sql).toContain("count() AS count");
      expect(sql).toContain("sum(usage_duration_ms) AS sum");
      expect(sql).toContain("avg(usage_duration_ms) AS avg");
      expect(columns).toHaveLength(3);
      expect(columns[0].name).toBe("count");
      expect(columns[1].name).toBe("sum");
      expect(columns[2].name).toBe("avg");
    });
  });
});

describe("Unknown column blocking", () => {
  /**
   * These tests verify that unknown columns are blocked at compile time,
   * preventing access to internal ClickHouse columns that aren't exposed in the schema.
   */

  describe("should block unknown columns in SELECT", () => {
    it("should throw error for unknown column in SELECT list", () => {
      expect(() => {
        printQuery("SELECT id, unknown_column FROM task_runs");
      }).toThrow(QueryError);
      expect(() => {
        printQuery("SELECT id, unknown_column FROM task_runs");
      }).toThrow(/unknown.*column.*unknown_column/i);
    });

    it("should throw error for internal ClickHouse column name not in schema", () => {
      // The schema exposes 'created' but the internal ClickHouse column is 'created_at'
      // Using the internal name directly should be blocked
      const schema = createSchemaRegistry([runsSchema]);
      const ctx = createPrinterContext({
        schema,
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_test" },
          project_id: { op: "eq", value: "proj_test" },
          environment_id: { op: "eq", value: "env_test" },
        },
      });

      // 'created_at' is not in runsSchema - only 'created' which maps to 'created_at'
      expect(() => {
        printQuery("SELECT id, created_at FROM runs", ctx);
      }).toThrow(QueryError);
    });

    it("should suggest TSQL column name when user types ClickHouse column name", () => {
      // The schema exposes 'created' but the internal ClickHouse column is 'created_at'
      // When user types 'created_at', we should suggest 'created'
      const schema = createSchemaRegistry([runsSchema]);
      const ctx = createPrinterContext({
        schema,
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_test" },
          project_id: { op: "eq", value: "proj_test" },
          environment_id: { op: "eq", value: "env_test" },
        },
      });

      expect(() => {
        printQuery("SELECT id, created_at FROM runs", ctx);
      }).toThrow(/Did you mean "created"/);
    });

    it("should throw error for unknown qualified column (table.column)", () => {
      expect(() => {
        printQuery("SELECT task_runs.unknown_column FROM task_runs");
      }).toThrow(QueryError);
    });
  });

  describe("should block unknown columns in WHERE", () => {
    it("should throw error for unknown column in WHERE clause", () => {
      expect(() => {
        printQuery("SELECT id FROM task_runs WHERE unknown_column = 'test'");
      }).toThrow(QueryError);
    });

    it("should throw error for unknown column in complex WHERE", () => {
      expect(() => {
        printQuery("SELECT id FROM task_runs WHERE status = 'completed' AND unknown_column > 10");
      }).toThrow(QueryError);
    });
  });

  describe("should block unknown columns in ORDER BY", () => {
    it("should throw error for unknown column in ORDER BY", () => {
      expect(() => {
        printQuery("SELECT id, status FROM task_runs ORDER BY unknown_column DESC");
      }).toThrow(QueryError);
    });
  });

  describe("should block unknown columns in GROUP BY", () => {
    it("should throw error for unknown column in GROUP BY", () => {
      expect(() => {
        printQuery("SELECT count(*) FROM task_runs GROUP BY unknown_column");
      }).toThrow(QueryError);
    });
  });

  describe("should allow SELECT aliases", () => {
    it("should allow ORDER BY to reference aliased columns", () => {
      // This should NOT throw - 'cnt' is a valid alias from SELECT
      const { sql } = printQuery(
        "SELECT status, count(*) AS cnt FROM task_runs GROUP BY status ORDER BY cnt DESC"
      );
      expect(sql).toContain("ORDER BY cnt DESC");
    });

    it("should allow HAVING to reference aliased columns", () => {
      const { sql } = printQuery(
        "SELECT status, count(*) AS cnt FROM task_runs GROUP BY status HAVING cnt > 10"
      );
      expect(sql).toContain("HAVING");
    });

    it("should allow ORDER BY to reference implicit aggregation names", () => {
      // COUNT() without alias gets implicit name 'count'
      const { sql } = printQuery(
        "SELECT status, count() FROM task_runs GROUP BY status ORDER BY count DESC"
      );
      expect(sql).toContain("ORDER BY count DESC");
    });
  });

  // Note: CTE support is limited - CTEs are not added to the table context,
  // so CTE column references are treated as unknown. This is a pre-existing limitation.
  // The tests below verify that unknown column blocking doesn't break existing behavior.

  describe("should allow subquery alias references", () => {
    it("should allow referencing columns from subquery in FROM clause", () => {
      const { sql } = printQuery(`
        SELECT sub.status_name, sub.total
        FROM (
          SELECT status AS status_name, count(*) AS total
          FROM task_runs
          GROUP BY status
        ) AS sub
        ORDER BY sub.total DESC
      `);
      expect(sql).toContain("status_name");
      expect(sql).toContain("total");
    });

    it("should allow unqualified references to subquery columns", () => {
      const { sql } = printQuery(`
        SELECT status_name, total
        FROM (
          SELECT status AS status_name, count(*) AS total
          FROM task_runs
          GROUP BY status
        )
        WHERE total > 10
      `);
      expect(sql).toContain("status_name");
      expect(sql).toContain("total");
    });
  });
});

describe("Field Mapping Value Transformation", () => {
  // Test schema with a field mapping column
  const fieldMappingSchema: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      run_id: { name: "run_id", ...column("String") },
      status: { name: "status", ...column("String") },
      project_ref: {
        name: "project_ref",
        clickhouseName: "project_id",
        ...column("String"),
        fieldMapping: "project",
      },
      environment_id: { name: "environment_id", ...column("String") },
      organization_id: { name: "organization_id", ...column("String") },
      project_id: { name: "project_id", ...column("String") },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  function createFieldMappingContext(): PrinterContext {
    const schemaRegistry = createSchemaRegistry([fieldMappingSchema]);
    return new PrinterContext(
      schemaRegistry,
      {},
      {
        project: {
          proj_tenant1: "my-project-ref",
          proj_other: "other-project",
        },
      },
      {
        organization_id: { op: "eq", value: "org_123" },
        project_id: { op: "eq", value: "proj_456" },
        environment_id: { op: "eq", value: "env_789" },
      }
    );
  }

  function printQuery(query: string, ctx: PrinterContext): PrintResult {
    const ast = parseTSQLSelect(query);
    const printer = new ClickHousePrinter(ctx);
    return printer.print(ast);
  }

  it("should transform field mapping values in WHERE clause with equals", () => {
    const ctx = createFieldMappingContext();
    const { sql, params } = printQuery(
      "SELECT run_id FROM runs WHERE project_ref = 'my-project-ref'",
      ctx
    );

    // The value should be transformed to the internal value
    expect(sql).toContain("project_id");
    expect(Object.values(params)).toContain("proj_tenant1");
    expect(Object.values(params)).not.toContain("my-project-ref");
  });

  it("should transform field mapping values in WHERE clause with IN list", () => {
    const ctx = createFieldMappingContext();
    const { sql, params } = printQuery(
      "SELECT run_id FROM runs WHERE project_ref IN ('my-project-ref', 'other-project')",
      ctx
    );

    expect(sql).toContain("project_id");
    const paramValues = Object.values(params);
    expect(paramValues).toContain("proj_tenant1");
    expect(paramValues).toContain("proj_other");
    expect(paramValues).not.toContain("my-project-ref");
    expect(paramValues).not.toContain("other-project");
  });

  it("should be case-insensitive when transforming field mapping values", () => {
    const ctx = createFieldMappingContext();
    // Using uppercase version of the external value
    const { params } = printQuery(
      "SELECT run_id FROM runs WHERE project_ref = 'MY-PROJECT-REF'",
      ctx
    );

    // Should still transform to the internal value
    expect(Object.values(params)).toContain("proj_tenant1");
  });

  it("should pass through unmapped values unchanged", () => {
    const ctx = createFieldMappingContext();
    // Using a value that's not in the mapping
    const { params } = printQuery("SELECT run_id FROM runs WHERE project_ref = 'unknown-ref'", ctx);

    // Value should remain unchanged since it's not in the mapping
    expect(Object.values(params)).toContain("unknown-ref");
  });

  it("should use clickhouseName when selecting field mapping column", () => {
    const ctx = createFieldMappingContext();
    const { sql } = printQuery("SELECT project_ref FROM runs", ctx);

    // Should use the actual ClickHouse column name (project_id) in the SQL
    expect(sql).toContain("project_id");
    // But the column metadata should use the exposed name
  });
});

describe("Internal-only column blocking", () => {
  /**
   * These tests verify that internal columns (tenant columns, required filter columns)
   * that are NOT exposed in tableSchema.columns are blocked from user queries in
   * SELECT, ORDER BY, GROUP BY, and HAVING clauses, but allowed in system-generated
   * tenant isolation guards.
   */

  // Schema with hidden tenant columns (not exposed in public columns)
  const hiddenTenantSchema: TableSchema = {
    name: "hidden_tenant_runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      // Public columns - these are exposed to users
      id: { name: "id", ...column("String") },
      status: { name: "status", ...column("String") },
      task_identifier: { name: "task_identifier", ...column("String") },
      created_at: { name: "created_at", ...column("DateTime64") },
    },
    // Tenant columns are NOT in the public columns above
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  // Schema with hidden required filter column
  const hiddenFilterSchema: TableSchema = {
    name: "hidden_filter_runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      id: { name: "id", ...column("String") },
      status: { name: "status", ...column("String") },
      created_at: { name: "created_at", ...column("DateTime64") },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
    requiredFilters: [
      { column: "engine", value: "V2" }, // 'engine' is not in public columns
    ],
  };

  function createHiddenTenantContext(): PrinterContext {
    const schema = createSchemaRegistry([hiddenTenantSchema]);
    return createPrinterContext({
      schema,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_test" },
        project_id: { op: "eq", value: "proj_test" },
        environment_id: { op: "eq", value: "env_test" },
      },
    });
  }

  function createHiddenFilterContext(): PrinterContext {
    const schema = createSchemaRegistry([hiddenFilterSchema]);
    return createPrinterContext({
      schema,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_test" },
        project_id: { op: "eq", value: "proj_test" },
        environment_id: { op: "eq", value: "env_test" },
      },
    });
  }

  describe("should block internal-only columns in SELECT", () => {
    it("should throw error when selecting hidden tenant column (organization_id)", () => {
      const ctx = createHiddenTenantContext();
      expect(() => {
        printQuery("SELECT id, organization_id FROM hidden_tenant_runs", ctx);
      }).toThrow(QueryError);
      expect(() => {
        printQuery("SELECT id, organization_id FROM hidden_tenant_runs", ctx);
      }).toThrow(/not available for querying/i);
    });

    it("should throw error when selecting hidden tenant column (project_id)", () => {
      const ctx = createHiddenTenantContext();
      expect(() => {
        printQuery("SELECT project_id FROM hidden_tenant_runs", ctx);
      }).toThrow(/not available for querying/i);
    });

    it("should throw error when selecting hidden tenant column (environment_id)", () => {
      const ctx = createHiddenTenantContext();
      expect(() => {
        printQuery("SELECT environment_id FROM hidden_tenant_runs", ctx);
      }).toThrow(/not available for querying/i);
    });

    it("should throw error when selecting hidden required filter column", () => {
      const ctx = createHiddenFilterContext();
      expect(() => {
        printQuery("SELECT id, engine FROM hidden_filter_runs", ctx);
      }).toThrow(/not available for querying/i);
    });
  });

  describe("should block internal-only columns in ORDER BY", () => {
    it("should throw error when ordering by hidden tenant column", () => {
      const ctx = createHiddenTenantContext();
      expect(() => {
        printQuery("SELECT id, status FROM hidden_tenant_runs ORDER BY organization_id", ctx);
      }).toThrow(/not available for querying/i);
    });

    it("should throw error when ordering by hidden required filter column", () => {
      const ctx = createHiddenFilterContext();
      expect(() => {
        printQuery("SELECT id, status FROM hidden_filter_runs ORDER BY engine", ctx);
      }).toThrow(/not available for querying/i);
    });
  });

  describe("should block internal-only columns in GROUP BY", () => {
    it("should throw error when grouping by hidden tenant column", () => {
      const ctx = createHiddenTenantContext();
      expect(() => {
        printQuery("SELECT count(*) FROM hidden_tenant_runs GROUP BY organization_id", ctx);
      }).toThrow(/not available for querying/i);
    });

    it("should throw error when grouping by hidden required filter column", () => {
      const ctx = createHiddenFilterContext();
      expect(() => {
        printQuery("SELECT count(*) FROM hidden_filter_runs GROUP BY engine", ctx);
      }).toThrow(/not available for querying/i);
    });
  });

  describe("should block internal-only columns in HAVING", () => {
    it("should throw error when using hidden column in HAVING", () => {
      const ctx = createHiddenTenantContext();
      expect(() => {
        printQuery(
          "SELECT status, count(*) as cnt FROM hidden_tenant_runs GROUP BY status HAVING organization_id = 'x'",
          ctx
        );
      }).toThrow(/not available for querying/i);
    });
  });

  describe("should allow tenant guard in WHERE clause", () => {
    it("should successfully execute query with tenant isolation (hidden tenant columns work internally)", () => {
      const ctx = createHiddenTenantContext();
      // This should succeed - the tenant guard is injected internally and should work
      const { sql } = printQuery("SELECT id, status FROM hidden_tenant_runs", ctx);

      // Verify tenant guards are present in WHERE clause
      expect(sql).toContain("organization_id");
      expect(sql).toContain("project_id");
      expect(sql).toContain("environment_id");
      // But NOT in SELECT
      expect(sql).toMatch(/SELECT\s+id,\s*status\s+FROM/i);
    });

    it("should successfully execute query with required filter (hidden filter columns work internally)", () => {
      const ctx = createHiddenFilterContext();
      const { sql, params } = printQuery("SELECT id, status FROM hidden_filter_runs", ctx);

      // Verify required filter is present in WHERE clause
      expect(sql).toContain("engine");
      // The value V2 is parameterized, check that it's in the params
      expect(Object.values(params)).toContain("V2");
    });
  });

  describe("should allow exposed tenant columns", () => {
    // In task_runs schema, tenant columns ARE exposed in the public columns
    it("should allow selecting exposed tenant column", () => {
      // task_runs schema exposes organization_id in its columns
      const { sql } = printQuery("SELECT id, organization_id FROM task_runs");
      expect(sql).toContain("SELECT id, organization_id");
    });

    it("should allow ordering by exposed tenant column", () => {
      const { sql } = printQuery("SELECT id, status FROM task_runs ORDER BY organization_id");
      expect(sql).toContain("ORDER BY organization_id");
    });

    it("should allow grouping by exposed tenant column", () => {
      const { sql } = printQuery("SELECT organization_id, count(*) FROM task_runs GROUP BY organization_id");
      expect(sql).toContain("GROUP BY organization_id");
    });
  });
});

describe("Required Filters", () => {
  /**
   * Tests for tables with requiredFilters, which inject internal ClickHouse
   * column conditions (like engine = 'V2') that aren't exposed in the schema.
   */

  const schemaWithRequiredFilters: TableSchema = {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    description: "Task runs table with required filters",
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
    requiredFilters: [{ column: "engine", value: "V2" }],
    columns: {
      run_id: {
        name: "run_id",
        clickhouseName: "friendly_id",
        ...column("String", { description: "Run ID", coreColumn: true }),
      },
      status: {
        name: "status",
        ...column("String", { description: "Status" }),
      },
      triggered_at: {
        name: "triggered_at",
        clickhouseName: "created_at",
        ...column("DateTime64", { description: "When the run was triggered", coreColumn: true }),
      },
      total_cost: {
        name: "total_cost",
        ...column("Float64", { description: "Total cost" }),
        expression: "(cost_in_cents + base_cost_in_cents) / 100.0",
      },
    },
  };

  function createRequiredFiltersContext(): PrinterContext {
    const schemaRegistry = createSchemaRegistry([schemaWithRequiredFilters]);
    return createPrinterContext({
      schema: schemaRegistry,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_test123" },
        project_id: { op: "eq", value: "proj_test456" },
        environment_id: { op: "eq", value: "env_test789" },
      },
    });
  }

  function printQueryWithFilters(query: string): PrintResult {
    const ctx = createRequiredFiltersContext();
    const ast = parseTSQLSelect(query);
    const printer = new ClickHousePrinter(ctx);
    return printer.print(ast);
  }

  it("should NOT throw for internal engine column from requiredFilters", () => {
    // This query should work even though 'engine' is not in the schema
    // because it's automatically injected by requiredFilters
    const { sql, params } = printQueryWithFilters("SELECT run_id, status FROM runs LIMIT 10");

    // The engine filter should be in the WHERE clause
    expect(sql).toContain("engine");
    // The V2 value is parameterized, so check the params
    expect(Object.values(params)).toContain("V2");
  });

  it("should allow TSQL column names that map to different ClickHouse names", () => {
    // User writes 'triggered_at' but it maps to 'created_at' in ClickHouse
    const { sql } = printQueryWithFilters(`
      SELECT run_id, status, triggered_at
      FROM runs
      WHERE triggered_at > now() - INTERVAL 14 DAY
      ORDER BY triggered_at DESC
      LIMIT 100
    `);

    // The ClickHouse SQL should use 'created_at' instead of 'triggered_at'
    expect(sql).toContain("created_at");
    // The result should still have the alias for the user-friendly name
    expect(sql).toContain("AS triggered_at");
  });

  it("should allow filtering by mapped column name", () => {
    const { sql } = printQueryWithFilters(`
      SELECT run_id FROM runs WHERE triggered_at > '2024-01-01' LIMIT 10
    `);

    // Should use the ClickHouse column name in the WHERE clause
    expect(sql).toContain("created_at");
  });

  it("should allow ORDER BY on mapped column name", () => {
    const { sql } = printQueryWithFilters(`
      SELECT run_id FROM runs ORDER BY triggered_at DESC LIMIT 10
    `);

    // ORDER BY should use the ClickHouse column name
    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("created_at");
  });

  it("should handle virtual columns with expressions", () => {
    const { sql } = printQueryWithFilters(`
      SELECT run_id, total_cost FROM runs ORDER BY total_cost DESC LIMIT 10
    `);

    // Virtual column should be expanded to its expression with an alias
    expect(sql).toContain("cost_in_cents");
    expect(sql).toContain("base_cost_in_cents");
    expect(sql).toContain("AS total_cost");
  });

  it("should combine tenant guards with required filters", () => {
    const { sql, params } = printQueryWithFilters("SELECT run_id FROM runs LIMIT 10");

    // Should have all tenant columns AND the engine filter
    expect(sql).toContain("organization_id");
    expect(sql).toContain("project_id");
    expect(sql).toContain("environment_id");
    expect(sql).toContain("engine");
    // The V2 value is parameterized, so check the params
    expect(Object.values(params)).toContain("V2");
  });

  it("should allow complex queries with mapped columns", () => {
    // This query is similar to what a user might write
    const { sql } = printQueryWithFilters(`
      SELECT
        run_id,
        status,
        total_cost,
        triggered_at
      FROM runs
      WHERE triggered_at > now() - INTERVAL 14 DAY
      ORDER BY total_cost DESC
      LIMIT 100
    `);

    // All should work without errors
    expect(sql).toContain("friendly_id");  // run_id maps to friendly_id
    expect(sql).toContain("status");
    expect(sql).toContain("created_at");   // triggered_at maps to created_at
    expect(sql).toContain("cost_in_cents"); // total_cost is a virtual column
  });
});
