import { ClickHouse } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { getCapability } from "@internal/alert-contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.setConfig({ testTimeout: 120_000 });

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
import type { Alert } from "~/v3/services/alerts/storage/alertStore.server";
import {
  createProductionEvaluateBinding,
  createQueryRowRunner,
} from "~/v3/services/alerts/engine/productionEvaluateBinding.server";
import {
  clickhouseDateTimeLiteral,
  evaluateQueryCapability,
  type QueryRowRunner,
} from "~/v3/services/alerts/evaluators/queryEvaluator.server";
import { getMetricSeries } from "~/v3/services/alerts/alertSeries.server";

const DAY_MS = 86_400_000;
const PLAN_DAYS = 30;
const TENANT = { org: "org_fr", project: "project_fr", env: "env_fr" };

function failedRun(task: string, fingerprint: string, createdAt: number) {
  const id = Math.random().toString(36).slice(2);
  return {
    environment_id: TENANT.env,
    organization_id: TENANT.org,
    project_id: TENANT.project,
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

type RawCommandClient = { command(args: { query: string }): Promise<unknown> };

async function seedParts(
  ch: ClickHouse,
  raw: RawCommandClient,
  runs: ReturnType<typeof failedRun>[]
) {
  await raw.command({ query: "SYSTEM STOP MERGES trigger_dev.errors_v1" });
  for (const run of runs) {
    const [error] = await ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
      name: "seed-failed-run",
      table: "trigger_dev.task_runs_v2",
      settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    })([run]);
    expect(error).toBeNull();
  }
}

const params = { environmentId: TENANT.env, scope: { type: "all" as const } };

