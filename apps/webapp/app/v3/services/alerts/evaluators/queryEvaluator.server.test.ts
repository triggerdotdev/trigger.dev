import { ClickHouse, executeTSQL } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { z } from "zod";
import { querySchemas } from "~/v3/querySchemas";
import {
  escapeTsqlString,
  checkpointSince,
  clickhouseDateTimeLiteral,
  DEFAULT_CHECKPOINT_LOOKBACK_SEC,
  evaluateQueryCapability,
  ROWS_CAP,
  type QueryEvaluatorInput,
  type QueryRowRunner,
} from "./queryEvaluator.server";

// Synchronous insert so ClickHouse MVs are queryable immediately after insert.
const SYNC = { params: { clickhouse_settings: { async_insert: 0 as const } } };

const ORG = "org_alerts_eval";
const PROJECT = "project_alerts_eval";
const ENV = "env_alerts_eval";

function clickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function clickhouseDateTime64(date: Date): string {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function gaugeRow(queue: string, at: Date, queued: number, running = 0, limit = 10) {
  return {
    organization_id: ORG,
    project_id: PROJECT,
    environment_id: ENV,
    queue_name: queue,
    event_time: clickhouseDateTime(at),
    op: "gauge" as const,
    running,
    queued,
    queue_limit: limit,
  };
}

function startedRow(queue: string, at: Date, cumulative: number) {
  return {
    organization_id: ORG,
    project_id: PROJECT,
    environment_id: ENV,
    queue_name: queue,
    event_time: clickhouseDateTime(at),
    order_key: at.getTime() * 1_000_000,
    op: "started" as const,
    cumulative,
  };
}

function makeTestRunner(clickhouseContainer: { getConnectionUrl(): string }): QueryRowRunner {
  const ch = new ClickHouse({
    url: clickhouseContainer.getConnectionUrl(),
    name: "alerts-eval-test",
  });
  return async (query, context, range) => {
    const matched = querySchemas.find((s) =>
      new RegExp(`\\bFROM\\s+${s.name}\\b`, "i").test(query)
    );
    const timeColumn = matched?.timeConstraint ?? "triggered_at";
    const from = new Date(range.from);
    const to = new Date(range.to);

    const [error, result] = await executeTSQL(ch.reader, {
      name: "alerts-eval-test",
      query,
      schema: z.record(z.string(), z.any()),
      tableSchema: querySchemas,
      transformValues: true,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: context.organizationId },
        project_id: { op: "eq", value: context.projectId },
        environment_id: { op: "eq", value: context.environmentId },
        [timeColumn]: { op: "between", low: from, high: to },
      },
      timeRange: { from, to },
    });

    if (error) throw error;
    return result.rows;
  };
}

function baseInput(overrides: Partial<QueryEvaluatorInput> = {}): QueryEvaluatorInput {
  return {
    capabilityKey: "queue.depth",
    organizationId: ORG,
    projectId: PROJECT,
    params: { environmentId: ENV, scope: { type: "queue", queue: "q1" } },
    condition: { kind: "threshold", operator: ">", value: 10, windowSec: 20 },
    now: new Date(),
    ...overrides,
  };
}

