import { describe, it, expect } from "vitest";
import { createTSQLCompletion } from "./tsqlCompletion";
import type { TableSchema, ColumnSchema } from "@internal/tsql";

// Helper to create a mock completion context
function createMockContext(doc: string, pos: number, explicit = false) {
  return {
    state: {
      doc: {
        toString: () => doc,
      },
    },
    pos,
    explicit,
    matchBefore: (regex: RegExp) => {
      const beforePos = doc.slice(0, pos);
      const match = beforePos.match(new RegExp(regex.source + "$"));
      if (match) {
        return {
          from: pos - match[0].length,
          to: pos,
          text: match[0],
        };
      }
      return null;
    },
  } as any;
}

// Test schema
const testSchema: TableSchema[] = [
  {
    name: "runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
    description: "Task runs table",
    columns: {
      id: { name: "id", type: "String", description: "Run ID" },
      status: { name: "status", type: "String", description: "Run status" },
      created_at: { name: "created_at", type: "DateTime64", description: "Creation time" },
      organization_id: { name: "organization_id", type: "String" },
      project_id: { name: "project_id", type: "String" },
      environment_id: { name: "environment_id", type: "String" },
    },
  },
  {
    name: "logs",
    clickhouseName: "trigger_dev.task_events_v2",
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
    description: "Task logs table",
    columns: {
      id: { name: "id", type: "String" },
      run_id: { name: "run_id", type: "String" },
      message: { name: "message", type: "String" },
      level: { name: "level", type: "String" },
      timestamp: { name: "timestamp", type: "DateTime64" },
      organization_id: { name: "organization_id", type: "String" },
      project_id: { name: "project_id", type: "String" },
      environment_id: { name: "environment_id", type: "String" },
    },
  },
];

describe("createTSQLCompletion", () => {
  const completionSource = createTSQLCompletion(testSchema);

  it("should return null for empty input without explicit trigger", () => {
    const context = createMockContext("", 0, false);
    const result = completionSource(context);
    expect(result).toBeNull();
  });

  it("should return completions when explicitly triggered", () => {
    const context = createMockContext("", 0, true);
    const result = completionSource(context);
    expect(result).not.toBeNull();
    expect(result?.options.length).toBeGreaterThan(0);
  });

  it("should suggest tables after FROM keyword", () => {
    const doc = "SELECT * FROM ";
    const context = createMockContext(doc, doc.length, true);
    const result = completionSource(context);

    expect(result).not.toBeNull();

    const tableLabels = result?.options.map((o) => o.label);
    expect(tableLabels).toContain("runs");
    expect(tableLabels).toContain("logs");
  });

  it("should suggest columns after SELECT keyword", () => {
    const doc = "SELECT FROM runs";
    // Position cursor right after SELECT
    const pos = 7;
    const context = createMockContext(doc, pos, true);
    const result = completionSource(context);

    expect(result).not.toBeNull();

    // Should include functions
    const labels = result?.options.map((o) => o.label) || [];
    expect(labels.some((l) => l === "count")).toBe(true);
    expect(labels.some((l) => l === "sum")).toBe(true);
  });

  it("should suggest columns with table prefix for qualified references", () => {
    const doc = "SELECT runs. FROM runs";
    // Position cursor right after "runs."
    const pos = 12;
    const context = createMockContext(doc, pos, true);
    const result = completionSource(context);

    expect(result).not.toBeNull();

    const columnLabels = result?.options.map((o) => o.label);
    expect(columnLabels).toContain("id");
    expect(columnLabels).toContain("status");
    expect(columnLabels).toContain("created_at");
  });

  it("should include SQL keywords in general context", () => {
    const doc = "S";
    const context = createMockContext(doc, doc.length, true);
    const result = completionSource(context);

    expect(result).not.toBeNull();

    const labels = result?.options.map((o) => o.label);
    expect(labels).toContain("SELECT");
  });

  it("should include aggregate functions", () => {
    const doc = "SELECT ";
    const context = createMockContext(doc, doc.length, true);
    const result = completionSource(context);

    expect(result).not.toBeNull();

    const labels = result?.options.map((o) => o.label);
    expect(labels).toContain("count");
    expect(labels).toContain("sum");
    expect(labels).toContain("avg");
    expect(labels).toContain("min");
    expect(labels).toContain("max");
  });

  it("should handle WHERE clause context", () => {
    const doc = "SELECT * FROM runs WHERE ";
    const context = createMockContext(doc, doc.length, true);
    const result = completionSource(context);

    expect(result).not.toBeNull();

    // Should suggest columns
    const labels = result?.options.map((o) => o.label) || [];
    expect(labels).toContain("status");

    // Should include conditional keywords
    expect(labels).toContain("AND");
    expect(labels).toContain("OR");
  });
});

