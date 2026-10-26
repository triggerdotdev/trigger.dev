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
  claimAlertsForEvaluation,
  createAlert,
  listAlertEvents,
  type Alert,
} from "~/v3/services/alerts/storage/alertStore.server";
import { evaluateAlert } from "~/v3/services/alerts/engine/evaluateAlert.server";
import {
  createProductionEvaluateBinding,
  createQueryRowRunner,
} from "~/v3/services/alerts/engine/productionEvaluateBinding.server";
import {
  clickhouseDateTimeLiteral,
  DEFAULT_QUERY_EVALUATOR_CONFIG,
  evaluateQueryCapability,
} from "~/v3/services/alerts/evaluators/queryEvaluator.server";

const TENANT = { org: "org_qa", project: "proj_qa", env: "env_qa" };
const MIN = 60_000;
const HOUR = 60 * MIN;

type RunSeed = {
  id: string;
  task?: string;
  queue?: string;
  status?: string;
  triggeredAt: number;
  completedAt?: number | null;
};

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
    status: seed.status ?? "COMPLETED_WITH_ERRORS",
    environment_type: "PRODUCTION",
    attempt: 1,
    engine: "V2",
    task_identifier: seed.task ?? "task-a",
    queue: seed.queue ?? "q",
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

function chDate(ms: number) {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

async function insertRuns(ch: ClickHouse, seeds: RunSeed[]) {
  const [error] = await ch.writer.insertUnsafe<ReturnType<typeof runRow>>({
    name: "seed-runs",
    table: "trigger_dev.task_runs_v2",
    settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  })(seeds.map(runRow));
  expect(error).toBeNull();
}

async function insertLlmMetrics(ch: ClickHouse, rows: Array<{ runId: string; startedAt: number }>) {
  const [error] = await ch.writer.insertUnsafe<Record<string, unknown>>({
    name: "seed-llm-metrics",
    table: "trigger_dev.llm_metrics_v1",
    settings: { async_insert: 0 },
  })(
    rows.map((r, i) => ({
      organization_id: TENANT.org,
      project_id: TENANT.project,
      environment_id: TENANT.env,
      run_id: r.runId,
      task_identifier: "task-a",
      span_id: `span_${i}`,
      start_time: chDate(r.startedAt),
    }))
  );
  expect(error).toBeNull();
}

function useClickhouse(url: string, prisma: PrismaClient) {
  holder.prisma = prisma as unknown as Record<string | symbol, unknown>;
  const ch = new ClickHouse({ url, name: "query-alerts" });
  holder.ch = ch;
  return ch;
}

function signalFor(query: string, mode: "threshold" | "absence" | "match", measure?: string) {
  const analysis = analyzeQueryForAlert(query, { tableSchemas: querySchemas, flags: {} });
  const signal = toQuerySignal(analysis, { mode, measure });
  if (!signal.ok) throw new Error(signal.message);
  return signal.signal;
}

const KIND = { threshold: "threshold", absence: "absence", match: "occurrence" } as const;

function queryAlert(params: {
  query: string;
  mode: "threshold" | "absence" | "match";
  measure?: string;
  condition?: Record<string, unknown>;
  signalQuery?: string;
}) {
  return {
    organizationId: TENANT.org,
    projectId: TENANT.project,
    environmentId: TENANT.env,
    capabilityKey: "custom.query",
    query: params.query,
    params: {
      environmentId: TENANT.env,
      scope: { type: "all" },
      querySignal: signalFor(params.signalQuery ?? params.query, params.mode, params.measure),
    },
    condition: params.condition ?? { kind: KIND[params.mode] },
  };
}

async function createQueryAlert(
  prisma: PrismaClient,
  params: Parameters<typeof queryAlert>[0] & {
    createdAt?: Date;
    evaluatorState?: Record<string, unknown>;
  }
) {
  return createAlert(prisma, {
    ...queryAlert(params),
    createdBy: "user_qa",
    notifiers: [{ type: "channel", channelId: "chan_1" }],
    nextEvaluationAt: new Date(Date.now() - 1_000),
    createdAt: params.createdAt,
    evaluatorState: params.evaluatorState,
  });
}

async function evaluateDue(prisma: PrismaClient, at: Date, bindingNow = at, rowsCap?: number) {
  const [claimed] = await claimAlertsForEvaluation(prisma, { now: at, leaseMs: 120_000, limit: 1 });
  expect(claimed, "no alert was due").toBeDefined();
  return evaluateAlert(claimed!, {
    db: prisma,
    evaluateBinding: createProductionEvaluateBinding({
      queryConcurrency: 10,
      now: () => bindingNow,
      queryEvaluatorConfig: rowsCap ? { ...DEFAULT_QUERY_EVALUATOR_CONFIG, rowsCap } : undefined,
    }),
    enqueueDelivery: async () => {},
  });
}

async function evaluateThreshold(alert: ReturnType<typeof queryAlert>, now = new Date()) {
  const resolved = resolveAlertCapability(alert);
  if (!resolved || resolved.unavailable) throw new Error(resolved?.unavailable?.reason);
  return evaluateQueryCapability(
    {
      capabilityKey: alert.capabilityKey,
      params: alert.params as never,
      condition: alert.condition as never,
      organizationId: TENANT.org,
      projectId: TENANT.project,
      now,
      capability: resolved.capability,
    },
    createQueryRowRunner(10)
  );
}

const RUNS_MATCH = "SELECT run_id, completed_at, task_identifier, queue FROM runs";

describe("query alerts: threshold", () => {
  containerTestWithClickhouse(
    "a JOIN counts only rows inside the window of every source",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      await insertRuns(ch, [
        { id: "run_in", triggeredAt: now - 5 * MIN },
        { id: "run_llm_old", triggeredAt: now - 5 * MIN },
        { id: "run_old", triggeredAt: now - 3 * HOUR },
      ]);
      await insertLlmMetrics(ch, [
        { runId: "run_in", startedAt: now - 5 * MIN },
        { runId: "run_llm_old", startedAt: now - 3 * HOUR },
        { runId: "run_old", startedAt: now - 5 * MIN },
      ]);

      const result = await evaluateThreshold(
        queryAlert({
          query: "SELECT count() AS calls FROM runs r JOIN llm_metrics l ON r.run_id = l.run_id",
          mode: "threshold",
          condition: { kind: "threshold", operator: ">", value: 0, windowSec: 3600 },
        }),
        new Date(now)
      );

      expect(result.kind).toBe("stateful");
      expect(result.facts.value).toBe(1);
    }
  );

  containerTestWithClickhouse(
    "grouped thresholds key by the signal's group columns and keep the top 10 offenders",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      const seeds: RunSeed[] = [];
      for (let g = 0; g < 12; g++) {
        for (let i = 0; i <= g; i++) {
          seeds.push({
            id: `run_${g}_${i}`,
            task: `task-${Math.floor(g / 2)}`,
            queue: g % 2 ? "qb" : "qa",
            triggeredAt: now - 5 * MIN,
          });
        }
      }
      await insertRuns(ch, seeds);

      const result = await evaluateThreshold(
        queryAlert({
          query:
            "SELECT count() AS failures, task_identifier, queue FROM runs GROUP BY task_identifier, queue",
          mode: "threshold",
          condition: { kind: "threshold", operator: ">", value: 0, windowSec: 3600 },
        }),
        new Date(now)
      );

      expect(result.outcome).toBe("met");
      const offenders = result.facts.offenders as Array<{ key: string; value: number }>;
      expect(offenders).toHaveLength(10);
      expect(result.facts.offenderCount).toBe(12);
      expect(result.facts.value).toBe(12);
      expect(offenders.slice(0, 3)).toEqual([
        expect.objectContaining({ key: "task-5, qb", value: 12 }),
        expect.objectContaining({ key: "task-5, qa", value: 11 }),
        expect.objectContaining({ key: "task-4, qb", value: 10 }),
      ]);
    }
  );

  containerTestWithClickhouse(
    "more than 500 groups is unavailable",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      await insertRuns(
        ch,
        Array.from({ length: 501 }, (_, i) => ({
          id: `run_${i}`,
          task: `task-${i}`,
          triggeredAt: now - 5 * MIN,
        }))
      );

      const result = await evaluateThreshold(
        queryAlert({
          query: "SELECT task_identifier, count() AS runs FROM runs GROUP BY task_identifier",
          mode: "threshold",
          condition: { kind: "threshold", operator: ">", value: 0, windowSec: 3600 },
        }),
        new Date(now)
      );

      expect(result.outcome).toBe("unavailable");
      expect(result.facts.unavailableCode).toBe("too_many_groups");
      expect(result.facts.unavailableReason).toContain("more than 500 groups");
    }
  );

  it("a runs JOIN errors alert runs at the strictest floor", () => {
    const resolved = resolveAlertCapability(
      queryAlert({
        query:
          "SELECT count() AS failures FROM runs JOIN errors ON runs.task_identifier = errors.task_identifier",
        mode: "threshold",
        condition: { kind: "threshold", operator: ">", value: 0, windowSec: 3600 },
      })
    );
    expect(resolved?.unavailable).toBeUndefined();
    expect(resolved?.capability.minCadenceSec).toBe(600);
    expect(resolved?.capability.binding.minCadenceSec).toBe(600);
  });

  containerTestWithClickhouse(
    "a measure that is no longer in the query makes the alert unavailable",
    async ({ clickhouseContainer, prisma }) => {
      useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      await createQueryAlert(prisma, {
        query: "SELECT count() AS total FROM runs",
        signalQuery: "SELECT count() AS failures FROM runs",
        mode: "threshold",
        measure: "failures",
        condition: { kind: "threshold", operator: ">", value: 0, windowSec: 3600 },
      });

      const outcome = await evaluateDue(prisma, new Date());

      expect(outcome.applied).toBe(true);
      expect(outcome.unavailableCode).toBe("query_invalid:measure_missing");
      expect(outcome.unavailableReason).toBe(
        'The query no longer returns the "failures" column this alert watches.'
      );
      expect(outcome.events).toEqual([]);
    }
  );
});

