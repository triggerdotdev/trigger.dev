import { ClickHouse } from "@internal/clickhouse";
import { containerTestWithClickhouse } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type * as DbServer from "~/db.server";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({
  ch: undefined as unknown,
  prisma: undefined as unknown as Record<string | symbol, unknown>,
}));

vi.mock("~/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof DbServer>();
  const prisma = new Proxy({}, { get: (_target, prop) => holder.prisma[prop] });
  return { ...actual, prisma, $replica: prisma };
});
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => holder.ch },
}));
vi.mock("~/services/queryConcurrencyLimiter.server", () => ({
  queryConcurrencyLimiter: {
    acquire: async () => ({ success: true }),
    release: async () => {},
  },
  DEFAULT_ORG_CONCURRENCY_LIMIT: 10,
  GLOBAL_CONCURRENCY_LIMIT: 100,
}));

import { querySchemas } from "~/v3/querySchemas";
import {
  analyzeQueryForAlert,
  toQuerySignal,
} from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import { resolveAlertCapability } from "~/v3/services/alerts/queryAlerts/resolveAlertCapability.server";
import {
  getQueryAlertSeries,
  queryBucketEnds,
} from "~/v3/services/alerts/queryAlerts/queryAlertSeries.server";
import { createQueryRowRunner } from "~/v3/services/alerts/engine/productionEvaluateBinding.server";
import {
  evaluateQueryCapability,
  type QueryRowRunner,
} from "~/v3/services/alerts/evaluators/queryEvaluator.server";
import type { AlertParams, Condition } from "@internal/alert-contracts";

const TENANT = { org: "org_qs", project: "proj_qs", env: "env_qs" };
const MIN = 60_000;
const HOUR = 60 * MIN;

type RunSeed = { id: string; task?: string; triggeredAt: number; completedAt?: number };