describe("errors.new reads full retention", () => {
  clickhouseTest(
    "an old group with a recent unmerged part is not new",
    async ({ clickhouseContainer, clickhouseClient }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "fr-t1" });
      holder.ch = ch;
      const raw = clickhouseClient as unknown as RawCommandClient;
      const now = Date.now();
      try {
        await seedParts(ch, raw, [
          failedRun("task-1", "fp_recurring", now - 60 * DAY_MS),
          failedRun("task-1", "fp_recurring", now - 60_000),
          failedRun("task-1", "fp_new", now - 60_000),
        ]);

        const result = await evaluateQueryCapability(
          {
            capabilityKey: "errors.new",
            params,
            condition: { kind: "occurrence" },
            organizationId: TENANT.org,
            projectId: TENANT.project,
            now: new Date(now),
            ctx: {
              checkpoint: clickhouseDateTimeLiteral(new Date(now - 3600_000)),
              until: clickhouseDateTimeLiteral(new Date(now + 60_000)),
            },
          },
          createQueryRowRunner(10)
        );
        if (result.kind !== "occurrence") throw new Error("expected occurrence result");
        expect(result.occurrences.map((o) => o.facts.error_fingerprint)).toEqual(["fp_new"]);
      } finally {
        await raw.command({ query: "SYSTEM START MERGES trigger_dev.errors_v1" });
      }
    }
  );

  clickhouseTest("user errors queries keep the plan bound", async ({ clickhouseContainer }) => {
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "fr-t2" });
    holder.ch = ch;
    const now = Date.now();
    const [insertError] = await ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
      name: "seed-failed-runs",
      table: "trigger_dev.task_runs_v2",
      settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    })([
      failedRun("task-1", "fp_inside", now - (PLAN_DAYS - 1) * DAY_MS),
      failedRun("task-1", "fp_outside", now - (PLAN_DAYS + 1) * DAY_MS),
    ]);
    expect(insertError).toBeNull();

    const run = (explain: boolean) =>
      executeQuery({
        name: "errors-plan-bound",
        query: "SELECT error_fingerprint FROM errors GROUP BY error_fingerprint",
        schema: z.record(z.string(), z.any()),
        scope: "environment",
        organizationId: TENANT.org,
        projectId: TENANT.project,
        environmentId: TENANT.env,
        period: "90d",
        explain,
      });

    const explained = await run(true);
    if (!explained.success) throw explained.error;
    expect(explained.result.generatedSql).toContain("greaterOrEquals(errors.last_seen,");

    const rows = await run(false);
    if (!rows.success) throw rows.error;
    expect(rows.result.rows.map((r) => r.error_fingerprint)).toEqual(["fp_inside"]);
    expect(rows.periodClipped).toBe(PLAN_DAYS);
  });

  clickhouseTest(
    "errors.new series stays inside the plan window",
    async ({ clickhouseContainer, clickhouseClient }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "fr-t3" });
      holder.ch = ch;
      const raw = clickhouseClient as unknown as RawCommandClient;
      const now = Date.now();
      const planFloor = now - PLAN_DAYS * DAY_MS;
      try {
        await seedParts(ch, raw, [
          failedRun("task-1", "fp_recurring", now - 60 * DAY_MS),
          failedRun("task-1", "fp_recurring", now - 60_000),
          failedRun("task-1", "fp_before_plan", now - 40 * DAY_MS),
          failedRun("task-1", "fp_new", now - 60_000),
        ]);

        const rawRows: Record<string, unknown>[] = [];
        const realRunner = createQueryRowRunner(10);
        const runner: QueryRowRunner = async (...args) => {
          const rows = await realRunner(...args);
          rawRows.push(...rows);
          return rows;
        };

        const series = await getMetricSeries(
          {
            alertId: `fr-t3-${now}`,
            capability: getCapability("errors.new")!,
            params,
            condition: { kind: "occurrence" },
            organizationId: TENANT.org,
            projectId: TENANT.project,
            window: { since: new Date(now - 45 * DAY_MS), until: new Date(now) },
          },
          runner
        );

        const bucketMs = (r: Record<string, unknown>) => new Date(r.bucket as string).getTime();
        expect(rawRows.length).toBeGreaterThan(0);
        expect(rawRows.filter((r) => bucketMs(r) < planFloor - DAY_MS)).toEqual([]);
        const points = series.get("__agg__") ?? [];
        expect(points.filter((p) => p.bucket < planFloor - DAY_MS && p.value)).toEqual([]);
        expect(points.reduce((sum, p) => sum + (p.value ?? 0), 0)).toBe(1);
      } finally {
        await raw.command({ query: "SYSTEM START MERGES trigger_dev.errors_v1" });
      }
    }
  );

  clickhouseTest(
    "errors.new series ignores groups first seen after the window end",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "fr-t4" });
      holder.ch = ch;
      const now = Date.now();
      const until = now - 5 * DAY_MS;
      const [insertError] = await ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
        name: "seed-failed-runs",
        table: "trigger_dev.task_runs_v2",
        settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
      })([
        failedRun("task-1", "fp_in_window", now - 7 * DAY_MS),
        failedRun("task-1", "fp_after_window", now - DAY_MS),
      ]);
      expect(insertError).toBeNull();

      const rawRows: Record<string, unknown>[] = [];
      const realRunner = createQueryRowRunner(10);
      const runner: QueryRowRunner = async (...args) => {
        const rows = await realRunner(...args);
        rawRows.push(...rows);
        return rows;
      };
      const series = await getMetricSeries(
        {
          alertId: `fr-t4-${now}`,
          capability: getCapability("errors.new")!,
          params,
          condition: { kind: "occurrence" },
          organizationId: TENANT.org,
          projectId: TENANT.project,
          window: { since: new Date(now - 10 * DAY_MS), until: new Date(until) },
        },
        runner
      );

      expect(rawRows.filter((r) => new Date(r.bucket as string).getTime() >= until)).toEqual([]);
      const points = series.get("__agg__") ?? [];
      expect(points.reduce((sum, p) => sum + (p.value ?? 0), 0)).toBe(1);
    }
  );

  it("clamps the errors.new lower bound to the plan floor", async () => {
    const queries: string[] = [];
    const binding = createProductionEvaluateBinding({
      queryRowRunner: async (query) => {
        queries.push(query);
        return [];
      },
      seenRetentionSec: 90 * 86_400,
    });
    const before = Date.now();
    const alert = {
      id: "alert_floor",
      organizationId: TENANT.org,
      projectId: TENANT.project,
      capabilityKey: "errors.new",
      params,
      condition: { kind: "occurrence" },
      evaluatorState: { checkpoint: new Date(before - 60 * DAY_MS).toISOString() },
      createdAt: new Date(before - 80 * DAY_MS),
    } as unknown as Alert;
    await binding(alert, getCapability("errors.new")!);

    const bounds = queries.map((q) => {
      const literal = /group_first_seen >= '([^']+)'/.exec(q)![1]!;
      return Date.parse(`${literal.replace(" ", "T")}Z`);
    });
    expect(bounds.length).toBeGreaterThan(0);
    expect(Math.min(...bounds)).toBeGreaterThanOrEqual(
      Math.floor((before - PLAN_DAYS * DAY_MS) / 1000) * 1000
    );
  });
});
