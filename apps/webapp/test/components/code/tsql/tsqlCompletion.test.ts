import { describe, it, expect } from "vitest";
import { createTSQLCompletion } from "~/components/code/tsql/tsqlCompletion";
import type { TableSchema } from "@internal/tsql";

// Helper to create a mock completion context
function createMockContext(doc: string, pos: number, explicit = false) {
  return {
    state: {
      doc: {
        toString: () => doc,
        sliceString: (from: number, to: number) => doc.slice(from, to),
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

// Test schema with enum columns
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
      status: {
        name: "status",
        type: "LowCardinality(String)",
        description: "Run status",
        allowedValues: ["Completed", "Failed", "Queued", "Executing"],
      },
      machine: {
        name: "machine",
        type: "LowCardinality(String)",
        description: "Machine preset",
        allowedValues: ["micro", "small-1x", "small-2x", "medium-1x"],
      },
      environment_type: {
        name: "environment_type",
        type: "LowCardinality(String)",
        description: "Environment type",
        allowedValues: ["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"],
      },
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

  it("should include tables in completions", () => {
    // When typing after FROM, tables should be available
    const doc = "SELECT * FROM r";
    const context = createMockContext(doc, doc.length, true);
    const result = completionSource(context);

    expect(result).not.toBeNull();

    const tableLabels = result?.options.map((o) => o.label);
    // Tables should always be available in completions
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

  describe("enum value completions", () => {
    it("should suggest enum values after = operator", () => {
      const doc = "SELECT * FROM runs WHERE status = ";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'Completed'");
      expect(labels).toContain("'Failed'");
      expect(labels).toContain("'Queued'");
      expect(labels).toContain("'Executing'");
    });

    it("should suggest enum values after = with opening quote", () => {
      const doc = "SELECT * FROM runs WHERE status = '";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'Completed'");
      expect(labels).toContain("'Failed'");
    });

    it("should suggest enum values with partial input", () => {
      const doc = "SELECT * FROM runs WHERE status = 'Comp";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'Completed'");
    });

    it("should suggest enum values for machine column", () => {
      const doc = "SELECT * FROM runs WHERE machine = ";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'micro'");
      expect(labels).toContain("'small-1x'");
      expect(labels).toContain("'medium-1x'");
    });

    it("should suggest enum values for environment_type column", () => {
      const doc = "SELECT * FROM runs WHERE environment_type = ";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'PRODUCTION'");
      expect(labels).toContain("'STAGING'");
      expect(labels).toContain("'DEVELOPMENT'");
    });

    it("should suggest enum values after != operator", () => {
      const doc = "SELECT * FROM runs WHERE status != ";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'Completed'");
      expect(labels).toContain("'Failed'");
    });

    it("should suggest enum values after IN (", () => {
      const doc = "SELECT * FROM runs WHERE status IN (";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'Completed'");
      expect(labels).toContain("'Failed'");
    });

    it("should suggest enum values after comma in IN clause", () => {
      const doc = "SELECT * FROM runs WHERE status IN ('Completed', ";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).toContain("'Failed'");
      expect(labels).toContain("'Queued'");
    });

    it("should include closing quote in replacement range when auto-paired", () => {
      // Simulate cursor between auto-paired quotes: status = '|'
      const doc = "SELECT * FROM runs WHERE status = ''";
      const pos = doc.length - 1; // Cursor is between the quotes
      const context = createMockContext(doc, pos, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();
      // The 'to' should extend past the cursor to include the closing quote
      expect(result?.to).toBe(pos + 1);
    });

    it("should not extend 'to' when no closing quote present", () => {
      const doc = "SELECT * FROM runs WHERE status = '";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();
      // 'to' should be undefined (or not set) since there's no closing quote
      expect(result?.to).toBeUndefined();
    });

    it("should not suggest enum values for columns without allowedValues", () => {
      const doc = "SELECT * FROM runs WHERE id = ";
      const context = createMockContext(doc, doc.length, true);
      const result = completionSource(context);

      expect(result).not.toBeNull();

      // Should return empty options for value context with non-enum column
      const labels = result?.options.map((o) => o.label) || [];
      expect(labels).not.toContain("'Completed'");
      expect(labels.length).toBe(0);
    });
  });
});

