import { ClickHouse, executeTSQL } from "@internal/clickhouse";
import { getCapability, type AlertParams } from "@internal/alert-contracts";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { querySchemas } from "~/v3/querySchemas";
import type { QueryRowRunner } from "./evaluators/queryEvaluator.server";
import { getHealthQuerySeries } from "./healthQuerySeries.server";

vi.setConfig({ testTimeout: 60_000 });

const SYNC = { params: { clickhouse_settings: { async_insert: 0 as const } } };
const ORG = "org_silence";
const PROJECT = "project_silence";
const ENV = "env_silence";
const THRESHOLD_SEC = 7200;

type Container = { getConnectionUrl(): string };

function makeRunner(clickhouseContainer: Container): QueryRowRunner {
  const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "silence" });
  return async (query, context, range) => {
    const from = new Date(range.from);
    const to = new Date(range.to);
    const [error, result] = await executeTSQL(ch.reader, {
      name: "silence",
      query,
      schema: z.record(z.string(), z.any()),
      tableSchema: querySchemas,
      transformValues: true,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: context.organizationId },
        project_id: { op: "eq", value: context.projectId },
        environment_id: { op: "eq", value: context.environmentId },
        triggered_at: { op: "between", low: from, high: to },
      },
      timeRange: { from, to },
    });
    if (error) throw error;
    return result.rows;
  };
}

async function insertRun(clickhouseContainer: Container, at: Date) {
  const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
  const insert = ch.writer.insert({
    name: "insertSilenceRun",
    table: "trigger_dev.task_runs_v2",
    schema: z.any(),
    settings: { enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  });
  await insert(
    [
      {
        environment_id: ENV,
        organization_id: ORG,
        project_id: PROJECT,
        run_id: "run_silence",
        friendly_id: "run_silence",
        updated_at: at.getTime(),
        created_at: at.getTime(),
        status: "COMPLETED_SUCCESSFULLY",
        environment_type: "DEVELOPMENT",
        attempt: 1,
        engine: "V2",
        task_identifier: "my-task",
        queue: "test",
        schedule_id: "",
        batch_id: "",
        output: null,
        error: null,
        error_fingerprint: "",
        tags: [],
        task_version: "",
        sdk_version: "",
        cli_version: "",
        machine_preset: "",
        root_run_id: "",
        parent_run_id: "",
        span_id: "span_silence",
        trace_id: "trace_silence",
        idempotency_key: "",
        expiration_ttl: "",
        _version: String(at.getTime()),
        _is_deleted: 0,
      },
    ],
    SYNC
  );
}

const params = { environmentId: ENV, scope: { type: "all" } } as AlertParams;

async function silenceLine(clickhouseContainer: Container, window: { since: Date; until: Date }) {
  const { series } = await getHealthQuerySeries(
    {
      alertId: "alert_silence",
      capability: getCapability("health.liveness")!,
      params,
      condition: { kind: "state", stateKey: "degraded", params: { silenceSec: THRESHOLD_SEC } },
      organizationId: ORG,
      projectId: PROJECT,
      window,
    },
    makeRunner(clickhouseContainer)
  );
  return series.find((s) => s.key === "silenceSec")!;
}

describe("liveness silence series", () => {
  clickhouseTest(
    "fails when a run before the window does not seed the silence",
    async ({ clickhouseContainer }) => {
      const since = new Date("2026-01-10T00:00:00Z");
      const until = new Date("2026-01-10T01:00:00Z");
      await insertRun(clickhouseContainer, new Date(since.getTime() - 86400_000));

      const line = await silenceLine(clickhouseContainer, { since, until });
      expect(line.points.length).toBeGreaterThan(0);
      expect(line.points.every((p) => p.value !== null && p.value > 100)).toBe(true);
    }
  );

  clickhouseTest(
    "fails when the current silence is missing from the final bucket",
    async ({ clickhouseContainer }) => {
      const since = new Date("2026-01-10T00:00:00Z");
      const until = new Date("2026-01-10T01:17:30Z");
      const runAt = new Date("2026-01-10T00:10:00Z");
      await insertRun(clickhouseContainer, runAt);

      const line = await silenceLine(clickhouseContainer, { since, until });
      const last = line.points[line.points.length - 1]!;
      expect(last.bucket).toBe(new Date("2026-01-10T01:10:00Z").getTime());
      expect((last.value! * THRESHOLD_SEC) / 100).toBeCloseTo(
        (until.getTime() - runAt.getTime()) / 1000
      );
    }
  );
});
