import { ClickHouse, executeTSQL } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listableQuerySchemas, querySchemas } from "~/v3/querySchemas";

vi.setConfig({ testTimeout: 60_000 });

const ORG = "org_errors_query";
const PROJECT = "project_errors_query";
const ENV_A = "env_errors_a";
const ENV_B = "env_errors_b";

function failedRun(environmentId: string, task: string, fingerprint: string, createdAt: number) {
  const id = Math.random().toString(36).slice(2);
  return {
    environment_id: environmentId,
    organization_id: ORG,
    project_id: PROJECT,
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

async function seed(ch: ClickHouse, now: number) {
  const insert = ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
    name: "seed-failed-runs",
    table: "trigger_dev.task_runs_v2",
    settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  });
  const batches = [
    [failedRun(ENV_A, "task-1", "fp_a", now - 120_000)],
    [failedRun(ENV_A, "task-1", "fp_a", now - 60_000)],
    [failedRun(ENV_A, "task-2", "fp_b", now - 30_000)],
    [failedRun(ENV_B, "task-1", "fp_a", now - 10_000), failedRun(ENV_B, "task-3", "fp_c", now)],
  ];
  for (const batch of batches) {
    const [error] = await insert(batch);
    expect(error).toBeNull();
  }
}

function runTsql(ch: ClickHouse, query: string) {
  return executeTSQL(ch.reader, {
    name: "errors-query-test",
    query,
    schema: z.record(z.string(), z.any()),
    tableSchema: querySchemas,
    transformValues: true,
    enforcedWhereClause: {
      organization_id: { op: "eq", value: ORG },
      project_id: { op: "eq", value: PROJECT },
      environment_id: { op: "eq", value: ENV_A },
    },
  });
}

describe("errors query tables", () => {
  clickhouseTest(
    "errors returns only the current environment's groups and matches the Errors page",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "errors" });
      const now = Date.now();
      await seed(ch, now);

      const [error, result] = await runTsql(
        ch,
        `SELECT task_identifier, error_fingerprint, any(error_type) AS error_type,
          min(first_seen) AS first_seen, max(last_seen) AS last_seen,
          sumMerge(occurrence_count) AS occurrence_count
        FROM errors
        GROUP BY task_identifier, error_fingerprint
        ORDER BY error_fingerprint`
      );
      expect(error).toBeNull();

      const rows = result!.rows.map((r) => ({
        task_identifier: r.task_identifier,
        error_fingerprint: r.error_fingerprint,
        error_type: r.error_type,
        first_seen: new Date(`${r.first_seen}Z`).getTime(),
        last_seen: new Date(`${r.last_seen}Z`).getTime(),
        occurrence_count: Number(r.occurrence_count),
      }));
      expect(rows).toEqual([
        {
          task_identifier: "task-1",
          error_fingerprint: "fp_a",
          error_type: "TypeError",
          first_seen: now - 120_000,
          last_seen: now - 60_000,
          occurrence_count: 2,
        },
        {
          task_identifier: "task-2",
          error_fingerprint: "fp_b",
          error_type: "TypeError",
          first_seen: now - 30_000,
          last_seen: now - 30_000,
          occurrence_count: 1,
        },
      ]);

      const [pageError, pageRows] = await ch.errors.getGroups({
        organizationId: ORG,
        projectId: PROJECT,
        environmentId: ENV_A,
        days: 30,
        limit: 50,
        offset: 0,
      });
      expect(pageError).toBeNull();
      const pageGroups = pageRows!
        .map((g) => ({
          task_identifier: g.task_identifier,
          error_fingerprint: g.error_fingerprint,
          error_type: g.error_type,
          first_seen: Number(g.first_seen),
          last_seen: Number(g.last_seen),
          occurrence_count: g.occurrence_count,
        }))
        .sort((a, b) => a.error_fingerprint.localeCompare(b.error_fingerprint));
      expect(rows).toEqual(pageGroups);
    }
  );

  clickhouseTest(
    "error_occurrences counts per minute for the current environment",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "errors" });
      const now = Date.now();
      await seed(ch, now);

      const since = new Date(now - 60 * 60_000).toISOString().slice(0, 19).replace("T", " ");
      const [error, result] = await runTsql(
        ch,
        `SELECT error_fingerprint, sum(count) AS total
        FROM error_occurrences
        WHERE minute >= '${since}'
        GROUP BY error_fingerprint
        ORDER BY error_fingerprint`
      );
      expect(error).toBeNull();
      expect(result!.rows.map((r) => [r.error_fingerprint, Number(r.total)])).toEqual([
        ["fp_a", 2],
        ["fp_b", 1],
      ]);

      const [countError, countResult] = await runTsql(
        ch,
        `SELECT count FROM error_occurrences WHERE minute >= '${since}'`
      );
      expect(countError).toBeNull();
      expect(countResult!.rows.reduce((sum, r) => sum + Number(r.count), 0)).toBe(3);
    }
  );

  it("schema listings include errors and error_occurrences", () => {
    const names = listableQuerySchemas({ includeQueueMetrics: false }).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["errors", "error_occurrences"]));
  });
});