describe("queryEvaluator", () => {
  clickhouseTest(
    "queue.depth: threshold met when depth exceeds the value",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      await ch.queueMetrics.insertRaw([gaugeRow("q1", new Date(now.getTime() - 5_000), 15)], SYNC);

      const result = await evaluateQueryCapability(baseInput({ now }), runner);
      expect(result.outcome).toBe("met");
      expect(result.facts.value).toBe(15);
    }
  );

  clickhouseTest(
    "queue.depth: threshold not_met when depth is within the value",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      await ch.queueMetrics.insertRaw([gaugeRow("q1", new Date(now.getTime() - 5_000), 3)], SYNC);

      const result = await evaluateQueryCapability(baseInput({ now }), runner);
      expect(result.outcome).toBe("not_met");
    }
  );

  clickhouseTest(
    "queue.depth: gauge carries the last observed value forward when the current window is empty",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      // Outside the 20s window, inside the 900s (3 x minCadenceSec=300) horizon.
      await ch.queueMetrics.insertRaw([gaugeRow("q1", new Date(now.getTime() - 40_000), 20)], SYNC);

      const result = await evaluateQueryCapability(baseInput({ now }), runner);
      expect(result.outcome).toBe("met");
      expect(result.facts.value).toBe(20);
    }
  );

  clickhouseTest(
    "queue.depth: unavailable when the last observed value is beyond the freshness horizon",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      // Beyond the 900s (3 x minCadenceSec=300) horizon; the user's windowSec (20s) is
      // irrelevant to the horizon -- it's cadence-based, not window-based.
      await ch.queueMetrics.insertRaw(
        [gaugeRow("q1", new Date(now.getTime() - 1_000_000), 20)],
        SYNC
      );

      const result = await evaluateQueryCapability(baseInput({ now }), runner);
      expect(result.outcome).toBe("unavailable");
      expect(result.facts.value).toBeNull();
    }
  );

  clickhouseTest(
    "queue.depth: a value observed exactly at the horizon edge is still carried (inclusive)",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      // Align to a 10s boundary so concurrency_metrics' 10s bucketing can't shift the event
      // across the horizon edge.
      const now = new Date(Math.floor(Date.now() / 10_000) * 10_000);
      const horizonSec = 300 * 3; // capability.binding.minCadenceSec * GAUGE_HORIZON_MULTIPLIER

      await ch.queueMetrics.insertRaw(
        [gaugeRow("q1", new Date(now.getTime() - horizonSec * 1000), 20)],
        SYNC
      );

      const result = await evaluateQueryCapability(baseInput({ now }), runner);
      expect(result.outcome).toBe("met");
      expect(result.facts.value).toBe(20);
    }
  );

  clickhouseTest(
    "queue.depth: pattern scope carries per-queue values forward, offenders from the worst",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      await ch.queueMetrics.insertRaw(
        [
          // Fresh, inside the window.
          gaugeRow("worker-fresh", new Date(now.getTime() - 5_000), 3),
          // Stale but inside the 900s horizon -- carried forward.
          gaugeRow("worker-stale", new Date(now.getTime() - 400_000), 25),
          // Beyond the 900s horizon -- silently excluded, does not block the others.
          gaugeRow("worker-gone", new Date(now.getTime() - 1_000_000), 99),
        ],
        SYNC
      );

      const result = await evaluateQueryCapability(
        baseInput({
          params: { environmentId: ENV, scope: { type: "queuePattern", pattern: "worker-%" } },
          condition: { kind: "threshold", operator: ">", value: 10, windowSec: 20 },
          now,
        }),
        runner
      );

      expect(result.outcome).toBe("met");
      expect(result.facts.value).toBe(25);
      const offenders = result.facts.offenders as { key: string; value: number }[];
      expect(offenders).toEqual(
        expect.arrayContaining([
          { key: "worker-fresh", value: 3 },
          { key: "worker-stale", value: 25 },
        ])
      );
      expect(offenders.some((o) => o.key === "worker-gone")).toBe(false);
    }
  );

  clickhouseTest(
    "runs.volume: empty window is a genuine zero, not unavailable",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const now = new Date();

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "runs.volume",
          params: { environmentId: ENV, scope: { type: "task", taskIdentifier: "my-task" } },
          condition: { kind: "threshold", operator: ">", value: 0, windowSec: 60 },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("not_met");
      expect(result.facts.value).toBe(0);
    }
  );

  clickhouseTest(
    "runs.created: absence met when no runs occurred in the quiet window",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const now = new Date();

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "runs.created",
          params: { environmentId: ENV, scope: { type: "all" } },
          condition: { kind: "absence", quietWindowSec: 1800 },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("met");
      expect(result.facts.value).toBe(0);
    }
  );

  clickhouseTest(
    "runs.created: impossible when the quiet window is below the capability minimum (DEC-088)",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const now = new Date();

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "runs.created",
          params: { environmentId: ENV, scope: { type: "all" } },
          condition: { kind: "absence", quietWindowSec: 60 },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("impossible");
    }
  );

  clickhouseTest(
    "queue.stalled: met when depth > 0 and no dequeue occurred over the window",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      await ch.queueMetrics.insertRaw([gaugeRow("q1", new Date(now.getTime() - 5_000), 4)], SYNC);

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "queue.stalled",
          params: { environmentId: ENV, scope: { type: "queue", queue: "q1" }, windowSec: 20 },
          condition: { kind: "state", stateKey: "stalled" },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("met");
    }
  );

  clickhouseTest(
    "queue.stalled: not_met when a dequeue occurred over the window",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date(Math.floor(Date.now() / 10_000) * 10_000);

      await ch.queueMetrics.insertRaw(
        [
          gaugeRow("q1", new Date(now.getTime() - 5_000), 4),
          startedRow("q1", new Date(now.getTime() - 5_000), 0),
          startedRow("q1", new Date(now.getTime() - 4_000), 1),
        ],
        SYNC
      );

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "queue.stalled",
          params: { environmentId: ENV, scope: { type: "queue", queue: "q1" }, windowSec: 20 },
          condition: { kind: "state", stateKey: "stalled" },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("not_met");
    }
  );

  clickhouseTest(
    "runs.failure_rate: not_met below the min-volume guard",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const now = new Date();

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "runs.failure_rate",
          params: { environmentId: ENV, scope: { type: "all" } },
          condition: { kind: "threshold", operator: ">", value: 50, windowSec: 60 },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("not_met");
      expect(result.facts.lowVolume).toBe(true);
    }
  );

  clickhouseTest(
    "runs.failure_rate: met when the failure share exceeds the threshold",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      const rows = Array.from({ length: 12 }, (_, i) => ({
        environment_id: ENV,
        organization_id: ORG,
        project_id: PROJECT,
        run_id: `run_fr_${i}`,
        friendly_id: `run_fr_${i}`,
        updated_at: now.getTime(),
        created_at: now.getTime() - 5_000,
        status: i < 8 ? "CRASHED" : "COMPLETED_SUCCESSFULLY",
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
        span_id: `span_fr_${i}`,
        trace_id: `trace_fr_${i}`,
        idempotency_key: "",
        expiration_ttl: "",
        _version: String(now.getTime()),
        _is_deleted: 0,
      }));

      const insertRun = ch.writer.insert({
        name: "insertAlertsEvalFailureRateRuns",
        table: "trigger_dev.task_runs_v2",
        schema: z.any(),
        settings: { enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
      });
      await insertRun(rows, SYNC);

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "runs.failure_rate",
          params: { environmentId: ENV, scope: { type: "all" } },
          condition: { kind: "threshold", operator: ">", value: 50, windowSec: 60 },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("met");
      expect(result.facts.total).toBe(12);
    }
  );

  clickhouseTest(
    "queue.oldest_age: threshold met against a currently-queued run",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();

      const row = {
        environment_id: ENV,
        organization_id: ORG,
        project_id: PROJECT,
        run_id: "run_oldest_1",
        friendly_id: "run_oldest_1",
        updated_at: now.getTime(),
        created_at: now.getTime() - 30_000,
        queued_at: now.getTime() - 30_000,
        status: "PENDING",
        environment_type: "DEVELOPMENT",
        attempt: 1,
        engine: "V2",
        task_identifier: "my-task",
        queue: "q1",
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
        span_id: "span_oldest_1",
        trace_id: "trace_oldest_1",
        idempotency_key: "",
        expiration_ttl: "",
        _version: String(now.getTime()),
        _is_deleted: 0,
      };

      const insertRun = ch.writer.insert({
        name: "insertAlertsEvalOldestAgeRun",
        table: "trigger_dev.task_runs_v2",
        schema: z.any(),
        settings: { enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
      });
      await insertRun([row], SYNC);

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "queue.oldest_age",
          params: { environmentId: ENV, scope: { type: "queue", queue: "q1" } },
          condition: { kind: "threshold", operator: ">", value: 10_000, windowSec: 60 },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("met");
      expect(result.facts.value).toBeGreaterThanOrEqual(29_000);
    }
  );

  clickhouseTest(
    "queue.oldest_age: no currently-queued runs is value 0 / not_met, never unavailable",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const now = new Date();

      const result = await evaluateQueryCapability(
        baseInput({
          capabilityKey: "queue.oldest_age",
          params: { environmentId: ENV, scope: { type: "queue", queue: "q-empty" } },
          condition: { kind: "threshold", operator: ">", value: 10_000, windowSec: 60 },
          now,
        }),
        runner
      );
      expect(result.outcome).toBe("not_met");
      expect(result.facts.value).toBe(0);
    }
  );

  clickhouseTest(
    "queue.depth: a hostile queue name is matched literally, not as SQL",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date();
      const hostileQueue = "q1' OR '1'='1";

      await ch.queueMetrics.insertRaw(
        [
          gaugeRow(hostileQueue, new Date(now.getTime() - 5_000), 15),
          gaugeRow("q-other", new Date(now.getTime() - 5_000), 999),
        ],
        SYNC
      );

      const result = await evaluateQueryCapability(
        baseInput({
          params: { environmentId: ENV, scope: { type: "queue", queue: hostileQueue } },
          now,
        }),
        runner
      );
      // Matches only the exact hostile-named queue's depth, not "q-other" via injection.
      expect(result.outcome).toBe("met");
      expect(result.facts.value).toBe(15);
    }
  );
});

