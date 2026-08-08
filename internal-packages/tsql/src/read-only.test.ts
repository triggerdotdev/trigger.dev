import { describe, expect, it } from "vitest";
import { compileTSQL, parseTSQLSelect, SyntaxError as TSQLSyntaxError } from "./index.js";
import { column, type TableSchema } from "./query/schema.js";

const taskRunsSchema: TableSchema = {
  name: "task_runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    id: { name: "id", ...column("String") },
    status: { name: "status", ...column("String") },
    created_at: { name: "created_at", ...column("DateTime64") },
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

const compileOptions = {
  tableSchema: [taskRunsSchema],
  enforcedWhereClause: {
    organization_id: { op: "eq", value: "org_123" },
    project_id: { op: "eq", value: "proj_456" },
    environment_id: { op: "eq", value: "env_789" },
  },
} as const;

const mutating = [
  ["INSERT", "INSERT INTO task_runs (id) VALUES ('run_1')"],
  ["UPDATE", "UPDATE task_runs SET status = 'COMPLETED' WHERE id = 'run_1'"],
  ["DELETE", "DELETE FROM task_runs WHERE id = 'run_1'"],
  ["DROP", "DROP TABLE task_runs"],
  ["TRUNCATE TABLE", "TRUNCATE TABLE task_runs"],
  ["ALTER", "ALTER TABLE task_runs ADD COLUMN leaked String"],
  ["CREATE", "CREATE TABLE leaked (id String)"],
  ["GRANT", "GRANT SELECT ON task_runs TO someone"],
  ["OPTIMIZE", "OPTIMIZE TABLE task_runs FINAL"],
  ["SYSTEM", "SYSTEM SHUTDOWN"],
];

const evasions = [
  ["lower case", "delete from task_runs where id = 'run_1'"],
  ["mixed case", "DeLeTe FROM task_runs WHERE id = 'run_1'"],
  ["leading line comment", "-- harmless\nDELETE FROM task_runs"],
  ["leading block comment", "/* harmless */ DROP TABLE task_runs"],
  ["comment between keywords", "DROP /* x */ TABLE task_runs"],
  ["leading whitespace and newlines", "\n\n\t  TRUNCATE TABLE task_runs"],
];

describe("TSQL is read-only by construction", () => {
  it.each(mutating)("rejects %s at the parse boundary", (_label, query) => {
    expect(() => parseTSQLSelect(query)).toThrow(TSQLSyntaxError);
  });

  it.each(evasions)("rejects a mutating query written as %s", (_label, query) => {
    expect(() => parseTSQLSelect(query)).toThrow(TSQLSyntaxError);
  });

  it.each(mutating)("refuses to compile %s", (_label, query) => {
    expect(() => compileTSQL(query, compileOptions as never)).toThrow();
  });

  // Positive control: the negatives must fail because they mutate, not because everything does.
  it("still parses an ordinary SELECT", () => {
    const ast = parseTSQLSelect("SELECT id, status FROM task_runs WHERE status = 'FAILED'");
    expect(ast.expression_type).toBe("select_query");
  });

  it("treats TRUNCATE as a function, not a statement", () => {
    const ast = parseTSQLSelect("SELECT truncate(1.9) FROM task_runs");
    expect(ast.expression_type).toBe("select_query");
  });
});

describe("a mutation cannot ride along behind a valid SELECT", () => {
  const smuggled = [
    ["semicolon", "SELECT id FROM task_runs; DROP TABLE task_runs"],
    ["semicolon and newline", "SELECT id FROM task_runs;\nDELETE FROM task_runs"],
    ["two semicolons", "SELECT id FROM task_runs;; TRUNCATE TABLE task_runs"],
  ];

  it.each(smuggled)("rejects a mutation appended after a %s", (_label, query) => {
    expect(() => parseTSQLSelect(query)).toThrow(TSQLSyntaxError);
    expect(() => compileTSQL(query, compileOptions as never)).toThrow();
  });
});
