import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client/client.js";
import { executeTSQL, createTSQLExecutor, type TableSchema } from "./client/tsql.js";
import { insertTaskRuns } from "./taskRuns.js";
import { column } from "@internal/tsql";

/**
 * Schema definition for task_runs table used in TSQL tests
 */
const taskRunsSchema: TableSchema = {
  name: "task_runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    run_id: { name: "run_id", ...column("String") },
    friendly_id: { name: "friendly_id", ...column("String") },
    status: { name: "status", ...column("String") },
    task_identifier: { name: "task_identifier", ...column("String") },
    queue: { name: "queue", ...column("String") },
    environment_id: { name: "environment_id", ...column("String") },
    environment_type: { name: "environment_type", ...column("String") },
    organization_id: { name: "organization_id", ...column("String") },
    project_id: { name: "project_id", ...column("String") },
    created_at: { name: "created_at", ...column("DateTime") },
    updated_at: { name: "updated_at", ...column("DateTime") },
    is_test: { name: "is_test", ...column("Bool") },
    tags: { name: "tags", ...column("Array(String)") },
  },
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
};

const defaultTaskRun = {
  environment_id: "env_tenant1",
  environment_type: "DEVELOPMENT",
  organization_id: "org_tenant1",
  project_id: "proj_tenant1",
  run_id: `run_${Math.random().toString(36).slice(2)}`,
  friendly_id: `friendly_${Math.random().toString(36).slice(2)}`,
  attempt: 1,
  engine: "V2",
  status: "PENDING",
  task_identifier: "my-task",
  queue: "my-queue",
  schedule_id: "",
  batch_id: "",
  created_at: Date.now(),
  updated_at: Date.now(),
  started_at: null as number | null,
  completed_at: null as number | null,
  tags: [] as string[],
  output: null,
  error: null,
  usage_duration_ms: 0,
  cost_in_cents: 0,
  base_cost_in_cents: 0,
  task_version: "",
  sdk_version: "",
  cli_version: "",
  machine_preset: "",
  is_test: false,
  span_id: "",
  trace_id: "",
  idempotency_key: "",
  expiration_ttl: "",
  root_run_id: "",
  parent_run_id: "",
  depth: 0,
  concurrency_key: "",
  bulk_action_group_ids: [] as string[],
  _version: "1",
};

/**
 * Helper to create test task run data
 */
function createTaskRun(overrides: Partial<typeof defaultTaskRun> = {}) {
  return {
    ...defaultTaskRun,
    ...overrides,
  };
}