clickhouseTest(
  "runs.duration_p95: unavailable when no data within the gauge horizon",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const now = new Date();

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "runs.duration_p95",
        params: { environmentId: ENV, scope: { type: "queue", queue: "q-p95-empty" } },
        condition: { kind: "threshold", operator: "<", value: 10_000, windowSec: 20 },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("unavailable");
  }
);

clickhouseTest(
  "runs.failure_rate: met when 39% exceeds the 10% threshold",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();

    const rows = Array.from({ length: 20 }, (_, i) => ({
      environment_id: ENV,
      organization_id: ORG,
      project_id: PROJECT,
      run_id: `run_fr39_${i}`,
      friendly_id: `run_fr39_${i}`,
      updated_at: now.getTime(),
      created_at: now.getTime() - 60_000,
      status: i < 8 ? "CRASHED" : "COMPLETED_SUCCESSFULLY",
      environment_type: "DEVELOPMENT",
      attempt: 1,
      engine: "V2",
      task_identifier: "demo-task",
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
      span_id: `span_fr39_${i}`,
      trace_id: `trace_fr39_${i}`,
      idempotency_key: "",
      expiration_ttl: "",
      _version: String(now.getTime()),
      _is_deleted: 0,
    }));

    const insertRun = ch.writer.insert({
      name: "insertAlertsEvalFailureRate39",
      table: "trigger_dev.task_runs_v2",
      schema: z.any(),
      settings: { enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    });
    await insertRun(rows, SYNC);

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "runs.failure_rate",
        params: {
          environmentId: ENV,
          scope: { type: "task", taskIdentifier: "demo-task" },
        },
        condition: { kind: "threshold", operator: ">", value: 10, windowSec: 3600 },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("met");
    expect(result.facts.value).toBeGreaterThan(10);
  }
);