describe("query alerts: match", () => {
  for (const suffix of [";", " -- note", "\n;\n-- note"]) {
    containerTestWithClickhouse(
      `a match query ending in ${JSON.stringify(suffix)} still evaluates`,
      async ({ clickhouseContainer, prisma }) => {
        const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
        const now = Date.now();
        await createQueryAlert(prisma, {
          query: `${RUNS_MATCH}${suffix}`,
          mode: "match",
          createdAt: new Date(now - 10 * MIN),
        });
        await insertRuns(ch, [
          { id: "run_done", triggeredAt: now - 5 * MIN, completedAt: now - MIN },
        ]);

        const outcome = await evaluateDue(prisma, new Date(now));

        expect(outcome.unavailableReason).toBeUndefined();
        expect(outcome.events).toEqual(["raised"]);
      }
    );
  }

  containerTestWithClickhouse(
    "a capped match with quoted aliases continues past its cursor",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      const alert = await createQueryAlert(prisma, {
        query: "SELECT run_id AS `row-id`, completed_at AS `event-time` FROM runs",
        mode: "match",
        createdAt: new Date(now - 30 * MIN),
      });
      await insertRuns(ch, [
        { id: "run_a", triggeredAt: now - 20 * MIN, completedAt: now - 15 * MIN },
        { id: "run_b", triggeredAt: now - 20 * MIN, completedAt: now - 14 * MIN },
      ]);

      const first = await evaluateDue(prisma, new Date(now), new Date(now), 1);
      expect(first.events).toEqual(["raised"]);
      const capped = await prisma.alert.findFirst({ where: { id: alert.id } });
      expect(capped?.evaluatorState).toHaveProperty("cursor");

      const later = new Date(now + 15 * MIN);
      const second = await evaluateDue(prisma, new Date(now + 2 * HOUR), later, 1);

      expect(second.unavailableReason).toBeUndefined();
      const drained = await prisma.alert.findFirst({ where: { id: alert.id } });
      expect(drained?.evaluatorState).not.toHaveProperty("cursor");
    }
  );

  containerTestWithClickhouse(
    "an unavailable evaluation keeps the match checkpoint",
    async ({ clickhouseContainer, prisma }) => {
      useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const state = {
        checkpoint: new Date(Date.now() - 5 * MIN).toISOString(),
        activatedFloor: new Date(Date.now() - HOUR).toISOString(),
      };
      const alert = await createQueryAlert(prisma, {
        query: "SELECT count() AS runs FROM runs",
        signalQuery: RUNS_MATCH,
        mode: "match",
        evaluatorState: state,
      });

      const outcome = await evaluateDue(prisma, new Date());

      expect(outcome.unavailableCode).toMatch(/^query_invalid:/);
      const stored = await prisma.alert.findFirst({ where: { id: alert.id } });
      expect(stored?.evaluatorState).toMatchObject(state);
    }
  );

  containerTestWithClickhouse(
    "a run triggered hours ago that fails now raises",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      const alert = await createQueryAlert(prisma, {
        query: RUNS_MATCH,
        mode: "match",
        createdAt: new Date(now - 10 * MIN),
      });
      await insertRuns(ch, [
        { id: "run_late_failure", triggeredAt: now - 3 * HOUR, completedAt: now - MIN },
        { id: "run_in_progress", triggeredAt: now - 3 * MIN, completedAt: null },
      ]);

      const outcome = await evaluateDue(prisma, new Date(now));

      expect(outcome.events).toEqual(["raised"]);
      const [event] = await listAlertEvents(prisma, alert.id);
      const batch = event!.facts.batch as { rows: Array<{ id: string }>; total: number };
      expect(batch.rows.map((r) => r.id)).toEqual(["run_late_failure"]);
      expect(batch.total).toBe(1);
    }
  );

  containerTestWithClickhouse(
    "a late-replicated row inside the lookback is caught",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      const alert = await createQueryAlert(prisma, {
        query: RUNS_MATCH,
        mode: "match",
        createdAt: new Date(now - 2 * HOUR),
      });

      const first = await evaluateDue(prisma, new Date(now));
      expect(first.events).toEqual([]);

      await insertRuns(ch, [
        { id: "run_replicated_late", triggeredAt: now - HOUR, completedAt: now - 30 * MIN },
      ]);
      const later = new Date(now + 15 * MIN);
      const second = await evaluateDue(prisma, new Date(now + 2 * HOUR), later);

      expect(second.events).toEqual(["raised"]);
      const [event] = await listAlertEvents(prisma, alert.id);
      expect(event!.facts.run_id).toBe("run_replicated_late");
    }
  );

  containerTestWithClickhouse(
    "a batch of 15 unseen rows raises one event with 10 rows, then a second batch stays quiet",
    async ({ clickhouseContainer, prisma }) => {
      const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      const alert = await createQueryAlert(prisma, {
        query: RUNS_MATCH,
        mode: "match",
        createdAt: new Date(now - 30 * MIN),
      });
      await insertRuns(
        ch,
        Array.from({ length: 15 }, (_, i) => ({
          id: `run_${String(i).padStart(2, "0")}`,
          triggeredAt: now - 20 * MIN,
          completedAt: now - 15 * MIN + i * 1000,
        }))
      );

      const first = await evaluateDue(prisma, new Date(now));

      expect(first.events).toEqual(["raised"]);
      expect(first.deliveryCount).toBe(1);
      const events = await listAlertEvents(prisma, alert.id);
      expect(events).toHaveLength(1);
      const batch = events[0]!.facts.batch as {
        rows: Array<{ id: string; time: string; columns: Record<string, unknown> }>;
        total: number;
        overflow: number;
      };
      expect(batch.total).toBe(15);
      expect(batch.overflow).toBe(5);
      expect(batch.rows.map((r) => r.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `run_${String(i).padStart(2, "0")}`)
      );
      expect(batch.rows[0]!.columns).toEqual({ task_identifier: "task-a", queue: "q" });

      await insertRuns(
        ch,
        Array.from({ length: 3 }, (_, i) => ({
          id: `run_second_${i}`,
          triggeredAt: now - 10 * MIN,
          completedAt: now - 5 * MIN,
        }))
      );
      const later = new Date(now + 15 * MIN);
      const second = await evaluateDue(prisma, new Date(now + 2 * HOUR), later);

      expect(second.applied).toBe(true);
      expect(second.events).toEqual([]);
      expect(await listAlertEvents(prisma, alert.id)).toHaveLength(1);
    }
  );
});

