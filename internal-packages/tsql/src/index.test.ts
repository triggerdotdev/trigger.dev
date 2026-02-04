import { describe, it, expect } from "vitest";
import {
  compileTSQL,
  parseTSQLSelect,
  isColumnReferencedInExpression,
  createFallbackExpression,
  injectFallbackConditions,
  type WhereClauseCondition,
} from "./index.js";
import { column, type TableSchema } from "./query/schema.js";

/**
 * Test table schema for enforcedWhereClause tests
 */
const taskRunsSchema: TableSchema = {
  name: "task_runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    id: { name: "id", ...column("String") },
    status: { name: "status", ...column("String") },
    created_at: { name: "created_at", ...column("DateTime64") },
    updated_at: { name: "updated_at", ...column("DateTime64") },
    time: { name: "time", ...column("DateTime64") },
    triggered_at: { name: "triggered_at", ...column("DateTime64") },
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
 * Test table schema with tenant columns (lookup table with tenant isolation)
 */
const lookupTableSchema: TableSchema = {
  name: "lookup_table",
  clickhouseName: "trigger_dev.lookup_table",
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
  columns: {
    id: { name: "id", ...column("String") },
    name: { name: "name", ...column("String") },
  },
};

/**
 * Test table schema WITHOUT tenant columns (e.g., global reference data)
 */
// @ts-expect-error - tenant columns are required but not set
const nonTenantTableSchema: TableSchema = {
  name: "reference_data",
  clickhouseName: "trigger_dev.reference_data",
  // No tenantColumns - this is a global table
  columns: {
    id: { name: "id", ...column("String") },
    value: { name: "value", ...column("String") },
  },
};

/**
 * Base options with tenant isolation for tests
 */
const baseEnforcedWhereClause: Record<string, WhereClauseCondition> = {
  organization_id: { op: "eq", value: "org_test123" },
  project_id: { op: "eq", value: "proj_test456" },
  environment_id: { op: "eq", value: "env_test789" },
};

describe("isColumnReferencedInExpression", () => {
  it("should detect column in simple WHERE clause", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs WHERE time > '2024-01-01'");
    if (ast.expression_type === "select_query") {
      expect(isColumnReferencedInExpression(ast.where, "time")).toBe(true);
      expect(isColumnReferencedInExpression(ast.where, "status")).toBe(false);
    }
  });

  it("should detect column in AND expression", () => {
    const ast = parseTSQLSelect(
      "SELECT * FROM task_runs WHERE time > '2024-01-01' AND status = 'completed'"
    );
    if (ast.expression_type === "select_query") {
      expect(isColumnReferencedInExpression(ast.where, "time")).toBe(true);
      expect(isColumnReferencedInExpression(ast.where, "status")).toBe(true);
      expect(isColumnReferencedInExpression(ast.where, "id")).toBe(false);
    }
  });

  it("should detect column in OR expression", () => {
    const ast = parseTSQLSelect(
      "SELECT * FROM task_runs WHERE time > '2024-01-01' OR status = 'completed'"
    );
    if (ast.expression_type === "select_query") {
      expect(isColumnReferencedInExpression(ast.where, "time")).toBe(true);
      expect(isColumnReferencedInExpression(ast.where, "status")).toBe(true);
    }
  });

  it("should detect column in BETWEEN expression", () => {
    const ast = parseTSQLSelect(
      "SELECT * FROM task_runs WHERE time BETWEEN '2024-01-01' AND '2024-12-31'"
    );
    if (ast.expression_type === "select_query") {
      expect(isColumnReferencedInExpression(ast.where, "time")).toBe(true);
      expect(isColumnReferencedInExpression(ast.where, "status")).toBe(false);
    }
  });

  it("should detect column in qualified reference (table.column)", () => {
    const ast = parseTSQLSelect(
      "SELECT * FROM task_runs WHERE task_runs.time > '2024-01-01'"
    );
    if (ast.expression_type === "select_query") {
      expect(isColumnReferencedInExpression(ast.where, "time")).toBe(true);
    }
  });

  it("should return false for empty WHERE clause", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs");
    if (ast.expression_type === "select_query") {
      expect(isColumnReferencedInExpression(ast.where, "time")).toBe(false);
    }
  });

  it("should detect column in nested NOT expression", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs WHERE NOT time > '2024-01-01'");
    if (ast.expression_type === "select_query") {
      expect(isColumnReferencedInExpression(ast.where, "time")).toBe(true);
    }
  });
});