clickhouseTest(
  "runs.duration_p95: not_met with a numeric reading when p95 is below threshold",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();

    const rows = Array.from({ length: 20 }, (_, i) => ({
      environment_id: ENV,
      organization_id: ORG,
      project_id: PROJECT,
      run_id: `run_p95_${i}`,
      friendly_id: `run_p95_${i}`,
      updated_at: now.getTime(),
      created_at: now.getTime() - 60_000,
      executed_at: clickhouseDateTime64(new Date(now.getTime() - 60_000)),
      completed_at: clickhouseDateTime64(
        new Date(now.getTime() - 60_000 + (i < 19 ? 1000 + i * 50 : 1700))
      ),
      status: "COMPLETED_SUCCESSFULLY",
      environment_type: "DEVELOPMENT",
      attempt: 1,
      engine: "V2",
      task_identifier: "p95-task",
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
      span_id: `span_p95_${i}`,
      trace_id: `trace_p95_${i}`,
      idempotency_key: "",
      expiration_ttl: "",
      _version: String(now.getTime()),
      _is_deleted: 0,
    }));

    const insertRun = ch.writer.insert({
      name: "insertAlertsEvalDurationP95",
      table: "trigger_dev.task_runs_v2",
      schema: z.any(),
      settings: { enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    });
    await insertRun(rows, SYNC);

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "runs.duration_p95",
        params: { environmentId: ENV, scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: 2000, windowSec: 900 },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("not_met");
    expect(result.facts.value).toBeGreaterThan(0);
  }
);

clickhouseTest(
  "runs.duration_p95: met when p95 exceeds the threshold",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();

    const rows = Array.from({ length: 20 }, (_, i) => ({
      environment_id: ENV,
      organization_id: ORG,
      project_id: PROJECT,
      run_id: `run_p95met_${i}`,
      friendly_id: `run_p95met_${i}`,
      updated_at: now.getTime(),
      created_at: now.getTime() - 60_000,
      executed_at: clickhouseDateTime64(new Date(now.getTime() - 60_000)),
      completed_at: clickhouseDateTime64(
        new Date(now.getTime() - 60_000 + (i < 19 ? 1000 + i * 50 : 1700))
      ),
      status: "COMPLETED_SUCCESSFULLY",
      environment_type: "DEVELOPMENT",
      attempt: 1,
      engine: "V2",
      task_identifier: "p95-task-met",
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
      span_id: `span_p95met_${i}`,
      trace_id: `trace_p95met_${i}`,
      idempotency_key: "",
      expiration_ttl: "",
      _version: String(now.getTime()),
      _is_deleted: 0,
    }));

    const insertRun = ch.writer.insert({
      name: "insertAlertsEvalDurationP95Met",
      table: "trigger_dev.task_runs_v2",
      schema: z.any(),
      settings: { enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    });
    await insertRun(rows, SYNC);

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "runs.duration_p95",
        params: { environmentId: ENV, scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: 1500, windowSec: 900 },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("met");
    expect(result.facts.value).toBeGreaterThan(1500);
  }
);

clickhouseTest(
  "queue.stalled: met when data is outside the window but inside the horizon",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();

    await ch.queueMetrics.insertRaw(
      [gaugeRow("worker-2", new Date(now.getTime() - 40_000), 8)],
      SYNC
    );

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "queue.stalled",
        params: {
          environmentId: ENV,
          scope: { type: "queue", queue: "worker-2" },
          windowSec: 20,
        },
        condition: { kind: "state", stateKey: "stalled" },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("met");
    expect(result.facts.value).toBe(1);
  }
);

