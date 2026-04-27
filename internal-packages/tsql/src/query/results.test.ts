import { describe, it, expect } from "vitest";
import { transformResults, createResultTransformer } from "./results.js";
import { column, type TableSchema } from "./schema.js";

/**
 * Test schema with valueMap
 */
const taskRunsSchema: TableSchema = {
  name: "task_runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    id: { name: "id", ...column("String") },
    status: {
      name: "status",
      ...column("String"),
      valueMap: {
        COMPLETED_SUCCESSFULLY: "Completed",
        COMPLETED_WITH_ERRORS: "Completed with errors",
        SYSTEM_FAILURE: "System failure",
        PENDING: "Pending",
        EXECUTING: "Running",
        FAILED: "Failed",
        CANCELLED: "Cancelled",
      },
    },
    environment_type: {
      name: "environment_type",
      ...column("String"),
      valueMap: {
        DEVELOPMENT: "Development",
        STAGING: "Staging",
        PRODUCTION: "Production",
      },
    },
    task_identifier: { name: "task_identifier", ...column("String") },
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
 * Schema without valueMap
 */
const simpleSchema: TableSchema = {
  name: "simple",
  clickhouseName: "trigger_dev.simple",
  columns: {
    id: { name: "id", ...column("String") },
    name: { name: "name", ...column("String") },
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

describe("transformResults", () => {
  it("should transform internal values to user-friendly values", () => {
    const rows = [
      { id: "run_1", status: "COMPLETED_SUCCESSFULLY", task_identifier: "my-task" },
      { id: "run_2", status: "PENDING", task_identifier: "other-task" },
      { id: "run_3", status: "FAILED", task_identifier: "my-task" },
    ];

    const transformed = transformResults(rows, [taskRunsSchema]);

    expect(transformed[0].status).toBe("Completed");
    expect(transformed[1].status).toBe("Pending");
    expect(transformed[2].status).toBe("Failed");
  });

  it("should transform multiple columns with valueMaps", () => {
    const rows = [
      { id: "run_1", status: "COMPLETED_SUCCESSFULLY", environment_type: "PRODUCTION" },
      { id: "run_2", status: "PENDING", environment_type: "DEVELOPMENT" },
    ];

    const transformed = transformResults(rows, [taskRunsSchema]);

    expect(transformed[0].status).toBe("Completed");
    expect(transformed[0].environment_type).toBe("Production");
    expect(transformed[1].status).toBe("Pending");
    expect(transformed[1].environment_type).toBe("Development");
  });

  it("should not modify columns without valueMap", () => {
    const rows = [
      { id: "run_1", status: "COMPLETED_SUCCESSFULLY", task_identifier: "my-task" },
    ];

    const transformed = transformResults(rows, [taskRunsSchema]);

    // id and task_identifier should be unchanged
    expect(transformed[0].id).toBe("run_1");
    expect(transformed[0].task_identifier).toBe("my-task");
  });

  it("should pass through values not in valueMap unchanged", () => {
    const rows = [{ id: "run_1", status: "UNKNOWN_STATUS", task_identifier: "my-task" }];

    const transformed = transformResults(rows, [taskRunsSchema]);

    // UNKNOWN_STATUS is not in the valueMap, should be passed through
    expect(transformed[0].status).toBe("UNKNOWN_STATUS");
  });

  it("should return original rows if no columns have valueMap", () => {
    const rows = [
      { id: "run_1", name: "test" },
      { id: "run_2", name: "other" },
    ];

    const transformed = transformResults(rows, [simpleSchema]);

    // Should return the same array (reference equality)
    expect(transformed).toBe(rows);
  });

  it("should handle empty rows array", () => {
    const rows: Array<{ id: string; status: string }> = [];
    const transformed = transformResults(rows, [taskRunsSchema]);

    expect(transformed).toEqual([]);
  });

  it("should handle case-insensitive internal value matching", () => {
    const rows = [
      { id: "run_1", status: "completed_successfully" },
      { id: "run_2", status: "COMPLETED_SUCCESSFULLY" },
      { id: "run_3", status: "Completed_Successfully" },
    ];

    const transformed = transformResults(rows, [taskRunsSchema]);

    // All should map to "Completed"
    expect(transformed[0].status).toBe("Completed");
    expect(transformed[1].status).toBe("Completed");
    expect(transformed[2].status).toBe("Completed");
  });

  it("should preserve non-string column values", () => {
    const rows = [{ id: "run_1", status: "COMPLETED_SUCCESSFULLY", count: 42, active: true }];

    const transformed = transformResults(rows, [taskRunsSchema]);

    expect(transformed[0].count).toBe(42);
    expect(transformed[0].active).toBe(true);
    expect(transformed[0].status).toBe("Completed");
  });

  it("should preserve row reference if no changes made", () => {
    const rows = [{ id: "run_1", status: "UNKNOWN_STATUS" }];

    const transformed = transformResults(rows, [taskRunsSchema]);

    // The row has status that doesn't match any valueMap entry
    // But the column does have a valueMap, so we still check it
    // Since the value doesn't change, the row reference should be preserved
    expect(transformed[0]).toBe(rows[0]);
  });

  it("should handle multiple table schemas", () => {
    const anotherSchema: TableSchema = {
      name: "events",
      clickhouseName: "trigger_dev.events",
      columns: {
        id: { name: "id", ...column("String") },
        event_type: {
          name: "event_type",
          ...column("String"),
          valueMap: {
            TASK_START: "Started",
            TASK_END: "Ended",
          },
        },
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

    const rows = [
      { status: "COMPLETED_SUCCESSFULLY", event_type: "TASK_START" },
      { status: "PENDING", event_type: "TASK_END" },
    ];

    const transformed = transformResults(rows, [taskRunsSchema, anotherSchema]);

    expect(transformed[0].status).toBe("Completed");
    expect(transformed[0].event_type).toBe("Started");
    expect(transformed[1].status).toBe("Pending");
    expect(transformed[1].event_type).toBe("Ended");
  });
});

describe("createResultTransformer", () => {
  it("should create a reusable transformer function", () => {
    const transform = createResultTransformer([taskRunsSchema]);

    const rows1 = [{ id: "1", status: "COMPLETED_SUCCESSFULLY" }];
    const rows2 = [{ id: "2", status: "FAILED" }];

    const transformed1 = transform(rows1);
    const transformed2 = transform(rows2);

    expect(transformed1[0].status).toBe("Completed");
    expect(transformed2[0].status).toBe("Failed");
  });

  it("should return original rows if no valueMap columns exist", () => {
    const transform = createResultTransformer([simpleSchema]);

    const rows = [{ id: "1", name: "test" }];
    const transformed = transform(rows);

    expect(transformed).toBe(rows);
  });
});