describe("createFallbackExpression", () => {
  it("should create a simple comparison expression (gt)", () => {
    const expr = createFallbackExpression("time", { op: "gt", value: "2024-01-01" });
    expect(expr.expression_type).toBe("compare_operation");
  });

  it("should create a simple comparison expression (eq)", () => {
    const expr = createFallbackExpression("status", { op: "eq", value: "completed" });
    expect(expr.expression_type).toBe("compare_operation");
  });

  it("should create a between expression", () => {
    const expr = createFallbackExpression("time", {
      op: "between",
      low: "2024-01-01",
      high: "2024-12-31",
    });
    expect(expr.expression_type).toBe("between_expr");
  });

  it("should convert Date values to ISO strings", () => {
    const date = new Date("2024-06-15T12:00:00Z");
    const expr = createFallbackExpression("time", { op: "gte", value: date });
    expect(expr.expression_type).toBe("compare_operation");
  });
});

describe("injectFallbackConditions", () => {
  it("should inject fallback when column is not in WHERE", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs WHERE status = 'completed'");
    const fallbacks: Record<string, WhereClauseCondition> = {
      time: { op: "gte", value: "2024-01-01" },
    };

    const modified = injectFallbackConditions(ast, fallbacks);
    if (modified.expression_type === "select_query") {
      expect(modified.where).toBeDefined();
      expect(isColumnReferencedInExpression(modified.where, "time")).toBe(true);
      expect(isColumnReferencedInExpression(modified.where, "status")).toBe(true);
    }
  });

  it("should NOT inject fallback when column is already in WHERE", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs WHERE time > '2024-06-01'");
    const fallbacks: Record<string, WhereClauseCondition> = {
      time: { op: "gte", value: "2024-01-01" },
    };

    const modified = injectFallbackConditions(ast, fallbacks);
    // The WHERE clause should remain as is (no additional time condition)
    if (modified.expression_type === "select_query" && modified.where) {
      // It should not be an AND expression - it should be the original compare_operation
      expect(modified.where.expression_type).toBe("compare_operation");
    }
  });

  it("should inject fallback when query has no WHERE clause", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs LIMIT 10");
    const fallbacks: Record<string, WhereClauseCondition> = {
      time: { op: "gte", value: "2024-01-01" },
    };

    const modified = injectFallbackConditions(ast, fallbacks);
    if (modified.expression_type === "select_query") {
      expect(modified.where).toBeDefined();
      expect(isColumnReferencedInExpression(modified.where, "time")).toBe(true);
    }
  });

  it("should inject multiple fallbacks", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs LIMIT 10");
    const fallbacks: Record<string, WhereClauseCondition> = {
      time: { op: "gte", value: "2024-01-01" },
      status: { op: "eq", value: "completed" },
    };

    const modified = injectFallbackConditions(ast, fallbacks);
    if (modified.expression_type === "select_query") {
      expect(modified.where).toBeDefined();
      expect(isColumnReferencedInExpression(modified.where, "time")).toBe(true);
      expect(isColumnReferencedInExpression(modified.where, "status")).toBe(true);
    }
  });

  it("should only inject fallbacks for unreferenced columns", () => {
    const ast = parseTSQLSelect("SELECT * FROM task_runs WHERE time > '2024-06-01'");
    const fallbacks: Record<string, WhereClauseCondition> = {
      time: { op: "gte", value: "2024-01-01" }, // Should NOT be injected
      status: { op: "eq", value: "completed" }, // Should be injected
    };

    const modified = injectFallbackConditions(ast, fallbacks);
    if (modified.expression_type === "select_query" && modified.where) {
      // Should be an AND expression combining fallback status with original time
      expect(modified.where.expression_type).toBe("and");
    }
  });
});