clickhouseTest(
  "queue.stalled: horizon fallback ignores starts older than the window",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();

    await ch.queueMetrics.insertRaw(
      [
        gaugeRow("q", new Date(now.getTime() - 40_000), 8),
        startedRow("q", new Date(now.getTime() - 60_000), 100),
        startedRow("q", new Date(now.getTime() - 50_000), 105),
      ],
      SYNC
    );

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "queue.stalled",
        params: { environmentId: ENV, scope: { type: "queue", queue: "q" }, windowSec: 20 },
        condition: { kind: "state", stateKey: "stalled" },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("met");
    expect(result.facts.value).toBe(1);
  }
);

clickhouseTest(
  "queue.stalled: horizon fallback treats a drained then quiet queue as not stalled",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);

    await ch.queueMetrics.insertRaw(
      [
        gaugeRow("q", ago(80_000), 8),
        startedRow("q", ago(70_000), 100),
        startedRow("q", ago(60_000), 105),
        gaugeRow("q", ago(40_000), 0),
      ],
      SYNC
    );

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "queue.stalled",
        params: { environmentId: ENV, scope: { type: "queue", queue: "q" }, windowSec: 20 },
        condition: { kind: "state", stateKey: "stalled" },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("not_met");
  }
);

clickhouseTest(
  "queue.stalled: horizon fallback ignores a started-only latest bucket",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);

    await ch.queueMetrics.insertRaw(
      [
        gaugeRow("q", ago(80_000), 8),
        startedRow("q", ago(70_000), 100),
        startedRow("q", ago(60_000), 105),
      ],
      SYNC
    );

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "queue.stalled",
        params: { environmentId: ENV, scope: { type: "queue", queue: "q" }, windowSec: 20 },
        condition: { kind: "state", stateKey: "stalled" },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("met");
  }
);

clickhouseTest(
  "queue.stalled: starts inside the window are not stalled",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);

    await ch.queueMetrics.insertRaw(
      [
        gaugeRow("q", ago(6_000), 8),
        startedRow("q", ago(9_000), 100),
        startedRow("q", ago(2_000), 105),
      ],
      SYNC
    );

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "queue.stalled",
        params: { environmentId: ENV, scope: { type: "queue", queue: "q" }, windowSec: 20 },
        condition: { kind: "state", stateKey: "stalled" },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("not_met");
  }
);

clickhouseTest(
  "queue.stalled: queued depth without starts is stalled",
  async ({ clickhouseContainer }) => {
    const runner = makeTestRunner(clickhouseContainer);
    const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);

    await ch.queueMetrics.insertRaw([gaugeRow("q", ago(6_000), 8)], SYNC);

    const result = await evaluateQueryCapability(
      baseInput({
        capabilityKey: "queue.stalled",
        params: { environmentId: ENV, scope: { type: "queue", queue: "q" }, windowSec: 20 },
        condition: { kind: "state", stateKey: "stalled" },
        now,
      }),
      runner
    );
    expect(result.outcome).toBe("met");
  }
);

async function insertLivenessRun(clickhouseContainer: { getConnectionUrl(): string }, at: number) {
  const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
  const insertRun = ch.writer.insert({
    name: "insertAlertsEvalLivenessSilence",
    table: "trigger_dev.task_runs_v2",
    schema: z.any(),
    settings: { enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  });
  await insertRun(
    [
      {
        environment_id: ENV,
        organization_id: ORG,
        project_id: PROJECT,
        run_id: "run_liveness_old",
        friendly_id: "run_liveness_old",
        updated_at: at,
        created_at: at,
        status: "COMPLETED_SUCCESSFULLY",
        environment_type: "DEVELOPMENT",
        attempt: 1,
        engine: "V2",
        task_identifier: "liveness-task",
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
        span_id: "span_liveness_old",
        trace_id: "trace_liveness_old",
        idempotency_key: "",
        expiration_ttl: "",
        _version: String(at),
        _is_deleted: 0,
      },
    ],
    SYNC
  );
}

function evaluateLiveness(
  clickhouseContainer: { getConnectionUrl(): string },
  now: Date,
  params?: Record<string, number>
) {
  return evaluateQueryCapability(
    baseInput({
      capabilityKey: "health.liveness",
      params: { environmentId: ENV, scope: { type: "all" }, windowSec: 600 },
      condition: { kind: "state", stateKey: "degraded", ...(params ? { params } : {}) },
      now,
    }),
    makeTestRunner(clickhouseContainer)
  );
}

clickhouseTest(
  "health.liveness: silence longer than the window stays met",
  async ({ clickhouseContainer }) => {
    const now = new Date();
    await insertLivenessRun(clickhouseContainer, now.getTime() - 20 * 60_000);

    const result = await evaluateLiveness(clickhouseContainer, now);
    expect(result.outcome).toBe("met");
  }
);

clickhouseTest(
  "health.liveness: a run inside a silence longer than the window is not met",
  async ({ clickhouseContainer }) => {
    const now = new Date();
    await insertLivenessRun(clickhouseContainer, now.getTime() - 20 * 60_000);

    const result = await evaluateLiveness(clickhouseContainer, now, { silenceSec: 3600 });
    expect(result.outcome).toBe("not_met");
  }
);

clickhouseTest(
  "health.liveness: no run for longer than the silence is met",
  async ({ clickhouseContainer }) => {
    const now = new Date();
    await insertLivenessRun(clickhouseContainer, now.getTime() - 2 * 3600_000);

    const result = await evaluateLiveness(clickhouseContainer, now, { silenceSec: 3600 });
    expect(result.outcome).toBe("met");
  }
);

describe("gauge sequential execution", () => {
  it("runs horizon and current queries sequentially, not concurrently (mutation: use Promise.all -> second call rejected)", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const serialRunner: QueryRowRunner = async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return [{ q1: "q1", value: 5 }];
    };

    const input = baseInput({ now: new Date() });
    const result = await evaluateQueryCapability(input, serialRunner);
    expect(result.outcome).toBe("not_met");
    expect(maxInflight).toBe(1);
  });
});

