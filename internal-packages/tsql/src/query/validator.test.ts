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
    projectId: "project_id",
    environmentId: "environment_id",
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

    it("should report unknown columns that are not aliases as errors", () => {
      const result = validateSQL(
        "SELECT status, count(*) as count FROM runs GROUP BY status ORDER BY unknown_col DESC"
      );
      expect(result.valid).toBe(false); // unknown column is now an error
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("unknown_column");
      expect(result.issues[0].severity).toBe("error");
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

    it("should error on unknown columns", () => {
      const result = validateSQL("SELECT id, unknown_column FROM runs LIMIT 10");
      expect(result.valid).toBe(false); // unknown columns are now errors
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("unknown_column");
      expect(result.issues[0].severity).toBe("error");
      expect(result.issues[0].columnName).toBe("unknown_column");
    });
  });

  describe("enum validation", () => {
    it("should validate enum values", () => {
      const result = validateSQL("SELECT id, status FROM runs WHERE status = 'COMPLETED' LIMIT 10");
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should error on invalid enum values", () => {
      const result = validateSQL(
        "SELECT id, status FROM runs WHERE status = 'INVALID_STATUS' LIMIT 10"
      );
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("invalid_enum_value");
      expect(result.issues[0].invalidValue).toBe("INVALID_STATUS");
    });
  });
});

describe("identifier resolution", () => {
  const eventsSchema: TableSchema = {
    name: "events",
    clickhouseName: "trigger_dev.task_events_v2",
    columns: {
      run_id: { name: "run_id", ...column("String") },
      output: { name: "output", ...column("JSON") },
    },
  };

  // Catches: the editor shows a query as valid that fails to compile
  it.each([
    "SELECT tuple(*) FROM runs",
    "SELECT [*] FROM runs",
    "SELECT count(DISTINCT *) FROM runs",
    "SELECT id FROM runs ORDER BY *",
    "SELECT task_runs_v2.id FROM runs",
    "SELECT trigger_dev.task_runs_v2.id FROM runs",
    "SELECT x.* FROM runs AS r",
    "SELECT R.id FROM runs AS r",
    "SELECT count(R.*) FROM runs AS r",
    "SELECT 1 AS task_runs_v2, task_runs_v2.id FROM runs",
    "SELECT 1 AS trigger_dev, trigger_dev.task_runs_v2.id FROM runs",
    "SELECT task_runs_v2.* FROM runs, (SELECT 1 AS x) AS task_runs_v2",
    "SELECT run_id FROM runs AS r JOIN events AS task_runs_v2 ON 1 = 1",
    "SELECT item FROM runs ARRAY JOIN [1] AS item",
    "SELECT r.id FROM runs r JOIN (SELECT run_id FROM events) m ON m.run_id = r.id WHERE task_runs_v2.id = 'a'",
  ])("reports an error for %s", (query) => {
    expect(validateSQL(query, [runsSchema, eventsSchema]).valid).toBe(false);
  });

  // Catches: the editor flags a query that compiles
  it.each([
    "SELECT *, count(*) FROM runs GROUP BY id",
    "SELECT r.*, COUNT(r.*) FROM runs AS r GROUP BY r.id",
    "SELECT output.message FROM events",
    "SELECT s.* FROM (SELECT id FROM runs) AS s",
    "SELECT r.id, m.run_id FROM runs r JOIN (SELECT run_id FROM events) m ON m.run_id = r.id",
    "SELECT output.message FROM (SELECT output FROM events) AS s",
    "WITH output AS o SELECT o.message FROM events",
    "WITH output AS o SELECT o FROM events",
    "SELECT item.id FROM events ARRAY JOIN [JSONExtract('{\"id\":\"a\"}', 'Tuple(id String)')] AS item",
  ])("reports no error for %s", (query) => {
    const result = validateSQL(query, [runsSchema, eventsSchema]);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