function runRow(seed: RunSeed) {
  return {
    environment_id: TENANT.env,
    organization_id: TENANT.org,
    project_id: TENANT.project,
    run_id: `internal_${seed.id}`,
    friendly_id: seed.id,
    created_at: seed.triggeredAt,
    updated_at: seed.completedAt ?? seed.triggeredAt,
    completed_at: seed.completedAt ?? null,
    status: "COMPLETED_WITH_ERRORS",
    environment_type: "PRODUCTION",
    attempt: 1,
    engine: "V2",
    task_identifier: seed.task ?? "task-a",
    queue: "q",
    schedule_id: "",
    batch_id: "",
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

async function insertRuns(ch: ClickHouse, seeds: RunSeed[]) {
  const [error] = await ch.writer.insertUnsafe<ReturnType<typeof runRow>>({
    name: "seed-runs",
    table: "trigger_dev.task_runs_v2",
    settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  })(seeds.map(runRow));
  expect(error).toBeNull();
}

function useClickhouse(url: string, prisma: PrismaClient) {
  holder.prisma = prisma as unknown as Record<string | symbol, unknown>;
  const ch = new ClickHouse({ url, name: "query-alert-series" });
  holder.ch = ch;
  return ch;
}

const KIND = { threshold: "threshold", absence: "absence", match: "occurrence" } as const;

function queryAlert(
  query: string,
  mode: "threshold" | "absence" | "match",
  condition?: Condition,
  measure?: string
) {
  const analysis = analyzeQueryForAlert(query, {
    tableSchemas: querySchemas,
    flags: { QUEUE_METRICS: true },
  });
  const signal = toQuerySignal(analysis, { mode, measure });
  if (!signal.ok) throw new Error(signal.message);
  const params: AlertParams = {
    environmentId: TENANT.env,
    scope: { type: "all" },
    querySignal: signal.signal,
  };
  return {
    id: "alert_qs",
    organizationId: TENANT.org,
    projectId: TENANT.project,
    capabilityKey: "custom.query",
    query,
    params,
    condition: (condition ?? { kind: KIND[mode] }) as Condition,
  };
}

function seriesFor(
  alert: ReturnType<typeof queryAlert>,
  window: { since: Date; until: Date },
  maxBuckets?: number
) {
  return getQueryAlertSeries(
    {
      alert,
      capability: resolveAlertCapability(alert),
      condition: alert.condition,
      window,
      maxBuckets,
    },
    createQueryRowRunner(10, { userAuthoredQuery: true })
  );
}

const HOUR_THRESHOLD: Condition = { kind: "threshold", operator: ">", value: 0, windowSec: 3600 };

describe("query alert series", () => {
  it("steps by the alert window and caps at 32 buckets", () => {
    const until = new Date(Date.UTC(2026, 9, 22, 12, 0, 30));
    const threeHours = { since: new Date(until.getTime() - 3 * HOUR), until };
    expect(queryBucketEnds(threeHours, 3600)).toEqual({
      stepMs: HOUR,
      ends: [-2, -1, 0].map((h) => Date.UTC(2026, 9, 22, 12) + h * HOUR),
    });
    const day = { since: new Date(until.getTime() - 24 * HOUR), until };
    expect(queryBucketEnds(day, 60).ends).toHaveLength(32);
    const young = { since: new Date(until.getTime() - 30 * MIN), until };
    expect(queryBucketEnds(young, 3600)).toEqual({
      stepMs: 15 * MIN,
      ends: [-15, 0].map((m) => Date.UTC(2026, 9, 22, 12) + m * MIN),
    });
  });

  it("queries with the evaluator's range, so a long chart window picks no coarser rollup", async () => {
    const ranges: Array<{ from: string; to: string }> = [];
    const capture: QueryRowRunner = async (_query, _context, range) => {
      ranges.push(range);
      return [];
    };
    const until = new Date(Date.UTC(2026, 9, 22, 12));
    const alert = queryAlert(
      "SELECT max(max_queued) AS queued FROM concurrency_metrics",
      "threshold",
      {
        kind: "threshold",
        operator: ">",
        value: 0,
        windowSec: 600,
      }
    );
    const resolved = resolveAlertCapability(alert);
    expect(resolved?.unavailable).toBeUndefined();

    await getQueryAlertSeries(
      {
        alert,
        capability: resolved,
        condition: alert.condition,
        window: { since: new Date(until.getTime() - 24 * HOUR), until },
      },
      capture
    );
    await evaluateQueryCapability(
      {
        capabilityKey: alert.capabilityKey,
        params: alert.params,
        condition: alert.condition,
        organizationId: TENANT.org,
        projectId: TENANT.project,
        now: until,
        capability: resolved!.capability,
      },
      capture
    );
    expect(ranges[0]).toEqual(ranges[1]);

    const match = queryAlert(
      "SELECT run_id, completed_at, task_identifier, queue FROM runs",
      "match"
    );
    await getQueryAlertSeries(
      {
        alert: match,
        capability: resolveAlertCapability(match),
        condition: match.condition,
        window: { since: new Date(until.getTime() - 5 * HOUR), until },
        maxBuckets: 5,
      },
      capture
    );
    expect(ranges[2]).toEqual({
      from: new Date(until.getTime() - HOUR).toISOString(),
      to: until.toISOString(),
    });
  });

  it("an unavailable capability yields no series and runs no query", async () => {
    const alert = queryAlert("SELECT count() AS failures FROM runs", "threshold", {
      kind: "absence",
      quietWindowSec: 3600,
    });
    const resolved = resolveAlertCapability(alert);
    expect(resolved?.unavailable).toBeDefined();
    const series = await getQueryAlertSeries(
      {
        alert,
        capability: resolved,
        condition: alert.condition,
        window: { since: new Date(Date.now() - 3 * HOUR), until: new Date() },
      },
      async () => {
        throw new Error("no query expected");
      }
    );
    expect(series.size).toBe(0);
  });

  containerTestWithClickhouse(
    "a scalar threshold plots the evaluator's windowed value at each bucket end",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Math.floor(Date.now() / MIN) * MIN;
      const at = (minutesAgo: number, n: number, prefix: string) =>
        Array.from({ length: n }, (_, i) => ({
          id: `${prefix}_${i}`,
          triggeredAt: now - minutesAgo * MIN,
        }));
      await insertRuns(ch, [
        ...at(150, 2, "a"),
        ...at(90, 3, "b"),
        ...at(30, 4, "c"),
        ...at(10, 1, "d"),
      ]);
      const alert = queryAlert("SELECT count() AS failures FROM runs", "threshold", HOUR_THRESHOLD);

      const series = await seriesFor(alert, {
        since: new Date(now - 3 * HOUR),
        until: new Date(now),
      });

      const points = series.get("__agg__")!;
      expect(points).toEqual([
        { bucket: now - 2 * HOUR, value: 2 },
        { bucket: now - HOUR, value: 3 },
        { bucket: now, value: 5 },
      ]);
      const resolved = resolveAlertCapability(alert)!;
      for (const point of points) {
        const result = await evaluateQueryCapability(
          {
            capabilityKey: alert.capabilityKey,
            params: alert.params,
            condition: alert.condition,
            organizationId: TENANT.org,
            projectId: TENANT.project,
            now: new Date(point.bucket),
            capability: resolved.capability,
          },
          createQueryRowRunner(10)
        );
        expect(result.facts.value).toBe(point.value);
      }

      const named = await seriesFor(
        queryAlert("SELECT count() AS __bucket FROM runs", "threshold", HOUR_THRESHOLD),
        { since: new Date(now - 3 * HOUR), until: new Date(now) }
      );
      expect(named.get("__agg__")).toEqual(points);
    }
  );

  containerTestWithClickhouse(
    "a grouped count fills empty buckets with 0, a grouped average leaves gaps",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Math.floor(Date.now() / MIN) * MIN;
      const late = ["d", "e", "f", "g", "h", "i"].map((t) => ({
        id: `run_${t}`,
        task: `task-${t}`,
        triggeredAt: now - 30 * MIN,
      }));
      await insertRuns(ch, [
        { id: "run_a1", task: "task-a", triggeredAt: now - 150 * MIN },
        { id: "run_a2", task: "task-a", triggeredAt: now - 140 * MIN },
        { id: "run_b", task: "task-b", triggeredAt: now - 90 * MIN },
        { id: "run_c", task: "task-c", triggeredAt: now - 10 * MIN },
        ...late,
      ]);
      const alert = queryAlert(
        "SELECT count() AS runs, task_identifier FROM runs GROUP BY task_identifier",
        "threshold",
        HOUR_THRESHOLD
      );

      const series = await seriesFor(alert, {
        since: new Date(now - 3 * HOUR),
        until: new Date(now),
      });

      const values = (key: string) => series.get(key)?.map((p) => p.value);
      expect([...series.keys()].sort()).toEqual(
        ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((t) => `task-${t}`)
      );
      expect(values("task-a")).toEqual([2, 0, 0]);
      expect(values("task-b")).toEqual([0, 1, 0]);
      expect(values("task-c")).toEqual([0, 0, 1]);
      expect(values("task-i")).toEqual([0, 0, 1]);
      expect(series.get("task-a")![0]).toEqual({ bucket: now - 2 * HOUR, value: 2, key: "task-a" });

      const averages = await seriesFor(
        queryAlert(
          "SELECT avg(attempt_count) AS attempts, task_identifier FROM runs GROUP BY task_identifier",
          "threshold",
          HOUR_THRESHOLD
        ),
        { since: new Date(now - 3 * HOUR), until: new Date(now) }
      );
      expect(averages.get("task-a")?.map((p) => p.value)).toEqual([1, null, null]);
      expect(averages.get("task-c")?.map((p) => p.value)).toEqual([null, null, 1]);

      const having = await seriesFor(
        queryAlert(
          "SELECT count() AS runs, task_identifier FROM runs GROUP BY task_identifier HAVING runs > 1",
          "threshold",
          HOUR_THRESHOLD
        ),
        { since: new Date(now - 3 * HOUR), until: new Date(now) }
      );
      expect(having.get("task-a")?.map((p) => p.value)).toEqual([2, null, null]);

      const derived = await seriesFor(
        queryAlert(
          "SELECT count() AS runs, runs * 2 AS doubled, task_identifier FROM runs GROUP BY task_identifier",
          "threshold",
          HOUR_THRESHOLD,
          "doubled"
        ),
        { since: new Date(now - 3 * HOUR), until: new Date(now) }
      );
      expect(derived.get("task-a")?.map((p) => p.value)).toEqual([4, null, null]);
    }
  );

  containerTestWithClickhouse(
    "a match series counts the new rows in each bucket",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Math.floor(Date.now() / MIN) * MIN;
      const failed = (id: string, minutesAgo: number) => ({
        id,
        triggeredAt: now - (minutesAgo + 1) * MIN,
        completedAt: now - minutesAgo * MIN,
      });
      await insertRuns(ch, [
        failed("run_1", 170),
        failed("run_2", 150),
        failed("run_3", 130),
        failed("run_4", 30),
      ]);
      const alert = queryAlert(
        "SELECT run_id, completed_at, task_identifier, queue FROM runs",
        "match"
      );

      const series = await seriesFor(
        alert,
        { since: new Date(now - 5 * HOUR), until: new Date(now) },
        5
      );

      expect(series.get("__agg__")).toEqual(
        [0, 0, 3, 0, 1].map((value, i) => ({ bucket: now - (5 - i) * HOUR, value }))
      );
    }
  );
});