describe("escapeTsqlString", () => {
  it("escapes single quotes", () => {
    expect(escapeTsqlString("a'b")).toBe("a\\'b");
  });

  it("escapes backslashes before quotes, so a trailing backslash can't consume the closing quote", () => {
    expect(escapeTsqlString("a\\")).toBe("a\\\\");
    expect(escapeTsqlString("a\\'b")).toBe("a\\\\\\'b");
  });

  it("rejects control characters", () => {
    expect(() => escapeTsqlString("a\x00b")).toThrow();
    expect(() => escapeTsqlString("a\tb")).toThrow();
  });
});

describe("rows emit", () => {
  const CHECKPOINT = "'2026-10-05 12:00:00'";

  function errorsInput(overrides: Partial<QueryEvaluatorInput> = {}): QueryEvaluatorInput {
    return baseInput({
      capabilityKey: "errors.occurred_again",
      params: {
        environmentId: ENV,
        scope: { type: "errorGroup", taskIdentifier: "my-task", fingerprint: "fp1" },
      },
      condition: { kind: "occurrence" },
      ctx: { checkpoint: CHECKPOINT },
      ...overrides,
    });
  }

  it("errorGroup scopeWhere filters by task and fingerprint, and the checkpoint is substituted", async () => {
    let captured = "";
    const runner: QueryRowRunner = async (query) => {
      captured = query;
      return [];
    };
    const result = await evaluateQueryCapability(errorsInput(), runner);
    expect(result.kind).toBe("occurrence");
    expect(captured).toContain(
      "WHERE task_identifier = 'my-task' AND error_fingerprint = 'fp1' AND minute >= '2026-10-05 12:00:00'"
    );
    expect(captured).not.toContain("{{");
  });

  it("errorGroup scope values are escaped", async () => {
    let captured = "";
    const runner: QueryRowRunner = async (query) => {
      captured = query;
      return [];
    };
    await evaluateQueryCapability(
      errorsInput({
        params: {
          environmentId: ENV,
          scope: { type: "errorGroup", taskIdentifier: "t'x", fingerprint: "f\\" },
        },
      }),
      runner
    );
    expect(captured).toContain("task_identifier = 't\\'x' AND error_fingerprint = 'f\\\\'");
  });

  it("maps rows to occurrences with stable sourceEventIds (errors.occurred_again)", async () => {
    const rows = [
      {
        task_identifier: "my-task",
        error_fingerprint: "fp1",
        minute: "2026-10-05 12:01:00",
        occurrences: 3,
      },
      {
        task_identifier: "my-task",
        error_fingerprint: "fp1",
        minute: "2026-10-05 12:02:00",
        occurrences: 1,
      },
    ];
    const runner: QueryRowRunner = async () => rows;

    const first = await evaluateQueryCapability(errorsInput(), runner);
    const second = await evaluateQueryCapability(errorsInput(), runner);
    if (first.kind !== "occurrence" || second.kind !== "occurrence") throw new Error("kind");

    expect(first.outcome).toBe("met");
    expect(first.occurrences.map((o) => o.sourceEventId)).toEqual([
      `errors.occurred_again:${ENV}:my-task:fp1:2026-10-05 12:01:00`,
      `errors.occurred_again:${ENV}:my-task:fp1:2026-10-05 12:02:00`,
    ]);
    expect(first.occurrences[0]!.facts).toMatchObject({ occurrences: 3 });
    expect(second.occurrences.map((o) => o.sourceEventId)).toEqual(
      first.occurrences.map((o) => o.sourceEventId)
    );
  });

  it("maps rows to occurrences keyed by task and fingerprint (errors.new)", async () => {
    let captured = "";
    const runner: QueryRowRunner = async (query) => {
      captured = query;
      return [
        { task_identifier: "a", error_fingerprint: "f1", first_seen: "2026-10-05 12:01:00" },
        { task_identifier: "b", error_fingerprint: "f2", first_seen: "2026-10-05 12:02:00" },
      ];
    };
    const result = await evaluateQueryCapability(
      errorsInput({
        capabilityKey: "errors.new",
        params: { environmentId: ENV, scope: { type: "all" } },
      }),
      runner
    );
    if (result.kind !== "occurrence") throw new Error("kind");
    expect(captured).toContain("HAVING group_first_seen >= '2026-10-05 12:00:00'");
    expect(result.occurrences.map((o) => o.sourceEventId)).toEqual([
      `errors.new:${ENV}:a:f1`,
      `errors.new:${ENV}:b:f2`,
    ]);
  });

  it("no rows -> not_met with zero occurrences", async () => {
    const result = await evaluateQueryCapability(errorsInput(), async () => []);
    if (result.kind !== "occurrence") throw new Error("kind");
    expect(result.outcome).toBe("not_met");
    expect(result.occurrences).toHaveLength(0);
  });

  it("caps rows per evaluation and records the cap in facts", async () => {
    let captured = "";
    const rows = Array.from({ length: ROWS_CAP + 1 }, (_, i) => ({
      task_identifier: "my-task",
      error_fingerprint: "fp1",
      minute: `m${i}`,
      occurrences: 1,
    }));
    const result = await evaluateQueryCapability(errorsInput(), async (query) => {
      captured = query;
      return rows;
    });
    if (result.kind !== "occurrence") throw new Error("kind");
    expect(captured).toMatch(new RegExp(`LIMIT ${ROWS_CAP + 1}$`));
    expect(result.occurrences).toHaveLength(ROWS_CAP);
    expect(result.facts).toMatchObject({ rowCap: ROWS_CAP, rowCount: ROWS_CAP, capped: true });
  });

  function failedRun(task: string, fingerprint: string, createdAt: number) {
    const id = Math.random().toString(36).slice(2);
    return {
      environment_id: ENV,
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

  async function seedErrors(ch: ClickHouse, base: number) {
    const insert = ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
      name: "seed-failed-runs",
      table: "trigger_dev.task_runs_v2",
      settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    });
    const batches = [
      [failedRun("task-old", "fp_old", base - 10 * 60_000)],
      [failedRun("task-old", "fp_old", base - 3 * 60_000)],
      [failedRun("task-1", "fp_a", base - 2 * 60_000)],
      [failedRun("task-2", "fp_b", base - 60_000), failedRun("task-old", "fp_old", base - 60_000)],
    ];
    for (const batch of batches) {
      const [error] = await insert(batch);
      expect(error).toBeNull();
    }
  }

  clickhouseTest(
    "errors.new emits only groups first seen after the checkpoint",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const base = Math.floor(Date.now() / 60_000) * 60_000;
      await seedErrors(ch, base);

      const result = await evaluateQueryCapability(
        errorsInput({
          capabilityKey: "errors.new",
          params: { environmentId: ENV, scope: { type: "all" } },
          now: new Date(base),
          ctx: { checkpoint: clickhouseDateTimeLiteral(new Date(base - 5 * 60_000)) },
        }),
        runner
      );
      if (result.kind !== "occurrence") throw new Error("kind");
      expect(result.occurrences.map((o) => o.sourceEventId).sort()).toEqual([
        `errors.new:${ENV}:task-1:fp_a`,
        `errors.new:${ENV}:task-2:fp_b`,
      ]);
    }
  );

  clickhouseTest(
    "errors.occurred_again emits per-minute occurrences after the checkpoint",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const base = Math.floor(Date.now() / 60_000) * 60_000;
      await seedErrors(ch, base);

      const result = await evaluateQueryCapability(
        errorsInput({
          params: {
            environmentId: ENV,
            scope: { type: "errorGroup", taskIdentifier: "task-old", fingerprint: "fp_old" },
          },
          now: new Date(base),
          ctx: { checkpoint: clickhouseDateTimeLiteral(new Date(base - 5 * 60_000)) },
        }),
        runner
      );
      if (result.kind !== "occurrence") throw new Error("kind");
      expect(result.occurrences.map((o) => o.sourceEventId)).toEqual([
        `errors.occurred_again:${ENV}:task-old:fp_old:${clickhouseDateTime(new Date(base - 3 * 60_000))}`,
        `errors.occurred_again:${ENV}:task-old:fp_old:${clickhouseDateTime(new Date(base - 60_000))}`,
      ]);
    }
  );

  async function insertRuns(ch: ClickHouse, runs: ReturnType<typeof failedRun>[]) {
    const insert = ch.writer.insertUnsafe<ReturnType<typeof failedRun>>({
      name: "seed-failed-runs",
      table: "trigger_dev.task_runs_v2",
      settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
    });
    const [error] = await insert(runs);
    expect(error).toBeNull();
  }

  clickhouseTest(
    "errors.occurred_again finds a run in the checkpoint's own minute",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const base = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
      const checkpoint = new Date(base + 30_000);
      await insertRuns(ch, [failedRun("task-m", "fp_m", base + 40_000)]);

      const since = checkpointSince(
        checkpoint,
        new Date(base - 2 * 3600_000),
        DEFAULT_CHECKPOINT_LOOKBACK_SEC
      );
      const result = await evaluateQueryCapability(
        errorsInput({
          params: {
            environmentId: ENV,
            scope: { type: "errorGroup", taskIdentifier: "task-m", fingerprint: "fp_m" },
          },
          now: new Date(base + 5 * 60_000),
          ctx: { checkpoint: clickhouseDateTimeLiteral(since) },
        }),
        runner
      );
      if (result.kind !== "occurrence") throw new Error("kind");
      expect(result.occurrences.map((o) => o.sourceEventId)).toEqual([
        `errors.occurred_again:${ENV}:task-m:fp_m:${clickhouseDateTime(new Date(base))}`,
      ]);
    }
  );

  clickhouseTest(
    "errors.new finds a run created before the checkpoint but ingested after it",
    async ({ clickhouseContainer }) => {
      const runner = makeTestRunner(clickhouseContainer);
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const base = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
      const createdAt = new Date(base - 2 * 3600_000);
      const evaluate = (checkpoint: Date | undefined, now: Date) =>
        evaluateQueryCapability(
          errorsInput({
            capabilityKey: "errors.new",
            params: { environmentId: ENV, scope: { type: "all" } },
            now,
            ctx: {
              checkpoint: clickhouseDateTimeLiteral(
                checkpointSince(checkpoint, createdAt, DEFAULT_CHECKPOINT_LOOKBACK_SEC)
              ),
            },
          }),
          runner
        );

      const firstNow = new Date(base);
      const first = await evaluate(undefined, firstNow);
      if (first.kind !== "occurrence") throw new Error("kind");
      expect(first.occurrences).toHaveLength(0);

      await insertRuns(ch, [failedRun("task-late", "fp_late", firstNow.getTime() - 10 * 60_000)]);

      const second = await evaluate(firstNow, new Date(base + 5 * 60_000));
      if (second.kind !== "occurrence") throw new Error("kind");
      expect(second.occurrences.map((o) => o.sourceEventId)).toEqual([
        `errors.new:${ENV}:task-late:fp_late`,
      ]);
    }
  );

  it("throws when the checkpoint ctx is missing", async () => {
    await expect(
      evaluateQueryCapability(errorsInput({ ctx: undefined }), async () => [])
    ).rejects.toThrow(/ctx/);
  });
});

