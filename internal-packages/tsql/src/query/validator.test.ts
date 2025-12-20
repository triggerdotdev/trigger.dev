import { describe, it, expect } from "vitest";
import { validateQuery } from "./validator.js";
import { parseTSQLSelect } from "../index.js";
import { column, type TableSchema } from "./schema.js";

const runsSchema: TableSchema = {
  name: "runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    id: { name: "id", ...column("String") },
    status: {
      name: "status",
      ...column("String", {
        allowedValues: ["PENDING", "COMPLETED", "FAILED"],
      }),
    },
    task_id: { name: "task_id", ...column("String") },
    created_at: { name: "created_at", ...column("DateTime64") },
  },
  tenantColumns: {
    organizationId: "organization_id",
  },
};

function validateSQL(query: string, schema: TableSchema[] = [runsSchema]) {
  const ast = parseTSQLSelect(query);
  return validateQuery(ast, schema);
}

describe("validateQuery", () => {
  describe("SELECT aliases", () => {
    it("should allow ORDER BY to reference aliased columns", () => {
      const result = validateSQL(
        "SELECT status, count(*) as count FROM runs GROUP BY status ORDER BY count DESC"
      );
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should allow ORDER BY to reference multiple aliased columns", () => {
      const result = validateSQL(
        "SELECT status, count(*) as total, avg(created_at) as avg_time FROM runs GROUP BY status ORDER BY total DESC, avg_time ASC"
      );
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should still report unknown columns that are not aliases", () => {
      const result = validateSQL(
        "SELECT status, count(*) as count FROM runs GROUP BY status ORDER BY unknown_col DESC"
      );
      expect(result.valid).toBe(true); // unknown column is a warning, not error
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("unknown_column");
      expect(result.issues[0].columnName).toBe("unknown_col");
    });

    it("should allow ORDER BY to reference both aliases and real columns", () => {
      const result = validateSQL(
        "SELECT status, count(*) as count FROM runs GROUP BY status ORDER BY status ASC, count DESC"
      );
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should allow HAVING to reference implicit column names from aggregations", () => {
      const result = validateSQL(
        "SELECT COUNT(), status FROM runs GROUP BY status HAVING count > 20"
      );
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should allow HAVING to reference implicit names from multiple aggregations", () => {
      const result = validateSQL(
        "SELECT COUNT(), SUM(created_at), status FROM runs GROUP BY status HAVING count > 10 AND sum > 100"
      );
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should allow ORDER BY to reference implicit column names", () => {
      const result = validateSQL(
        "SELECT COUNT(), status FROM runs GROUP BY status ORDER BY count DESC"
      );
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("column validation", () => {
    it("should validate known columns", () => {
      const result = validateSQL("SELECT id, status FROM runs LIMIT 10");
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should warn about unknown columns", () => {
      const result = validateSQL("SELECT id, unknown_column FROM runs LIMIT 10");
      expect(result.valid).toBe(true); // warnings don't affect validity
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("unknown_column");
      expect(result.issues[0].columnName).toBe("unknown_column");
    });
  });

  describe("enum validation", () => {
    it("should validate enum values", () => {
      const result = validateSQL("SELECT * FROM runs WHERE status = 'COMPLETED' LIMIT 10");
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should error on invalid enum values", () => {
      const result = validateSQL("SELECT * FROM runs WHERE status = 'INVALID_STATUS' LIMIT 10");
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("invalid_enum_value");
      expect(result.issues[0].invalidValue).toBe("INVALID_STATUS");
    });
  });
});