describe("TSQL Integration Tests", () => {
  clickhouseTest("should execute a simple SELECT query", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    // Insert test data
    const [insertError] = await insert([
      createTaskRun({ run_id: "run_test1", status: "COMPLETED_SUCCESSFULLY" }),
      createTaskRun({ run_id: "run_test2", status: "PENDING" }),
      createTaskRun({ run_id: "run_test3", status: "COMPLETED_SUCCESSFULLY" }),
    ]);
    expect(insertError).toBeNull();

    // Execute TSQL query
    const [error, rows] = await executeTSQL(client, {
      name: "test-simple-select",
      query: "SELECT run_id, status FROM task_runs",
      schema: z.object({ run_id: z.string(), status: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run_id: "run_test1", status: "COMPLETED_SUCCESSFULLY" }),
        expect.objectContaining({ run_id: "run_test2", status: "PENDING" }),
        expect.objectContaining({ run_id: "run_test3", status: "COMPLETED_SUCCESSFULLY" }),
      ])
    );
  });

  clickhouseTest("should filter with WHERE clause", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    await insert([
      createTaskRun({ run_id: "run_filter1", status: "COMPLETED_SUCCESSFULLY" }),
      createTaskRun({ run_id: "run_filter2", status: "PENDING" }),
      createTaskRun({ run_id: "run_filter3", status: "COMPLETED_SUCCESSFULLY" }),
    ]);

    const [error, rows] = await executeTSQL(client, {
      name: "test-where-clause",
      query: "SELECT run_id, status FROM task_runs WHERE status = 'COMPLETED_SUCCESSFULLY'",
      schema: z.object({ run_id: z.string(), status: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows?.every((r) => r.status === "COMPLETED_SUCCESSFULLY")).toBe(true);
  });

  clickhouseTest("should enforce tenant isolation", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    // Insert data for two different tenants
    await insert([
      createTaskRun({
        run_id: "run_tenant1_a",
        organization_id: "org_tenant1",
        project_id: "proj_tenant1",
        environment_id: "env_tenant1",
      }),
      createTaskRun({
        run_id: "run_tenant1_b",
        organization_id: "org_tenant1",
        project_id: "proj_tenant1",
        environment_id: "env_tenant1",
      }),
      createTaskRun({
        run_id: "run_tenant2_a",
        organization_id: "org_tenant2",
        project_id: "proj_tenant2",
        environment_id: "env_tenant2",
      }),
      createTaskRun({
        run_id: "run_tenant2_b",
        organization_id: "org_tenant2",
        project_id: "proj_tenant2",
        environment_id: "env_tenant2",
      }),
    ]);

    // Query as tenant1 - should only see tenant1's data
    const [error1, rows1] = await executeTSQL(client, {
      name: "test-tenant-isolation-1",
      query: "SELECT run_id FROM task_runs",
      schema: z.object({ run_id: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error1).toBeNull();
    expect(rows1).toHaveLength(2);
    expect(rows1?.map((r) => r.run_id).sort()).toEqual(["run_tenant1_a", "run_tenant1_b"]);

    // Query as tenant2 - should only see tenant2's data
    const [error2, rows2] = await executeTSQL(client, {
      name: "test-tenant-isolation-2",
      query: "SELECT run_id FROM task_runs",
      schema: z.object({ run_id: z.string() }),
      organizationId: "org_tenant2",
      projectId: "proj_tenant2",
      environmentId: "env_tenant2",
      tableSchema: [taskRunsSchema],
    });

    expect(error2).toBeNull();
    expect(rows2).toHaveLength(2);
    expect(rows2?.map((r) => r.run_id).sort()).toEqual(["run_tenant2_a", "run_tenant2_b"]);
  });

  clickhouseTest(
    "should not allow cross-tenant access even with malicious WHERE",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      await insert([
        createTaskRun({
          run_id: "run_secret",
          organization_id: "org_victim",
          project_id: "proj_victim",
          environment_id: "env_victim",
          status: "SECRET_DATA",
        }),
        createTaskRun({
          run_id: "run_attacker",
          organization_id: "org_attacker",
          project_id: "proj_attacker",
          environment_id: "env_attacker",
        }),
      ]);

      // Attacker tries to access victim's data with OR 1=1
      const [error, rows] = await executeTSQL(client, {
        name: "test-cross-tenant-attack",
        query: "SELECT run_id, status FROM task_runs WHERE status = 'COMPLETED' OR 1=1",
        schema: z.object({ run_id: z.string(), status: z.string() }),
        organizationId: "org_attacker",
        projectId: "proj_attacker",
        environmentId: "env_attacker",
        tableSchema: [taskRunsSchema],
      });

      expect(error).toBeNull();
      // Should only get attacker's own data, not victim's
      expect(rows).toHaveLength(1);
      expect(rows?.[0].run_id).toBe("run_attacker");
      expect(rows?.find((r) => r.run_id === "run_secret")).toBeUndefined();
    }
  );

  clickhouseTest("should handle aggregations", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    await insert([
      createTaskRun({ run_id: "run_agg1", status: "COMPLETED_SUCCESSFULLY" }),
      createTaskRun({ run_id: "run_agg2", status: "COMPLETED_SUCCESSFULLY" }),
      createTaskRun({ run_id: "run_agg3", status: "PENDING" }),
      createTaskRun({ run_id: "run_agg4", status: "FAILED" }),
    ]);

    const [error, rows] = await executeTSQL(client, {
      name: "test-aggregation",
      query:
        "SELECT status, count(*) as cnt FROM task_runs GROUP BY status ORDER BY cnt DESC, status ASC",
      schema: z.object({ status: z.string(), cnt: z.coerce.number() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(3);
    expect(rows?.[0]).toEqual({ status: "COMPLETED_SUCCESSFULLY", cnt: 2 });
    // The remaining rows have cnt=1, check they're both present
    expect(rows).toEqual(
      expect.arrayContaining([
        { status: "PENDING", cnt: 1 },
        { status: "FAILED", cnt: 1 },
      ])
    );
  });

  clickhouseTest("should handle ORDER BY and LIMIT", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    const now = Date.now();
    await insert([
      createTaskRun({ run_id: "run_order1", created_at: now - 3000 }),
      createTaskRun({ run_id: "run_order2", created_at: now - 1000 }),
      createTaskRun({ run_id: "run_order3", created_at: now - 2000 }),
    ]);

    const [error, rows] = await executeTSQL(client, {
      name: "test-order-limit",
      query: "SELECT run_id FROM task_runs ORDER BY created_at DESC LIMIT 2",
      schema: z.object({ run_id: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows?.[0].run_id).toBe("run_order2"); // Most recent
    expect(rows?.[1].run_id).toBe("run_order3"); // Second most recent
  });

  clickhouseTest("should reject unknown tables", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const [error, rows] = await executeTSQL(client, {
      name: "test-unknown-table",
      query: "SELECT * FROM unknown_table",
      schema: z.object({ id: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("unknown_table");
    expect(rows).toBeNull();
  });

  clickhouseTest("should work with createTSQLExecutor", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    await insert([
      createTaskRun({ run_id: "run_executor1", status: "COMPLETED_SUCCESSFULLY" }),
      createTaskRun({ run_id: "run_executor2", status: "PENDING" }),
    ]);

    // Create a reusable executor
    const tsql = createTSQLExecutor(client, [taskRunsSchema]);

    const [error, rows] = await tsql.execute({
      name: "test-executor",
      query: "SELECT run_id, status FROM task_runs WHERE status = 'PENDING'",
      schema: z.object({ run_id: z.string(), status: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toEqual({ run_id: "run_executor2", status: "PENDING" });
  });

  clickhouseTest("should handle string injection attempts", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    await insert([
      createTaskRun({ run_id: "run_inject1", status: "NORMAL" }),
      createTaskRun({ run_id: "run_inject2", status: "DROP TABLE task_runs" }),
    ]);

    // Query with a "malicious" value that looks like SQL
    const [error, rows] = await executeTSQL(client, {
      name: "test-injection",
      query: "SELECT run_id, status FROM task_runs WHERE status = 'DROP TABLE task_runs'",
      schema: z.object({ run_id: z.string(), status: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).toBeNull();
    // Should find the row with the literal string value, not execute SQL
    expect(rows).toHaveLength(1);
    expect(rows?.[0].status).toBe("DROP TABLE task_runs");
  });

  clickhouseTest("should handle IN queries", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    await insert([
      createTaskRun({ run_id: "run_in1", status: "COMPLETED_SUCCESSFULLY" }),
      createTaskRun({ run_id: "run_in2", status: "PENDING" }),
      createTaskRun({ run_id: "run_in3", status: "FAILED" }),
      createTaskRun({ run_id: "run_in4", status: "CANCELLED" }),
    ]);

    const [error, rows] = await executeTSQL(client, {
      name: "test-in-query",
      query:
        "SELECT run_id, status FROM task_runs WHERE status IN ('COMPLETED_SUCCESSFULLY', 'FAILED')",
      schema: z.object({ run_id: z.string(), status: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows?.map((r) => r.status).sort()).toEqual(["COMPLETED_SUCCESSFULLY", "FAILED"]);
  });

  clickhouseTest("should handle LIKE queries", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    await insert([
      createTaskRun({ run_id: "run_like1", task_identifier: "email/send" }),
      createTaskRun({ run_id: "run_like2", task_identifier: "email/receive" }),
      createTaskRun({ run_id: "run_like3", task_identifier: "sms/send" }),
    ]);

    const [error, rows] = await executeTSQL(client, {
      name: "test-like-query",
      query: "SELECT run_id, task_identifier FROM task_runs WHERE task_identifier LIKE 'email%'",
      schema: z.object({ run_id: z.string(), task_identifier: z.string() }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [taskRunsSchema],
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows?.every((r) => r.task_identifier.startsWith("email"))).toBe(true);
  });
});

describe("TSQL Optional Tenant Filter Tests", () => {
  clickhouseTest(
    "should query across all projects when projectId is omitted",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      // Insert data across multiple projects in the same org
      await insert([
        createTaskRun({
          run_id: "run_proj1_a",
          organization_id: "org_multi",
          project_id: "proj_1",
          environment_id: "env_dev",
        }),
        createTaskRun({
          run_id: "run_proj1_b",
          organization_id: "org_multi",
          project_id: "proj_1",
          environment_id: "env_dev",
        }),
        createTaskRun({
          run_id: "run_proj2_a",
          organization_id: "org_multi",
          project_id: "proj_2",
          environment_id: "env_dev",
        }),
        createTaskRun({
          run_id: "run_proj3_a",
          organization_id: "org_multi",
          project_id: "proj_3",
          environment_id: "env_prod",
        }),
        // Different org - should not be returned
        createTaskRun({
          run_id: "run_other_org",
          organization_id: "org_other",
          project_id: "proj_other",
          environment_id: "env_other",
        }),
      ]);

      // Query across all projects (omit projectId and environmentId)
      const [error, rows] = await executeTSQL(client, {
        name: "test-cross-project-query",
        query: "SELECT run_id FROM task_runs",
        schema: z.object({ run_id: z.string() }),
        organizationId: "org_multi",
        // projectId and environmentId omitted - query across all
        tableSchema: [taskRunsSchema],
      });

      expect(error).toBeNull();
      expect(rows).toHaveLength(4); // All runs from org_multi
      expect(rows?.map((r) => r.run_id).sort()).toEqual([
        "run_proj1_a",
        "run_proj1_b",
        "run_proj2_a",
        "run_proj3_a",
      ]);
    }
  );

  clickhouseTest(
    "should query across all environments in a project when environmentId is omitted",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      // Insert data across multiple environments in the same project
      await insert([
        createTaskRun({
          run_id: "run_dev_1",
          organization_id: "org_envtest",
          project_id: "proj_envtest",
          environment_id: "env_development",
        }),
        createTaskRun({
          run_id: "run_staging_1",
          organization_id: "org_envtest",
          project_id: "proj_envtest",
          environment_id: "env_staging",
        }),
        createTaskRun({
          run_id: "run_prod_1",
          organization_id: "org_envtest",
          project_id: "proj_envtest",
          environment_id: "env_production",
        }),
        // Different project - should not be returned
        createTaskRun({
          run_id: "run_other_proj",
          organization_id: "org_envtest",
          project_id: "proj_other",
          environment_id: "env_development",
        }),
      ]);

      // Query across all environments (omit environmentId only)
      const [error, rows] = await executeTSQL(client, {
        name: "test-cross-env-query",
        query: "SELECT run_id FROM task_runs",
        schema: z.object({ run_id: z.string() }),
        organizationId: "org_envtest",
        projectId: "proj_envtest",
        // environmentId omitted - query across all environments
        tableSchema: [taskRunsSchema],
      });

      expect(error).toBeNull();
      expect(rows).toHaveLength(3); // All runs from proj_envtest across all envs
      expect(rows?.map((r) => r.run_id).sort()).toEqual([
        "run_dev_1",
        "run_prod_1",
        "run_staging_1",
      ]);
    }
  );

  clickhouseTest(
    "should still enforce org isolation when querying across projects",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      // Insert data for multiple orgs
      await insert([
        createTaskRun({
          run_id: "run_org1_a",
          organization_id: "org_isolation_1",
          project_id: "proj_a",
          environment_id: "env_a",
        }),
        createTaskRun({
          run_id: "run_org1_b",
          organization_id: "org_isolation_1",
          project_id: "proj_b",
          environment_id: "env_b",
        }),
        createTaskRun({
          run_id: "run_org2_a",
          organization_id: "org_isolation_2",
          project_id: "proj_c",
          environment_id: "env_c",
        }),
        createTaskRun({
          run_id: "run_org2_b",
          organization_id: "org_isolation_2",
          project_id: "proj_d",
          environment_id: "env_d",
        }),
      ]);

      // Query org1 across all projects - should NOT see org2's data
      const [error1, rows1] = await executeTSQL(client, {
        name: "test-org-isolation-1",
        query: "SELECT run_id FROM task_runs",
        schema: z.object({ run_id: z.string() }),
        organizationId: "org_isolation_1",
        // projectId and environmentId omitted
        tableSchema: [taskRunsSchema],
      });

      expect(error1).toBeNull();
      expect(rows1).toHaveLength(2);
      expect(rows1?.map((r) => r.run_id).sort()).toEqual(["run_org1_a", "run_org1_b"]);

      // Query org2 across all projects - should NOT see org1's data
      const [error2, rows2] = await executeTSQL(client, {
        name: "test-org-isolation-2",
        query: "SELECT run_id FROM task_runs",
        schema: z.object({ run_id: z.string() }),
        organizationId: "org_isolation_2",
        // projectId and environmentId omitted
        tableSchema: [taskRunsSchema],
      });

      expect(error2).toBeNull();
      expect(rows2).toHaveLength(2);
      expect(rows2?.map((r) => r.run_id).sort()).toEqual(["run_org2_a", "run_org2_b"]);
    }
  );

  clickhouseTest(
    "should prevent OR clause bypass with org-only filter",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      await insert([
        createTaskRun({
          run_id: "run_victim",
          organization_id: "org_victim",
          project_id: "proj_victim",
          environment_id: "env_victim",
          status: "SECRET",
        }),
        createTaskRun({
          run_id: "run_attacker",
          organization_id: "org_attacker",
          project_id: "proj_attacker",
          environment_id: "env_attacker",
          status: "PUBLIC",
        }),
      ]);

      // Attacker tries to use OR 1=1 to bypass org filter
      const [error, rows] = await executeTSQL(client, {
        name: "test-or-bypass-attempt",
        query: "SELECT run_id, status FROM task_runs WHERE status = 'COMPLETED' OR 1=1",
        schema: z.object({ run_id: z.string(), status: z.string() }),
        organizationId: "org_attacker",
        // No project/env filter - but org filter should still protect
        tableSchema: [taskRunsSchema],
      });

      expect(error).toBeNull();
      // Should only get attacker's data, not victim's
      expect(rows).toHaveLength(1);
      expect(rows?.[0].run_id).toBe("run_attacker");
      expect(rows?.find((r) => r.run_id === "run_victim")).toBeUndefined();
    }
  );

  clickhouseTest(
    "should work with createTSQLExecutor and optional filters",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      await insert([
        createTaskRun({
          run_id: "run_exec_1",
          organization_id: "org_executor_test",
          project_id: "proj_1",
          environment_id: "env_1",
        }),
        createTaskRun({
          run_id: "run_exec_2",
          organization_id: "org_executor_test",
          project_id: "proj_2",
          environment_id: "env_2",
        }),
      ]);

      const tsql = createTSQLExecutor(client, [taskRunsSchema]);

      // Use executor with org-only filter
      const [error, rows] = await tsql.execute({
        name: "test-executor-optional",
        query: "SELECT run_id FROM task_runs",
        schema: z.object({ run_id: z.string() }),
        organizationId: "org_executor_test",
        // projectId and environmentId omitted
      });

      expect(error).toBeNull();
      expect(rows).toHaveLength(2);
      expect(rows?.map((r) => r.run_id).sort()).toEqual(["run_exec_1", "run_exec_2"]);
    }
  );
});

describe("TSQL Virtual Column Tests", () => {
  /**
   * Schema with virtual (computed) columns
   */
  const virtualColumnSchema: TableSchema = {
    name: "task_runs",
    clickhouseName: "trigger_dev.task_runs_v2",
    columns: {
      run_id: { name: "run_id", ...column("String") },
      friendly_id: { name: "friendly_id", ...column("String") },
      status: { name: "status", ...column("String") },
      task_identifier: { name: "task_identifier", ...column("String") },
      queue: { name: "queue", ...column("String") },
      environment_id: { name: "environment_id", ...column("String") },
      environment_type: { name: "environment_type", ...column("String") },
      organization_id: { name: "organization_id", ...column("String") },
      project_id: { name: "project_id", ...column("String") },
      created_at: { name: "created_at", ...column("DateTime") },
      updated_at: { name: "updated_at", ...column("DateTime") },
      started_at: { name: "started_at", ...column("Nullable(DateTime64)") },
      completed_at: { name: "completed_at", ...column("Nullable(DateTime64)") },
      usage_duration_ms: { name: "usage_duration_ms", ...column("UInt32") },
      is_test: { name: "is_test", ...column("Bool") },
      tags: { name: "tags", ...column("Array(String)") },
      // Virtual column: execution_duration computes milliseconds between started_at and completed_at
      execution_duration: {
        name: "execution_duration",
        ...column("Nullable(Int64)"),
        expression: "dateDiff('millisecond', started_at, completed_at)",
        description: "Time between started_at and completed_at in milliseconds",
      },
      // Virtual column: usage_duration_seconds converts ms to seconds
      usage_duration_seconds: {
        name: "usage_duration_seconds",
        ...column("Float64"),
        expression: "usage_duration_ms / 1000.0",
        description: "Usage duration in seconds",
      },
    },
    tenantColumns: {
      organizationId: "organization_id",
      projectId: "project_id",
      environmentId: "environment_id",
    },
  };

  clickhouseTest(
    "should select virtual column and compute correct value",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      const now = Date.now();
      const startedAt = now - 5000; // 5 seconds ago
      const completedAt = now;

      await insert([
        createTaskRun({
          run_id: "run_virtual_1",
          started_at: startedAt,
          completed_at: completedAt,
          usage_duration_ms: 3500,
        }),
      ]);

      const [error, rows] = await executeTSQL(client, {
        name: "test-virtual-column-select",
        query: "SELECT run_id, execution_duration, usage_duration_seconds FROM task_runs",
        schema: z.object({
          run_id: z.string(),
          execution_duration: z.number().nullable(),
          usage_duration_seconds: z.number(),
        }),
        organizationId: "org_tenant1",
        projectId: "proj_tenant1",
        environmentId: "env_tenant1",
        tableSchema: [virtualColumnSchema],
      });

      expect(error).toBeNull();
      expect(rows).toHaveLength(1);
      // execution_duration should be approximately 5000ms (difference between started_at and completed_at)
      expect(rows?.[0].execution_duration).toBeCloseTo(5000, -2); // within 100ms tolerance
      // usage_duration_seconds should be 3.5 (3500ms / 1000)
      expect(rows?.[0].usage_duration_seconds).toBeCloseTo(3.5, 1);
    }
  );

  clickhouseTest(
    "should filter by virtual column in WHERE clause",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      const now = Date.now();

      await insert([
        createTaskRun({
          run_id: "run_short",
          started_at: now - 1000, // 1 second duration
          completed_at: now,
        }),
        createTaskRun({
          run_id: "run_long",
          started_at: now - 10000, // 10 second duration
          completed_at: now,
        }),
        createTaskRun({
          run_id: "run_very_long",
          started_at: now - 60000, // 60 second duration
          completed_at: now,
        }),
      ]);

      // Query runs with execution_duration > 5000ms (5 seconds)
      const [error, rows] = await executeTSQL(client, {
        name: "test-virtual-column-where",
        query: "SELECT run_id FROM task_runs WHERE execution_duration > 5000",
        schema: z.object({ run_id: z.string() }),
        organizationId: "org_tenant1",
        projectId: "proj_tenant1",
        environmentId: "env_tenant1",
        tableSchema: [virtualColumnSchema],
      });

      expect(error).toBeNull();
      expect(rows).toHaveLength(2);
      expect(rows?.map((r) => r.run_id).sort()).toEqual(["run_long", "run_very_long"]);
    }
  );

  clickhouseTest("should order by virtual column", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, { async_insert: 0 });

    const now = Date.now();

    await insert([
      createTaskRun({
        run_id: "run_order_a",
        usage_duration_ms: 1000,
      }),
      createTaskRun({
        run_id: "run_order_b",
        usage_duration_ms: 3000,
      }),
      createTaskRun({
        run_id: "run_order_c",
        usage_duration_ms: 2000,
      }),
    ]);

    // Order by usage_duration_seconds descending (virtual column)
    const [error, rows] = await executeTSQL(client, {
      name: "test-virtual-column-order",
      query:
        "SELECT run_id, usage_duration_seconds FROM task_runs ORDER BY usage_duration_seconds DESC",
      schema: z.object({
        run_id: z.string(),
        usage_duration_seconds: z.number(),
      }),
      organizationId: "org_tenant1",
      projectId: "proj_tenant1",
      environmentId: "env_tenant1",
      tableSchema: [virtualColumnSchema],
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(3);
    // Should be ordered by usage_duration_seconds DESC: b (3), c (2), a (1)
    expect(rows?.[0].run_id).toBe("run_order_b");
    expect(rows?.[0].usage_duration_seconds).toBeCloseTo(3.0, 1);
    expect(rows?.[1].run_id).toBe("run_order_c");
    expect(rows?.[1].usage_duration_seconds).toBeCloseTo(2.0, 1);
    expect(rows?.[2].run_id).toBe("run_order_a");
    expect(rows?.[2].usage_duration_seconds).toBeCloseTo(1.0, 1);
  });

  clickhouseTest(
    "should use virtual column with explicit alias",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      await insert([
        createTaskRun({
          run_id: "run_alias_test",
          usage_duration_ms: 5000,
        }),
      ]);

      // Use virtual column with custom alias
      const [error, rows] = await executeTSQL(client, {
        name: "test-virtual-column-alias",
        query: "SELECT run_id, usage_duration_seconds AS dur_sec FROM task_runs",
        schema: z.object({
          run_id: z.string(),
          dur_sec: z.number(),
        }),
        organizationId: "org_tenant1",
        projectId: "proj_tenant1",
        environmentId: "env_tenant1",
        tableSchema: [virtualColumnSchema],
      });

      expect(error).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows?.[0].dur_sec).toBeCloseTo(5.0, 1);
    }
  );

  clickhouseTest(
    "should handle null values in virtual column expression",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRuns(client, { async_insert: 0 });

      await insert([
        createTaskRun({
          run_id: "run_null_times",
          // started_at and completed_at will be null
        }),
      ]);

      const [error, rows] = await executeTSQL(client, {
        name: "test-virtual-column-null",
        query: "SELECT run_id, execution_duration FROM task_runs",
        schema: z.object({
          run_id: z.string(),
          execution_duration: z.number().nullable(),
        }),
        organizationId: "org_tenant1",
        projectId: "proj_tenant1",
        environmentId: "env_tenant1",
        tableSchema: [virtualColumnSchema],
      });

      expect(error).toBeNull();
      expect(rows).toHaveLength(1);
      // execution_duration should be null when started_at or completed_at is null
      expect(rows?.[0].execution_duration).toBeNull();
    }
  );
});
