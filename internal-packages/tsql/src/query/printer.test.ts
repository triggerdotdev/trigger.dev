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

    it("should reject identifiers with % character", () => {
      expect(() => {
        const context = createTestContext();
        // Create a schema with a table name containing %
        const badSchema = createSchemaRegistry([
          {
            ...taskRunsSchema,
            name: "task%runs",
          },
        ]);
        const badContext = createPrinterContext({
          organizationId: "org_test",
          projectId: "proj_test",
          environmentId: "env_test",
          schema: badSchema,
        });
        printQuery("SELECT * FROM `task%runs`", badContext);
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
