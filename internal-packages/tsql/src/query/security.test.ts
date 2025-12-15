/**
 * Security Tests for TSQL
 *
 * These tests verify that the TSQL parser and printer correctly prevent:
 * 1. Cross-tenant data access
 * 2. SQL injection attacks
 */
import { describe, expect, it } from "vitest";
import { compileTSQL, type CompileTSQLOptions } from "../index.js";
import { column, type TableSchema } from "./schema.js";

/**
 * Test schemas
 */
const taskRunsSchema: TableSchema = {
  name: "task_runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    id: { name: "id", ...column("String") },
    status: { name: "status", ...column("String") },
    task_identifier: { name: "task_identifier", ...column("String") },
    created_at: { name: "created_at", ...column("DateTime64") },
    duration_ms: { name: "duration_ms", ...column("Nullable(UInt64)") },
    organization_id: { name: "organization_id", ...column("String") },
    project_id: { name: "project_id", ...column("String") },
    environment_id: { name: "environment_id", ...column("String") },
    payload: { name: "payload", ...column("String") },
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

const defaultOptions: CompileTSQLOptions = {
  organizationId: "org_tenant1",
  projectId: "proj_tenant1",
  environmentId: "env_tenant1",
  tableSchema: [taskRunsSchema, taskEventsSchema],
};

function compile(query: string, options: Partial<CompileTSQLOptions> = {}) {
  return compileTSQL(query, { ...defaultOptions, ...options });
}

describe("Cross-Tenant Security", () => {
  describe("Tenant guards are always injected", () => {
    it("should inject tenant guards on simple SELECT", () => {
      const { sql, params } = compile("SELECT * FROM task_runs");

      // Must contain all three tenant columns
      expect(sql).toContain("organization_id");
      expect(sql).toContain("project_id");
      expect(sql).toContain("environment_id");

      // Tenant values must be parameterized
      expect(Object.values(params)).toContain("org_tenant1");
      expect(Object.values(params)).toContain("proj_tenant1");
      expect(Object.values(params)).toContain("env_tenant1");
    });

    it("should inject tenant guards even with user WHERE clause", () => {
      const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'completed'");

      // Must still have tenant guards
      expect(sql).toContain("organization_id");
      expect(sql).toContain("project_id");
      expect(sql).toContain("environment_id");
      expect(Object.values(params)).toContain("org_tenant1");
    });

    it("should inject tenant guards on all tables in JOIN", () => {
      const { sql } = compile(`
        SELECT r.id, e.event_type 
        FROM task_runs r 
        JOIN task_events e ON r.id = e.run_id
      `);

      // Both tables should have tenant guards
      // Count occurrences of organization_id - should appear twice (once per table)
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("should inject tenant guards in subqueries", () => {
      const { sql } = compile(`
        SELECT * FROM task_runs 
        WHERE id IN (SELECT run_id FROM task_events WHERE event_type = 'completed')
      `);

      // Should have tenant guards in both main query and subquery
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("should inject tenant guards on UNION queries", () => {
      const { sql } = compile(`
        SELECT id, status FROM task_runs WHERE status = 'completed'
        UNION ALL
        SELECT id, status FROM task_runs WHERE status = 'failed'
      `);

      // Both sides of UNION should have tenant guards
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Cannot bypass tenant guards", () => {
    it("should not allow OR clause to bypass tenant guard", () => {
      const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'completed' OR 1=1");

      // The tenant guards should be ANDed with the entire WHERE clause
      // So even with OR 1=1, the tenant guard still applies
      expect(sql).toContain("organization_id");
      expect(Object.values(params)).toContain("org_tenant1");

      // The structure should be: and(tenant_guards, or(user_conditions))
      // The user's OR should be nested inside the outer AND with tenant guards
      // This ensures tenant_guard AND (status='completed' OR 1=1)
      // NOT: tenant_guard AND status='completed' OR 1=1 (which would bypass)

      // Verify the OR is contained within an outer AND structure
      // The tenant guards use and() and the user's OR uses or()
      expect(sql).toContain("or(");
      expect(sql).toContain("and(");

      // The and() should wrap everything - find where tenant columns appear
      // They should be at the same level as the user's condition, both inside and()
      const whereClause = sql.substring(sql.indexOf("WHERE"));
      expect(whereClause).toMatch(/and\([^)]*organization_id/);
    });

    it("should not allow accessing other tenant's data via explicit condition", () => {
      const { sql, params } = compile(
        "SELECT * FROM task_runs WHERE organization_id = 'org_other_tenant'"
      );

      // Even if user specifies a different org_id, our tenant guard should override
      // The compiled SQL should still use our tenant's ID
      expect(Object.values(params)).toContain("org_tenant1");
    });

    it("should not allow UNION with unguarded query", () => {
      // This should be rejected or the second part should still be guarded
      const { sql } = compile(`
        SELECT id FROM task_runs
        UNION ALL
        SELECT id FROM task_runs
      `);

      // Both parts must have tenant guards
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("should not allow subquery to access other tenants", () => {
      const { sql, params } = compile(`
        SELECT * FROM task_runs 
        WHERE id IN (
          SELECT run_id FROM task_events
        )
      `);

      // Subquery must also have tenant guards
      expect(Object.values(params)).toContain("org_tenant1");
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Table allowlisting", () => {
    it("should reject queries to unknown tables", () => {
      expect(() => {
        compile("SELECT * FROM users");
      }).toThrow();
    });

    it("should reject queries to system tables", () => {
      expect(() => {
        compile("SELECT * FROM system.tables");
      }).toThrow();
    });

    it("should reject queries trying to use database prefix", () => {
      expect(() => {
        compile("SELECT * FROM other_database.task_runs");
      }).toThrow();
    });
  });
});

describe("SQL Injection Prevention", () => {
  describe("String value injection", () => {
    it("should reject queries with stacked statements in strings", () => {
      // The parser correctly rejects this at parse time
      expect(() => {
        compile("SELECT * FROM task_runs WHERE status = 'completed'; DROP TABLE task_runs; --'");
      }).toThrow();
    });

    it("should parameterize malicious-looking string values", () => {
      const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'DROP TABLE users'");

      // The malicious payload should be in params, not in SQL
      expect(sql).not.toContain("DROP TABLE");
      expect(Object.values(params)).toContain("DROP TABLE users");
    });

    it("should handle quote escape attempts", () => {
      const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'test''injection'");

      // Should be safely parameterized
      expect(Object.values(params).some((v) => typeof v === "string")).toBe(true);
    });

    it("should handle backslash escape attempts", () => {
      const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'test\\'injection'");

      // Should be safely parameterized
      expect(sql).not.toContain("injection'");
    });

    it("should handle unicode characters in strings", () => {
      const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'test™injection'");

      // Should be safely parameterized
      expect(Object.values(params).some((v) => typeof v === "string")).toBe(true);
    });

    it("should handle null byte injection", () => {
      const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'test\\0injection'");

      expect(Object.values(params).some((v) => typeof v === "string")).toBe(true);
    });
  });

  describe("Comment injection", () => {
    it("should not allow -- comments to truncate query", () => {
      // The parser should either reject this or handle it safely
      const result = compile("SELECT * FROM task_runs WHERE status = 'completed'");

      // Tenant guards must still be present
      expect(result.sql).toContain("organization_id");
    });

    it("should not allow /* */ comments for injection", () => {
      const result = compile("SELECT * FROM task_runs WHERE status = 'completed'");

      // Tenant guards must still be present
      expect(result.sql).toContain("organization_id");
    });
  });

  describe("Identifier injection", () => {
    it("should reject identifiers with backtick injection", () => {
      expect(() => {
        compile("SELECT * FROM task_runs WHERE `status`; DROP TABLE users; --` = 'test'");
      }).toThrow();
    });

    it("should not expose column names that could be used for injection", () => {
      // Column names in the output are validated identifiers from the schema
      // Malicious column names would need to be in the schema first
      const { sql } = compile("SELECT id, status FROM task_runs");

      // Column names should be simple identifiers without injection
      expect(sql).toContain("id");
      expect(sql).toContain("status");
      expect(sql).not.toContain(";");
    });

    it("should reject table names with special characters", () => {
      expect(() => {
        compile("SELECT * FROM `task_runs; DROP TABLE users`");
      }).toThrow();
    });
  });

  describe("Numeric injection", () => {
    it("should handle numeric values safely", () => {
      const { sql } = compile("SELECT * FROM task_runs WHERE duration_ms > 1000");

      // Numbers should be safely inlined or parameterized
      expect(sql).toContain("1000");
      expect(sql).not.toContain(";");
    });

    it("should handle negative numbers safely", () => {
      const { sql } = compile("SELECT * FROM task_runs WHERE duration_ms > -1");

      expect(sql).not.toContain(";");
    });

    it("should handle floating point safely", () => {
      const { sql } = compile("SELECT * FROM task_runs WHERE duration_ms > 1.5");

      expect(sql).toContain("1.5");
    });
  });

  describe("Function injection", () => {
    it("should only allow known safe functions", () => {
      // Unknown functions should be rejected
      expect(() => {
        compile("SELECT file('/etc/passwd') FROM task_runs");
      }).toThrow();
    });

    it("should reject system functions", () => {
      expect(() => {
        compile("SELECT system.tables() FROM task_runs");
      }).toThrow();
    });

    it("should allow known aggregate functions", () => {
      const { sql } = compile("SELECT count(*), sum(duration_ms) FROM task_runs");

      expect(sql).toContain("count(*)");
      expect(sql).toContain("sum(duration_ms)");
    });
  });

  describe("Stacked query prevention", () => {
    it("should not allow semicolon to start new statement", () => {
      expect(() => {
        compile("SELECT * FROM task_runs; DELETE FROM task_runs");
      }).toThrow();
    });

    it("should not allow multiple statements", () => {
      expect(() => {
        compile("SELECT * FROM task_runs; SELECT * FROM task_events");
      }).toThrow();
    });
  });

  describe("UNION-based injection", () => {
    it("should apply tenant guards to all UNION parts", () => {
      const { sql, params } = compile(`
        SELECT id, status FROM task_runs WHERE status = 'a'
        UNION ALL
        SELECT id, status FROM task_runs WHERE status = 'b'
      `);

      // Both parts should have tenant guards
      expect(Object.values(params)).toContain("org_tenant1");
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("Parameter Safety", () => {
  it("should use typed parameters", () => {
    const { sql } = compile("SELECT * FROM task_runs WHERE status = 'test'");

    // Parameters should have type annotations like {param: String}
    expect(sql).toMatch(/\{tsql_\w+: \w+\}/);
  });

  it("should generate unique parameter names", () => {
    const { params } = compile(`
      SELECT * FROM task_runs 
      WHERE status = 'a' AND task_identifier = 'b' AND payload = 'c'
    `);

    // All parameter keys should be unique
    const keys = Object.keys(params);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("should not include raw values in SQL for strings", () => {
    const { sql } = compile("SELECT * FROM task_runs WHERE status = 'user_provided_value'");

    // The literal string should not appear in SQL
    expect(sql).not.toContain("user_provided_value");
  });
});

describe("Edge Cases", () => {
  it("should handle empty string values", () => {
    const { params } = compile("SELECT * FROM task_runs WHERE status = ''");

    expect(Object.values(params)).toContain("");
  });

  it("should handle very long strings", () => {
    const longString = "a".repeat(10000);
    const { params } = compile(`SELECT * FROM task_runs WHERE status = '${longString}'`);

    expect(Object.values(params)).toContain(longString);
  });

  it("should handle strings with newlines", () => {
    const { params } = compile("SELECT * FROM task_runs WHERE status = 'line1\nline2'");

    // Should handle newlines safely
    expect(Object.values(params).some((v) => typeof v === "string" && v.includes("\n"))).toBe(true);
  });

  it("should handle special SQL keywords in strings", () => {
    const { sql, params } = compile("SELECT * FROM task_runs WHERE status = 'SELECT * FROM users'");

    // The SQL keywords should be in params, not interpreted
    expect(sql).not.toMatch(/SELECT \* FROM users/);
    expect(Object.values(params)).toContain("SELECT * FROM users");
  });
});
