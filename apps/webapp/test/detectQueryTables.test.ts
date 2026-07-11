import { describe, expect, it } from "vitest";
import { detectQueryTables } from "../app/v3/detectQueryTables.js";

const allowed = new Set(["runs", "tasks"]);
const sorted = (xs: string[] | null) => (xs === null ? null : [...xs].sort());

// detectQueryTables backs per-table JWT-scope authorization for /api/v1/query.
// Key behaviours over the old FROM-only regex: it sees JOINed and subquery
// tables, and returns null for unparseable queries so the caller denies by
// default.
describe("detectQueryTables", () => {
  it("detects the FROM table", () => {
    expect(sorted(detectQueryTables("SELECT * FROM runs", allowed))).toEqual(["runs"]);
  });

  it("returns the canonical table name when query casing differs", () => {
    expect(sorted(detectQueryTables("SELECT * FROM RUNS", allowed))).toEqual(["runs"]);
  });

  it("detects every JOINed table, not just FROM", () => {
    expect(
      sorted(detectQueryTables("SELECT * FROM runs JOIN tasks ON runs.id = tasks.run_id", allowed))
    ).toEqual(["runs", "tasks"]);
  });

  it("detects tables inside a FROM subquery", () => {
    expect(sorted(detectQueryTables("SELECT * FROM (SELECT * FROM runs) AS r", allowed))).toEqual([
      "runs",
    ]);
  });

  it("detects a table read only inside a CTE body", () => {
    expect(
      sorted(detectQueryTables("WITH r AS (SELECT * FROM runs) SELECT * FROM r", allowed))
    ).toEqual(["runs"]);
  });

  it("detects a table read only inside a WHERE subquery", () => {
    expect(
      sorted(
        detectQueryTables("SELECT * FROM tasks WHERE id IN (SELECT run_id FROM runs)", allowed)
      )
    ).toEqual(["runs", "tasks"]);
  });

  it("detects a table read only inside a SELECT-list subquery", () => {
    expect(
      sorted(detectQueryTables("SELECT (SELECT count() FROM runs) AS c FROM tasks", allowed))
    ).toEqual(["runs", "tasks"]);
  });

  it("ignores tables that aren't in the allowed schema set", () => {
    expect(detectQueryTables("SELECT * FROM runs", new Set(["tasks"]))).toEqual([]);
  });

  it("returns null for an unparseable query (caller denies by default)", () => {
    expect(detectQueryTables("definitely not a valid query !!!", allowed)).toBeNull();
  });
});
