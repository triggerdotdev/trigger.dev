import { ClickHouse } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";

vi.setConfig({ testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ ch: undefined as unknown }));

vi.mock("~/db.server", () => {
  const client = {
    project: { findMany: async () => [] },
    runtimeEnvironment: { findMany: async () => [] },
    customerQuery: { findFirst: async () => null, create: async () => ({ id: "cq_1" }) },
  };
  return { prisma: client, $replica: client };
});
vi.mock("~/env.server", () => ({
  env: {
    QUERY_CLICKHOUSE_MAX_EXECUTION_TIME: 30,
    QUERY_CLICKHOUSE_MAX_MEMORY_USAGE: 1_000_000_000,
    QUERY_CLICKHOUSE_MAX_AST_ELEMENTS: 50000,
    QUERY_CLICKHOUSE_MAX_EXPANDED_AST_ELEMENTS: 500000,
    QUERY_CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY: 1_000_000_000,
    QUERY_CLICKHOUSE_MAX_RETURNED_ROWS: 1000,
  },
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => holder.ch },
}));
vi.mock("~/services/platform.v3.server", () => ({ getLimit: async () => 30 }));
vi.mock("~/services/queryConcurrencyLimiter.server", () => ({
  queryConcurrencyLimiter: {
    acquire: async () => ({ success: true }),
    release: async () => {},
  },
  DEFAULT_ORG_CONCURRENCY_LIMIT: 10,
  GLOBAL_CONCURRENCY_LIMIT: 100,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { executeQuery } from "~/services/queryService.server";

const ORG = "org_qs_errors";
const PROJECT = "project_qs_errors";
const ENV_A = "env_qs_errors_a";
const ENV_B = "env_qs_errors_b";

function failedRun(
  tenant: { org: string; project: string; env: string },
  task: string,
  fingerprint: string,
  createdAt: number
) {
  const id = Math.random().toString(36).slice(2);
  return {
    environment_id: tenant.env,
    organization_id: tenant.org,
    project_id: tenant.project,
    run_id: `run_${id}`,
    friendly_id: `run_f${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    status: "COMPLETED_WITH_ERRORS",
    environment_type: "DEVELOPMENT",
    attempt: 1,
    engine: "V2",
    task_identifier: task,
    queue: "q",
    schedule_id: "",
    batch_id: "",
    error: { data: { name: "TypeError", message: `boom ${fingerprint}` } },
    error_fingerprint: fingerprint,
    tags: [],
    task_version: "20240101.1",
    sdk_version: "",
    cli_version: "",
    machine_preset: "",
    root_run_id: "",
    parent_run_id: "",
    span_id: "",
    trace_id: "",
    idempotency_key: "",
    expiration_ttl: "",
    _version: "1",
  };
}

describe("query service errors tables", () => {
  clickhouseTest(
    "errors and error_occurrences run through the Query page path, tenant-scoped",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "qs" });
      holder.ch = ch;
      const now = Date.now();
      const envA = { org: ORG, project: PROJECT, env: ENV_A };
      const envB = { org: ORG, project: PROJECT, env: ENV_B };
      const otherTenant = { org: "org_other", project: "project_other", env: ENV_A };

      const [insertError] = await ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
        name: "seed-failed-runs",
        table: "trigger_dev.task_runs_v2",
        settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
      })([
        failedRun(envA, "task-1", "fp_a", now - 120_000),
        failedRun(envA, "task-1", "fp_a", now - 60_000),
        failedRun(envA, "task-2", "fp_b", now - 30_000),
        failedRun(envB, "task-1", "fp_a", now - 10_000),
        failedRun(envB, "task-3", "fp_c", now),
        failedRun(otherTenant, "task-1", "fp_a", now),
        failedRun(otherTenant, "task-4", "fp_d", now),
      ]);
      expect(insertError).toBeNull();

      const run = (query: string) =>
        executeQuery({
          name: "errors-query",
          query,
          schema: z.record(z.string(), z.any()),
          scope: "environment",
          organizationId: ORG,
          projectId: PROJECT,
          environmentId: ENV_A,
          period: "7d",
        });

      const errors = await run(
        `SELECT task_identifier, error_fingerprint, sumMerge(occurrence_count) AS occurrence_count
        FROM errors
        GROUP BY task_identifier, error_fingerprint
        ORDER BY error_fingerprint`
      );
      if (!errors.success) throw errors.error;
      expect(
        errors.result.rows.map((r) => [
          r.task_identifier,
          r.error_fingerprint,
          Number(r.occurrence_count),
        ])
      ).toEqual([
        ["task-1", "fp_a", 2],
        ["task-2", "fp_b", 1],
      ]);

      const occurrences = await run(
        `SELECT error_fingerprint, sum(count) AS total
        FROM error_occurrences
        GROUP BY error_fingerprint
        ORDER BY error_fingerprint`
      );
      if (!occurrences.success) throw occurrences.error;
      expect(occurrences.result.rows.map((r) => [r.error_fingerprint, Number(r.total)])).toEqual([
        ["fp_a", 2],
        ["fp_b", 1],
      ]);
    }
  );

  clickhouseTest("errors is capped by the org query period", async ({ clickhouseContainer }) => {
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "qs-cap" });
    holder.ch = ch;
    const now = Date.now();
    const tenant = { org: "org_cap", project: "project_cap", env: "env_cap" };

    const [insertError] = await ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
      name: "seed-failed-runs-cap",
      table: "trigger_dev.task_runs_v2",
      settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    })([
      failedRun(tenant, "task-1", "fp_recent", now - 60_000),
      failedRun(tenant, "task-1", "fp_old", now - 60 * 24 * 60 * 60 * 1000),
    ]);
    expect(insertError).toBeNull();

    const result = await executeQuery({
      name: "errors-cap-query",
      query: `SELECT error_fingerprint FROM errors GROUP BY error_fingerprint ORDER BY error_fingerprint`,
      schema: z.record(z.string(), z.any()),
      scope: "environment",
      organizationId: tenant.org,
      projectId: tenant.project,
      environmentId: tenant.env,
      period: "90d",
    });
    if (!result.success) throw result.error;
    expect(result.result.rows.map((r) => r.error_fingerprint)).toEqual(["fp_recent"]);
    expect(result.periodClipped).toBe(30);
  });
});