async function evaluateAbsenceAt(alert: Alert, at: Date) {
  const resolved = resolveAlertCapability(alert);
  if (!resolved || resolved.unavailable) throw new Error(resolved?.unavailable?.reason);
  const binding = createProductionEvaluateBinding({ queryConcurrency: 10, now: () => at });
  return (await binding(alert, resolved.capability)).result;
}

type AbsenceCreate = (
  prisma: PrismaClient,
  createdAt: Date,
  evaluatorState?: Record<string, unknown>
) => Promise<Alert>;

const ABSENCE_KINDS: Array<{ name: string; windowSec: number; create: AbsenceCreate }> = [
  {
    name: "custom.query",
    windowSec: 600,
    create: (prisma, createdAt, evaluatorState) =>
      createQueryAlert(prisma, {
        query: "SELECT count() AS total FROM runs",
        mode: "absence",
        measure: "total",
        condition: { kind: "absence", quietWindowSec: 600 },
        createdAt,
        evaluatorState,
      }),
  },
  {
    name: "runs.created",
    windowSec: 1800,
    create: (prisma, createdAt, evaluatorState) =>
      createAlert(prisma, {
        organizationId: TENANT.org,
        projectId: TENANT.project,
        environmentId: TENANT.env,
        capabilityKey: "runs.created",
        params: { environmentId: TENANT.env, scope: { type: "all" } },
        condition: { kind: "absence", quietWindowSec: 1800 },
        createdBy: "user_qa",
        notifiers: [{ type: "channel", channelId: "chan_1" }],
        nextEvaluationAt: new Date(Date.now() - 1_000),
        createdAt,
        evaluatorState,
      }),
  },
];

