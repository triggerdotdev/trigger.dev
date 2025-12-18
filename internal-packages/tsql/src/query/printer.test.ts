import { describe, it, expect, beforeEach } from "vitest";
import { parseTSQLSelect, parseTSQLExpr } from "../index.js";
import { ClickHousePrinter, printToClickHouse } from "./printer.js";
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
    organizationId: "org_test123",
    projectId: "proj_test456",
    environmentId: "env_test789",
    schema,
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
    it("should print a simple SELECT *", () => {
      const { sql, params } = printQuery("SELECT * FROM task_runs");

      expect(sql).toContain("SELECT *");
      expect(sql).toContain("FROM trigger_dev.task_runs_v2");
      // Should include tenant guards
      expect(sql).toContain("organization_id");
      expect(sql).toContain("project_id");
      expect(sql).toContain("environment_id");
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
  });

  describe("Table and column name mapping", () => {
    function createMappedContext() {
      const schema = createSchemaRegistry([runsSchema]);
      return createPrinterContext({
        organizationId: "org_test",
        projectId: "proj_test",
        environmentId: "env_test",
        schema,
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

    it("should handle IS NOT NULL comparisons", () => {
      const { sql } = printQuery("SELECT * FROM task_runs WHERE started_at != NULL");

      expect(sql).toContain("isNotNull(");
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
        organizationId: "org_abc",
        projectId: "proj_def",
        environmentId: "env_ghi",
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
    it("should print toDateTime", () => {
      const { sql } = printQuery("SELECT toDateTime(created_at) FROM task_runs");

      expect(sql).toContain("toDateTime(created_at)");
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
      organizationId: "org_test",
      projectId: "proj_test",
      environmentId: "env_test",
      schema,
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
      organizationId: "org_test",
      projectId: "proj_test",
      environmentId: "env_test",
      schema,
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
    it("should expand virtual column in GROUP BY", () => {
      const ctx = createVirtualColumnContext();
      const { sql } = printQuery(
        "SELECT is_long_running, count(*) FROM runs GROUP BY is_long_running",
        ctx
      );

      // Both SELECT and GROUP BY should have the expansion
      expect(sql).toContain(
        "GROUP BY (if(completed_at IS NOT NULL AND started_at IS NOT NULL, dateDiff('second', started_at, completed_at) > 60, 0))"
      );
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
      organizationId: "org_test",
      projectId: "proj_test",
      environmentId: "env_test",
      schema,
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

      // count - aggregation inferred type
      expect(columns[1].name).toBe("count");
      expect(columns[1].type).toBe("UInt64");
      expect(columns[1].customRenderType).toBeUndefined();

      // avg_duration - aggregation inferred type
      expect(columns[2].name).toBe("avg_duration");
      expect(columns[2].type).toBe("Float64");
      expect(columns[2].customRenderType).toBeUndefined();
    });
  });
});
