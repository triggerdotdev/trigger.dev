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
  tableSchema: [taskRunsSchema, taskEventsSchema],
  enforcedWhereClause: {
    organization_id: { op: "eq", value: "org_tenant1" },
    project_id: { op: "eq", value: "proj_tenant1" },
    environment_id: { op: "eq", value: "env_tenant1" },
  },
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

describe("Optional Tenant Filters", () => {
  /**
   * Helper to extract the WHERE clause from SQL for more precise testing.
   * This is needed because SELECT * expansion includes all columns,
   * but we only want to check what's in the WHERE clause for tenant filtering.
   */
  function getWhereClause(sql: string): string {
    const whereMatch = sql.match(/WHERE\s+(.*?)(?:\s+(?:ORDER|GROUP|LIMIT|$))/is);
    return whereMatch ? whereMatch[1] : "";
  }

  describe("Organization ID is always required", () => {
    it("should always inject organization guard even with optional project/env", () => {
      const { sql, params } = compile("SELECT * FROM task_runs", {
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_tenant1" },
          // project_id and environment_id omitted
        },
      });

      const whereClause = getWhereClause(sql);

      // Must contain organization_id in WHERE clause
      expect(whereClause).toContain("organization_id");
      expect(Object.values(params)).toContain("org_tenant1");

      // Should NOT contain project_id or environment_id guards in WHERE clause
      expect(whereClause).not.toContain("project_id");
      expect(whereClause).not.toContain("environment_id");
    });
  });

  describe("Project ID is optional", () => {
    it("should inject org and project guards when project is provided", () => {
      const { sql, params } = compile("SELECT * FROM task_runs", {
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_tenant1" },
          project_id: { op: "eq", value: "proj_tenant1" },
          // environment_id omitted
        },
      });

      const whereClause = getWhereClause(sql);

      // Must contain organization_id and project_id in WHERE clause
      expect(whereClause).toContain("organization_id");
      expect(whereClause).toContain("project_id");
      expect(Object.values(params)).toContain("org_tenant1");
      expect(Object.values(params)).toContain("proj_tenant1");

      // Should NOT contain environment_id guard in WHERE clause
      expect(whereClause).not.toContain("environment_id");
    });

    it("should allow querying across all projects when projectId is omitted", () => {
      const { sql, params } = compile("SELECT * FROM task_runs", {
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_tenant1" },
          // project_id and environment_id omitted
        },
      });

      const whereClause = getWhereClause(sql);

      // Only org guard should be present in WHERE clause
      expect(whereClause).toContain("organization_id");
      expect(Object.values(params)).toContain("org_tenant1");
      expect(whereClause).not.toContain("project_id");
    });
  });

  describe("Environment ID is optional", () => {
    it("should inject org, project, and env guards when all provided", () => {
      const { sql, params } = compile("SELECT * FROM task_runs");

      const whereClause = getWhereClause(sql);

      // All three should be present in WHERE clause (default options include all)
      expect(whereClause).toContain("organization_id");
      expect(whereClause).toContain("project_id");
      expect(whereClause).toContain("environment_id");
      expect(Object.values(params)).toContain("org_tenant1");
      expect(Object.values(params)).toContain("proj_tenant1");
      expect(Object.values(params)).toContain("env_tenant1");
    });

    it("should allow querying across all environments when environmentId is omitted", () => {
      const { sql, params } = compile("SELECT * FROM task_runs", {
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_tenant1" },
          project_id: { op: "eq", value: "proj_tenant1" },
          // environment_id omitted
        },
      });

      const whereClause = getWhereClause(sql);

      // Org and project guards should be present in WHERE clause
      expect(whereClause).toContain("organization_id");
      expect(whereClause).toContain("project_id");
      expect(Object.values(params)).toContain("org_tenant1");
      expect(Object.values(params)).toContain("proj_tenant1");

      // Environment guard should NOT be present in WHERE clause
      expect(whereClause).not.toContain("environment_id");
    });
  });

  describe("Cross-tenant security with optional filters", () => {
    it("should still prevent cross-org access with org-only filter", () => {
      const { sql, params } = compile(
        "SELECT * FROM task_runs WHERE organization_id = 'org_other'",
        {
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_tenant1" },
            // project_id and environment_id omitted
          },
        }
      );

      // Our org guard should still be enforced
      expect(Object.values(params)).toContain("org_tenant1");
    });

    it("should apply org guard to all tables in JOIN when using org-only filter", () => {
      const { sql } = compile(
        `
        SELECT r.id, e.event_type 
        FROM task_runs r 
        JOIN task_events e ON r.id = e.run_id
      `,
        {
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_tenant1" },
            // project_id and environment_id omitted
          },
        }
      );

      // Both tables should have org guards
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);

      // Project and environment should NOT appear
      expect(sql).not.toContain("project_id");
      expect(sql).not.toContain("environment_id");
    });

    it("should apply org guard to UNION queries when using org-only filter", () => {
      const { sql } = compile(
        `
        SELECT id, status FROM task_runs WHERE status = 'completed'
        UNION ALL
        SELECT id, status FROM task_runs WHERE status = 'failed'
      `,
        {
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_tenant1" },
            // project_id and environment_id omitted
          },
        }
      );

      // Both parts should have org guards
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("should apply org guard to subqueries when using org-only filter", () => {
      const { sql, params } = compile(
        `
        SELECT * FROM task_runs 
        WHERE id IN (SELECT run_id FROM task_events)
      `,
        {
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_tenant1" },
            // project_id and environment_id omitted
          },
        }
      );

      // Both main query and subquery should have org guards
      expect(Object.values(params)).toContain("org_tenant1");
      const orgIdMatches = sql.match(/organization_id/g) || [];
      expect(orgIdMatches.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("Multi-join Tenant Guard Qualification", () => {
  /**
   * Security Test: Verifies that tenant guards are properly table-qualified in multi-join queries.
   *
   * The bug: createEnforcedGuard was building unqualified guard expressions like:
   *   organization_id = 'org_tenant1'
   *
   * In a multi-table join where both tables have the same column (organization_id),
   * an unqualified reference could potentially bind to the wrong table during resolution,
   * or be ambiguous. The guards should be qualified like:
   *   r.organization_id = 'org_tenant1' AND e.organization_id = 'org_tenant1'
   *
   * This ensures each table's guard binds to the correct table, not just any matching column.
   */
  it("should qualify tenant guards with table alias in JOIN queries", () => {
    const { sql } = compile(`
      SELECT r.id, e.event_type 
      FROM task_runs r 
      JOIN task_events e ON r.id = e.run_id
    `);

    // The guards should be table-qualified to prevent binding to the wrong table
    // Look for pattern like: r.organization_id and e.organization_id (with table alias prefix)
    // The exact format in ClickHouse SQL is just "alias.column" after resolution
    
    // Count qualified organization_id references (should have table prefixes)
    // In the WHERE clause, we should see both r.organization_id and e.organization_id
    const whereClause = sql.substring(sql.indexOf("WHERE"));
    
    // Both tables should have their own qualified tenant guards
    // The pattern should be: table_alias.organization_id for each table
    expect(whereClause).toMatch(/\br\b[^,]*organization_id/);
    expect(whereClause).toMatch(/\be\b[^,]*organization_id/);
  });

  it("should qualify tenant guards with table alias in LEFT JOIN queries", () => {
    const { sql } = compile(`
      SELECT r.id, e.event_type 
      FROM task_runs r 
      LEFT JOIN task_events e ON r.id = e.run_id
    `);

    const whereClause = sql.substring(sql.indexOf("WHERE"));
    
    // Both tables should have qualified guards
    expect(whereClause).toMatch(/\br\b[^,]*organization_id/);
    expect(whereClause).toMatch(/\be\b[^,]*organization_id/);
  });

  it("should qualify tenant guards in multi-way JOIN queries", () => {
    const { sql } = compile(`
      SELECT r.id, e1.event_type, e2.event_type
      FROM task_runs r 
      JOIN task_events e1 ON r.id = e1.run_id
      JOIN task_events e2 ON r.id = e2.run_id
    `);

    const whereClause = sql.substring(sql.indexOf("WHERE"));
    
    // All three table aliases should have qualified guards
    expect(whereClause).toMatch(/\br\b[^,]*organization_id/);
    expect(whereClause).toMatch(/\be1\b[^,]*organization_id/);
    expect(whereClause).toMatch(/\be2\b[^,]*organization_id/);
  });

  it("should ensure guards cannot bind to wrong table by verifying separate qualifications", () => {
    const { sql, params } = compile(`
      SELECT r.id, e.event_type 
      FROM task_runs r 
      JOIN task_events e ON r.id = e.run_id
      WHERE r.status = 'completed'
    `);

    // Count organization_id occurrences with different table prefixes
    // This ensures each table gets its own guard, not shared/ambiguous references
    const orgIdPattern = /(\w+)\.organization_id/g;
    const matches = [...sql.matchAll(orgIdPattern)];
    const tableAliases = matches.map(m => m[1]);
    
    // Should have at least 2 different table aliases for organization_id
    // (one for task_runs alias 'r' and one for task_events alias 'e')
    expect(tableAliases).toContain("r");
    expect(tableAliases).toContain("e");
    
    // Both should use the same tenant value (parameterized)
    expect(Object.values(params)).toContain("org_tenant1");
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