describe("compileTSQL with whereClauseFallback", () => {
  const baseOptions = {
    tableSchema: [taskRunsSchema],
    enforcedWhereClause: baseEnforcedWhereClause,
  };

  describe("simple comparison fallbacks", () => {
    it("should apply gt fallback when column not in WHERE", () => {
      const { sql } = compileTSQL("SELECT * FROM task_runs WHERE status = 'completed'", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "gt", value: "2024-01-01" },
        },
      });

      // Should contain a time comparison
      expect(sql).toContain("time");
      expect(sql).toContain("greater(");
    });

    it("should apply gte fallback when column not in WHERE", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "gte", value: "2024-01-01" },
        },
      });

      expect(sql).toContain("greaterOrEquals(");
    });

    it("should apply lt fallback when column not in WHERE", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "lt", value: "2024-12-31" },
        },
      });

      expect(sql).toContain("less(");
    });

    it("should apply lte fallback when column not in WHERE", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "lte", value: "2024-12-31" },
        },
      });

      expect(sql).toContain("lessOrEquals(");
    });

    it("should apply eq fallback when column not in WHERE", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          status: { op: "eq", value: "completed" },
        },
      });

      expect(sql).toContain("equals(");
      expect(sql).toContain("status");
    });

    it("should apply neq fallback when column not in WHERE", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          status: { op: "neq", value: "failed" },
        },
      });

      expect(sql).toContain("notEquals(");
      expect(sql).toContain("status");
    });
  });

  describe("between fallback", () => {
    it("should apply BETWEEN fallback when column not in WHERE", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs WHERE status = 'completed'", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "between", low: "2024-01-01", high: "2024-12-31" },
        },
      });

      expect(sql).toContain("time BETWEEN");
    });

    it("should apply BETWEEN fallback with Date values", () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-12-31T23:59:59Z");

      const { sql, params } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "between", low: startDate, high: endDate },
        },
      });

      expect(sql).toContain("time BETWEEN");
      // The dates should be converted to ISO strings and parameterized
      expect(Object.values(params).some((v) => typeof v === "string" && v.includes("2024"))).toBe(
        true
      );
    });
  });

  describe("fallback NOT applied when column already filtered", () => {
    it("should NOT apply fallback when column is in simple WHERE", () => {
      const { sql } = compileTSQL("SELECT * FROM task_runs WHERE time > '2024-06-01'", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "gte", value: "2024-01-01" },
        },
      });

      // Should only have the user's time condition, not the fallback
      // Count occurrences of time comparison - should be 1 (just the user's)
      const timeMatches = sql.match(/greater\(.*?time/g) || [];
      expect(timeMatches.length).toBe(1);
    });

    it("should NOT apply fallback when column is in BETWEEN expression", () => {
      const { sql } = compileTSQL(
        "SELECT * FROM task_runs WHERE time BETWEEN '2024-06-01' AND '2024-06-30'",
        {
          ...baseOptions,
          whereClauseFallback: {
            time: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // Should have the user's BETWEEN, not the fallback gte
      expect(sql).toContain("time BETWEEN");
      expect(sql).not.toContain("greaterOrEquals(");
    });

    it("should NOT apply fallback when column is in AND expression", () => {
      const { sql } = compileTSQL(
        "SELECT * FROM task_runs WHERE status = 'completed' AND time > '2024-06-01'",
        {
          ...baseOptions,
          whereClauseFallback: {
            time: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // Should only have one time comparison
      const timeMatches = sql.match(/greater\(.*?time/g) || [];
      expect(timeMatches.length).toBe(1);
    });

    it("should NOT apply fallback when column is in OR expression", () => {
      const { sql } = compileTSQL(
        "SELECT * FROM task_runs WHERE status = 'completed' OR time > '2024-06-01'",
        {
          ...baseOptions,
          whereClauseFallback: {
            time: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // Fallback should not be applied since time is mentioned in OR
      const timeGreaterMatches = sql.match(/greater\(.*?time/g) || [];
      expect(timeGreaterMatches.length).toBe(1);
    });

    it("should NOT apply fallback when column is in qualified reference", () => {
      const { sql } = compileTSQL(
        "SELECT * FROM task_runs WHERE task_runs.time > '2024-06-01'",
        {
          ...baseOptions,
          whereClauseFallback: {
            time: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // Fallback should not be applied
      const timeGreaterMatches = sql.match(/greater.*time/g) || [];
      expect(timeGreaterMatches.length).toBe(1);
    });
  });

  describe("multiple fallbacks", () => {
    it("should apply multiple fallbacks for different unreferenced columns", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "gte", value: "2024-01-01" },
          status: { op: "eq", value: "completed" },
        },
      });

      expect(sql).toContain("greaterOrEquals(");
      expect(sql).toContain("time");
      expect(sql).toContain("equals(");
      expect(sql).toContain("status");
    });

    it("should only apply fallbacks for unreferenced columns when some are filtered", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs WHERE time > '2024-06-01'", {
        ...baseOptions,
        whereClauseFallback: {
          time: { op: "gte", value: "2024-01-01" }, // Should NOT be applied
          status: { op: "eq", value: "completed" }, // Should be applied
        },
      });

      // Status fallback should be applied
      expect(sql).toContain("equals(");
      expect(sql).toContain("status");

      // Time should only have user's condition
      const timeGreaterMatches = sql.match(/greater\(.*?time/g) || [];
      expect(timeGreaterMatches.length).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("should handle empty whereClauseFallback", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {},
      });

      // Should just compile normally without errors
      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM");
    });

    it("should handle undefined whereClauseFallback", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        // whereClauseFallback is undefined
      });

      // Should just compile normally without errors
      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM");
    });

    it("should work with UNION queries", () => {
      const { sql } = compileTSQL(
        "SELECT id FROM task_runs WHERE status = 'completed' UNION ALL SELECT id FROM task_runs WHERE status = 'failed'",
        {
          ...baseOptions,
          whereClauseFallback: {
            time: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // Both queries in the UNION should have the time fallback
      const timeMatches = sql.match(/greaterOrEquals\(.*?time/g) || [];
      expect(timeMatches.length).toBe(2);
    });

    it("should handle numeric values in fallback", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        ...baseOptions,
        whereClauseFallback: {
          id: { op: "gt", value: 100 },
        },
      });

      expect(sql).toContain("greater(");
      expect(sql).toContain("100");
    });
  });
});