describe("absence alerts observe one full window before raising", () => {
  for (const { name, windowSec, create } of ABSENCE_KINDS) {
    containerTestWithClickhouse(
      `${name}: no rows stays not_met until a full window has passed, then raises`,
      async ({ clickhouseContainer, prisma }) => {
        useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
        const createdAt = new Date();
        const alert = await create(prisma, createdAt);
        const graceEnd = new Date(createdAt.getTime() + windowSec * 1000);

        const first = await evaluateAbsenceAt(alert, createdAt);
        expect(first.kind === "stateful" && first.outcome).toBe("not_met");
        expect(first.facts.value).toBe(0);
        expect(first.facts.graceUntil).toBe(graceEnd.toISOString());

        const quiet = await evaluateDue(prisma, createdAt);
        expect(quiet.events).toEqual([]);

        const raised = await evaluateDue(prisma, new Date(graceEnd.getTime() + 2 * HOUR), graceEnd);
        expect(raised.events).toEqual(["raised"]);
      }
    );

    containerTestWithClickhouse(
      `${name}: rows inside the grace keep it not_met after the grace ends`,
      async ({ clickhouseContainer, prisma }) => {
        const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
        const now = Date.now();
        const createdAt = new Date(now - 5 * MIN);
        const alert = await create(prisma, createdAt);
        await insertRuns(ch, [{ id: "run_in_grace", triggeredAt: now - 3 * MIN }]);

        const first = await evaluateDue(prisma, new Date(now));
        expect(first.events).toEqual([]);
        expect(first.alert?.observedCondition).toBe("not_met");

        const after = new Date(createdAt.getTime() + windowSec * 1000);
        const result = await evaluateAbsenceAt(alert, after);
        expect(result.kind === "stateful" && result.outcome).toBe("not_met");
        expect(result.facts.value).toBe(1);
        expect(result.facts.graceUntil).toBeUndefined();
        const second = await evaluateDue(prisma, new Date(now + 2 * HOUR), after);
        expect(second.events).toEqual([]);
      }
    );
  }

  containerTestWithClickhouse(
    "a reactivated absence alert observes a full window from reactivation",
    async ({ clickhouseContainer, prisma }) => {
      useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
      const now = Date.now();
      const activatedAt = new Date(now - MIN);
      await ABSENCE_KINDS[0]!.create(prisma, new Date(now - 2 * HOUR), {
        checkpoint: activatedAt.toISOString(),
        activatedFloor: activatedAt.toISOString(),
      });

      const first = await evaluateDue(prisma, new Date(now));
      expect(first.events).toEqual([]);
      expect(first.alert?.evaluatorState).toMatchObject({
        activatedFloor: activatedAt.toISOString(),
      });

      const second = await evaluateAbsenceAt(first.alert!, new Date(now + 5 * MIN));
      expect(second.facts.graceUntil).toBe(new Date(activatedAt.getTime() + 600_000).toISOString());
    }
  );
});