describe("checkpointSince retention clamp", () => {
  const NOW = new Date("2026-10-20T12:00:00.000Z");
  const RETENTION = 7 * 86_400;
  const LOOKBACK = 3600;
  const CREATED_AT = new Date("2026-09-01T00:00:00.000Z");

  it("clamps a 10 day old checkpoint to now - (retention - lookback)", () => {
    const checkpoint = new Date(NOW.getTime() - 10 * 86_400_000);
    const since = checkpointSince(checkpoint, CREATED_AT, LOOKBACK, {
      now: NOW,
      seenRetentionSec: RETENTION,
    });
    expect(since).toEqual(new Date(NOW.getTime() - (RETENTION - LOOKBACK) * 1000));
  });

  it("clamps without a checkpoint when createdAt is older than retention", () => {
    const createdAt = new Date(NOW.getTime() - 30 * 86_400_000);
    const since = checkpointSince(undefined, createdAt, LOOKBACK, {
      now: NOW,
      seenRetentionSec: RETENTION,
    });
    expect(since).toEqual(new Date(NOW.getTime() - (RETENTION - LOOKBACK) * 1000));
  });

  it("leaves a 30 minute old checkpoint unchanged", () => {
    const checkpoint = new Date(NOW.getTime() - 30 * 60_000);
    const expected = checkpointSince(checkpoint, CREATED_AT, LOOKBACK);
    expect(
      checkpointSince(checkpoint, CREATED_AT, LOOKBACK, { now: NOW, seenRetentionSec: RETENTION })
    ).toEqual(expected);
    expect(expected).toEqual(new Date(NOW.getTime() - 90 * 60_000));
  });
});