describe("compileTSQL with enforcedWhereClause", () => {
  describe("validation tests", () => {
    it("should throw error when required tenant column is missing", () => {
      expect(() =>
        compileTSQL("SELECT id FROM task_runs", {
          tableSchema: [taskRunsSchema],
          enforcedWhereClause: {}, // Missing organization_id
        })
      ).toThrow("Table 'task_runs' requires 'organization_id' in enforcedWhereClause");
    });

    it("should throw error when organization_id is missing but other tenant columns are present", () => {
      expect(() =>
        compileTSQL("SELECT id FROM task_runs", {
          tableSchema: [taskRunsSchema],
          enforcedWhereClause: {
            project_id: { op: "eq", value: "proj_123" },
            environment_id: { op: "eq", value: "env_456" },
          },
        })
      ).toThrow("Table 'task_runs' requires 'organization_id' in enforcedWhereClause");
    });

    it("should work with non-tenant table and empty enforcedWhereClause", () => {
      const { sql } = compileTSQL("SELECT id FROM reference_data", {
        tableSchema: [nonTenantTableSchema],
        enforcedWhereClause: {},
      });

      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM");
    });

    it("should work with only organization_id (project and env are optional)", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
        },
      });

      expect(sql).toContain("organization_id");
      expect(sql).not.toContain("project_id");
      expect(sql).not.toContain("environment_id");
    });
  });

  describe("basic functionality", () => {
    it("should apply single enforced condition", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
        },
      });

      expect(sql).toContain("equals(");
      expect(sql).toContain("organization_id");
    });

    it("should apply multiple enforced conditions", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          project_id: { op: "eq", value: "proj_456" },
          environment_id: { op: "eq", value: "env_789" },
        },
      });

      expect(sql).toContain("organization_id");
      expect(sql).toContain("project_id");
      expect(sql).toContain("environment_id");
    });

    it("should apply enforced condition even when user filters on same field", () => {
      const { sql } = compileTSQL(
        "SELECT id FROM task_runs WHERE triggered_at > '2025-01-01'",
        {
          tableSchema: [taskRunsSchema],
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_123" },
            triggered_at: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // Should have BOTH the user's condition AND the enforced condition
      // User's condition: greater(triggered_at, '2025-01-01')
      // Enforced condition: greaterOrEquals(triggered_at, '2024-01-01')
      const triggeredAtMatches = sql.match(/triggered_at/g) || [];
      expect(triggeredAtMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("should apply different comparison operators", () => {
      const { sql: sqlGt } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          time: { op: "gt", value: "2024-01-01" },
        },
      });
      expect(sqlGt).toContain("greater(");

      const { sql: sqlLt } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          time: { op: "lt", value: "2024-12-31" },
        },
      });
      expect(sqlLt).toContain("less(");

      const { sql: sqlNeq } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          status: { op: "neq", value: "deleted" },
        },
      });
      expect(sqlNeq).toContain("notEquals(");
    });

    it("should apply BETWEEN condition", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          time: { op: "between", low: "2024-01-01", high: "2024-12-31" },
        },
      });

      expect(sql).toContain("time BETWEEN");
    });

    it("should handle Date values in enforced conditions", () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const { sql, params } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          triggered_at: { op: "gte", value: sevenDaysAgo },
        },
      });

      expect(sql).toContain("triggered_at");
      expect(sql).toContain("toDateTime64");
    });
  });

  describe("enforcedWhereClause + whereClauseFallback interaction", () => {
    it("should apply both enforced and fallback conditions when user doesn't filter", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          triggered_at: { op: "gte", value: "2024-01-01" },
        },
        whereClauseFallback: {
          status: { op: "eq", value: "completed" },
        },
      });

      // Should have both enforced (triggered_at) and fallback (status)
      expect(sql).toContain("triggered_at");
      expect(sql).toContain("status");
    });

    it("should apply enforced but not fallback when user filters on fallback column", () => {
      const { sql, params } = compileTSQL(
        "SELECT id FROM task_runs WHERE status = 'failed'",
        {
          tableSchema: [taskRunsSchema],
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_123" },
            triggered_at: { op: "gte", value: "2024-01-01" },
          },
          whereClauseFallback: {
            status: { op: "eq", value: "completed" },
          },
        }
      );

      // Enforced triggered_at should be applied
      expect(sql).toContain("triggered_at");
      // User's status = 'failed' should be there (as a parameter)
      expect(Object.values(params)).toContain("failed");
      // The fallback 'completed' should NOT be applied since user filtered on status
      expect(Object.values(params)).not.toContain("completed");
    });

    it("should apply both enforced and fallback on same field (enforced always, fallback only if not filtered)", () => {
      // User doesn't filter on triggered_at, so BOTH enforced AND fallback apply
      const { sql } = compileTSQL("SELECT id FROM task_runs WHERE status = 'completed'", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          triggered_at: { op: "gte", value: "2024-06-01" }, // Enforced: last 6 months
        },
        whereClauseFallback: {
          triggered_at: { op: "gte", value: "2024-01-01" }, // Fallback: last year
        },
      });

      // Both should be applied (enforced at printer level, fallback at AST level)
      const triggeredAtMatches = sql.match(/triggered_at/g) || [];
      expect(triggeredAtMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("should skip fallback but keep enforced when user filters on same field", () => {
      const { sql } = compileTSQL(
        "SELECT id FROM task_runs WHERE triggered_at > '2025-01-01'",
        {
          tableSchema: [taskRunsSchema],
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_123" },
            triggered_at: { op: "gte", value: "2024-06-01" }, // Enforced: always applied
          },
          whereClauseFallback: {
            triggered_at: { op: "gte", value: "2024-01-01" }, // Fallback: skipped since user filtered
          },
        }
      );

      // User's condition + enforced should be present
      // Fallback should NOT be applied since user filtered on triggered_at
      // Count distinct triggered_at conditions
      const triggeredAtMatches = sql.match(/triggered_at/g) || [];
      // Should be 2: user's condition + enforced condition (NOT 3, no fallback)
      expect(triggeredAtMatches.length).toBe(2);
    });
  });

  describe("security tests", () => {
    it("should apply enforced conditions to UNION queries", () => {
      const { sql } = compileTSQL(
        "SELECT id FROM task_runs WHERE status = 'completed' UNION ALL SELECT id FROM task_runs WHERE status = 'failed'",
        {
          tableSchema: [taskRunsSchema],
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_123" },
            triggered_at: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // Both parts of the UNION should have the enforced conditions
      const orgMatches = sql.match(/organization_id/g) || [];
      expect(orgMatches.length).toBe(2);

      const triggeredAtMatches = sql.match(/triggered_at/g) || [];
      expect(triggeredAtMatches.length).toBe(2);
    });

    it("should NOT be bypassable via OR clause", () => {
      const { sql } = compileTSQL(
        "SELECT id FROM task_runs WHERE status = 'completed' OR 1=1",
        {
          tableSchema: [taskRunsSchema],
          enforcedWhereClause: {
            organization_id: { op: "eq", value: "org_123" },
            triggered_at: { op: "gte", value: "2024-01-01" },
          },
        }
      );

      // The enforced conditions should be ANDed with the entire user WHERE clause
      // So the structure should be: (enforced AND enforced AND ...) AND (user_where)
      expect(sql).toContain("organization_id");
      expect(sql).toContain("triggered_at");
      // The 1=1 should be within the user's OR clause, not affecting enforced conditions
    });

    it("should skip enforced conditions for columns that don't exist in table", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
          nonexistent_column: { op: "eq", value: "test" },
        },
      });

      // Should not contain nonexistent_column
      expect(sql).not.toContain("nonexistent_column");
      // Should still have organization_id
      expect(sql).toContain("organization_id");
    });
  });

  describe("edge cases", () => {
    it("should handle empty enforced conditions for non-tenant table", () => {
      const { sql } = compileTSQL("SELECT id FROM reference_data", {
        tableSchema: [nonTenantTableSchema],
        enforcedWhereClause: {},
      });

      expect(sql).toContain("SELECT");
      expect(sql).not.toContain("WHERE"); // No WHERE clause needed
    });

    it("should properly format numeric values", () => {
      const { sql } = compileTSQL("SELECT id FROM task_runs", {
        tableSchema: [taskRunsSchema],
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "org_123" },
        },
      });

      // org_123 should be parameterized, not inlined
      expect(sql).toContain("tsql_val_");
    });
  });
});