// Maps completed_at through replication-shaped rows and TRQL only. That each engine terminal
// path sets completedAt is checked by reading the run engine, not executed here.
describe("runs.completed_at column mapping per terminal status", () => {
  const TERMINAL_PATHS = [
    { path: "success", status: "COMPLETED_SUCCESSFULLY" },
    { path: "failure", status: "COMPLETED_WITH_ERRORS" },
    { path: "cancel", status: "CANCELED" },
    { path: "expire", status: "EXPIRED" },
    { path: "dequeue failure", status: "SYSTEM_FAILURE" },
  ];

  for (const { path, status } of TERMINAL_PATHS) {
    containerTestWithClickhouse(
      `${path}: a replicated completed_at maps through TRQL and matches`,
      async ({ clickhouseContainer, prisma }) => {
        const ch = useClickhouse(clickhouseContainer.getConnectionUrl(), prisma);
        const now = Date.now();
        await insertRuns(ch, [
          { id: `run_${status}`, status, triggeredAt: now - 2 * HOUR, completedAt: now - MIN },
        ]);
        const alert = queryAlert({ query: RUNS_MATCH, mode: "match" });
        const resolved = resolveAlertCapability(alert);
        const since = new Date(now - 10 * MIN);
        const until = new Date(now + MIN);

        const result = await evaluateQueryCapability(
          {
            capabilityKey: alert.capabilityKey,
            params: alert.params as never,
            condition: alert.condition as never,
            organizationId: TENANT.org,
            projectId: TENANT.project,
            now: new Date(now),
            capability: resolved!.capability,
            matchWindow: { from: since, to: until },
            ctx: {
              checkpoint: clickhouseDateTimeLiteral(since),
              until: clickhouseDateTimeLiteral(until),
              after: "1 = 1",
            },
          },
          createQueryRowRunner(10)
        );

        if (result.kind !== "occurrence") throw new Error("expected occurrences");
        expect(result.occurrences.map((o) => o.facts.run_id)).toEqual([`run_${status}`]);
        expect(result.occurrences[0]!.facts.completed_at).not.toBeNull();
      }
    );
  }
});
