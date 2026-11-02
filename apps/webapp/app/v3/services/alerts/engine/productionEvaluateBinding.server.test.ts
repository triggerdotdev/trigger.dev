import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import {
  activateAlert,
  createAlert,
  stopAlert,
  claimAlertsForEvaluation,
  listActiveSeenOccurrenceKeys,
  listAlertEvents,
  listPendingDeliveriesForEvent,
  type Alert,
} from "../storage/alertStore.server";
import type { PrismaClient } from "@trigger.dev/database";
import { rawSqlClient, startAlertsPostgres } from "../../../../../test/helpers/alertTables";
import { getCapability } from "@internal/alert-contracts";
import { evaluateAlert } from "./evaluateAlert.server";
import { createProductionEvaluateBinding } from "./productionEvaluateBinding.server";
import {
  DEFAULT_QUERY_EVALUATOR_CONFIG,
  type QueryRowRunner,
} from "../evaluators/queryEvaluator.server";

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;
let rawSql: ReturnType<typeof rawSqlClient>;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
  rawSql = rawSqlClient(db);
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

const BASE = {
  organizationId: "org_pd",
  projectId: "proj_pd",
  environmentId: "env_pd",
  createdBy: "user_pd",
  notifiers: [
    { type: "channel", channelId: "chan_1" },
    { type: "channel", channelId: "chan_2" },
  ],
};

async function claimOne(now: Date) {
  const claimed = await claimAlertsForEvaluation(db, {
    now,
    leaseMs: 120_000,
    limit: 1,
  });
  return claimed[0]!;
}

async function resetAlerts() {
  await rawSql`DELETE FROM "AlertDelivery"`;
  await rawSql`DELETE FROM "AlertEvent"`;
  await rawSql`DELETE FROM "Alert"`;
}

beforeEach(async () => {
  await resetAlerts();
});

describe("createProductionEvaluateBinding", () => {
  it("query-bound threshold alert: raises + writes deliveries", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: "env_pd", scope: { type: "queue", queue: "q1" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
    });
    const now = new Date();
    const claimed = await claimOne(now);

    let capturedScope: string | undefined;
    const fakeRunner: QueryRowRunner = async (query) => {
      capturedScope = query;
      return [{ q1: "q1", value: 200 }];
    };

    const binding = createProductionEvaluateBinding({
      queryRowRunner: fakeRunner,
    });

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toContain("raised");
    expect(outcome.deliveryCount).toBe(2);
    expect(capturedScope).toContain("q1");

    const events = await listAlertEvents(db, claimed.id);
    expect(events).toHaveLength(1);
    const deliveries = await listPendingDeliveriesForEvent(db, events[0]!.id, events[0]!.at);
    expect(deliveries).toHaveLength(2);
  });

  it("composite health.all: met when any sub-capability is met (2-consecutive hysteresis)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded" },
    });

    const fakeRunner: QueryRowRunner = async (query) => {
      if (query.includes("concurrency_metrics")) return [{ value: 1 }];
      return [{ value: 0 }];
    };

    const binding = createProductionEvaluateBinding({
      queryRowRunner: fakeRunner,
    });

    const now1 = new Date();
    const claimed1 = await claimOne(now1);
    const r1 = await evaluateAlert(claimed1, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(r1.applied).toBe(true);
    expect(r1.events).toHaveLength(0);

    const now2 = new Date(now1.getTime() + 301_000);
    const claimed2 = await claimOne(now2);
    const r2 = await evaluateAlert(claimed2, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(r2.applied).toBe(true);
    expect(r2.events).toContain("raised");
  });

  it("composite health.all: not_met when all sub-capabilities are not_met", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded" },
    });
    const now = new Date();
    const claimed = await claimOne(now);

    const fakeRunner: QueryRowRunner = async () => {
      return [{ value: 0 }];
    };

    const binding = createProductionEvaluateBinding({
      queryRowRunner: fakeRunner,
    });

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).not.toContain("raised");
  });

  it("composite health.all: a failed component holds a raised alert instead of recovering (mutation: failures treated as no data)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded" },
      attention: "needs_attention",
      observedCondition: "met",
      evaluatorState: { compositeHysteresis: { consecutiveMet: 0, consecutiveNotMet: 1 } },
    });
    const claimed = await claimOne(new Date());

    const fakeRunner: QueryRowRunner = async (query) => {
      if (query.includes("concurrency_metrics")) throw new Error("clickhouse down");
      return [{ value: 0 }];
    };
    const binding = createProductionEvaluateBinding({ queryRowRunner: fakeRunner });

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).not.toContain("recovered");
    expect(outcome.unavailableReason).toBe("sub_query_failed");
  });

  async function compositeWithFailedFlow(
    condition: Record<string, unknown>,
    executionMet: boolean
  ) {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded", ...condition },
    });
    const claimed = await claimOne(new Date());
    const binding = createProductionEvaluateBinding({
      queryRowRunner: async (query) => {
        if (query.includes("concurrency_metrics")) throw new Error("clickhouse down");
        if (query.includes("is_finished = 1")) return [{ value: executionMet ? 1 : 0 }];
        return [{ value: 1 }];
      },
    });
    const { result } = await binding(claimed, getCapability("health.all")!);
    if (result.kind !== "stateful") throw new Error("expected stateful result");
    return result;
  }

  it("composite any: a met component stays met while another fails (mutation: failure wins over met)", async () => {
    const result = await compositeWithFailedFlow({}, true);
    expect(result.outcome).toBe("met");
    expect(result.facts.failedComponents).toEqual(["flow"]);
  });

  it("composite all: a failed component holds unless an available one is not met (mutation: failures ignored)", async () => {
    const held = await compositeWithFailedFlow({ compositeMode: "all" }, true);
    expect(held.outcome).toBe("unavailable");
    expect(held.facts.unavailableReason).toBe("sub_query_failed");

    await resetAlerts();
    const notMet = await compositeWithFailedFlow({ compositeMode: "all" }, false);
    expect(notMet.outcome).toBe("not_met");
  });

  it("composite health.all: every component failing keeps a raised alert unrecovered", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded" },
      attention: "needs_attention",
      observedCondition: "met",
      evaluatorState: { compositeHysteresis: { consecutiveMet: 0, consecutiveNotMet: 1 } },
    });
    const claimed = await claimOne(new Date());
    const binding = createProductionEvaluateBinding({
      queryRowRunner: async () => {
        throw new Error("clickhouse down");
      },
    });

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(outcome.events).not.toContain("recovered");
    expect(outcome.unavailableReason).toBe("sub_query_failed");
  });

  it("health.flow: met with GROUP BY queue when one queue trips", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.flow",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded" },
    });
    const now = new Date();
    const claimed = await claimOne(now);

    const fakeRunner: QueryRowRunner = async (query) => {
      expect(query).toContain("GROUP BY queue");
      return [{ value: 0 }, { value: 1 }];
    };

    const binding = createProductionEvaluateBinding({
      queryRowRunner: fakeRunner,
    });

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toContain("raised");
  });

  it("health.execution: applies custom failureRatePct param", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.execution",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded", params: { failureRatePct: 25 } },
    });
    const now = new Date();
    const claimed = await claimOne(now);

    let capturedQuery = "";
    const fakeRunner: QueryRowRunner = async (query) => {
      capturedQuery = query;
      return [{ value: 0 }];
    };

    const binding = createProductionEvaluateBinding({
      queryRowRunner: fakeRunner,
    });

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: binding,
      enqueueDelivery: async () => {},
    });

    expect(capturedQuery).toContain("> 25");
    expect(capturedQuery).not.toContain("{{p.");
  });

  it("a persisted health.all condition without components runs only the legacy three (mutation: default to compositeOf)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded" },
    });
    const now = new Date();
    const claimed = await claimOne(now);

    const queries: string[] = [];
    const fakeRunner: QueryRowRunner = async (query) => {
      queries.push(query);
      return [{ value: 0 }];
    };

    const binding = createProductionEvaluateBinding({ queryRowRunner: fakeRunner });
    const { result } = await binding(claimed, getCapability("health.all")!);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("FROM concurrency_metrics");
    expect(queries[1]).toContain("is_finished = 1");
    expect(queries[2]).toContain("max(triggered_at)");
    expect(result.kind === "stateful" && result.outcome).toBe("not_met");
    expect(Object.keys((result.facts as { components: object }).components)).toEqual([
      "flow",
      "execution",
      "liveness",
    ]);
  });

  it("out-of-range params make the alert unavailable without querying (mutation: skip validation)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded", params: { failureRatePct: 101 } },
    });
    const claimed = await claimOne(new Date());

    let runnerCalls = 0;
    const binding = createProductionEvaluateBinding({
      queryRowRunner: async () => {
        runnerCalls++;
        return [{ value: 1 }];
      },
    });
    const { result } = await binding(claimed, getCapability("health.all")!);

    expect(runnerCalls).toBe(0);
    expect(result.kind === "stateful" && result.outcome).toBe("unavailable");
    expect(result.facts.unavailableReason).toContain("failureRatePct");
  });

  it("a negative single-capability param never compiles into a query", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.execution",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded", params: { failureRatePct: -1 } },
    });
    const claimed = await claimOne(new Date());

    const queries: string[] = [];
    const binding = createProductionEvaluateBinding({
      queryRowRunner: async (query) => {
        queries.push(query);
        return [{ value: 1 }];
      },
    });
    const { result } = await binding(claimed, getCapability("health.execution")!);

    expect(queries).toEqual([]);
    expect(result.facts.unavailableReason).toContain("below min");
  });

  function pagedRunner(rows: Record<string, unknown>[], timeColumn: string): QueryRowRunner {
    const tuple = (r: Record<string, unknown>) =>
      [r[timeColumn], r.task_identifier, r.error_fingerprint].map(String);
    const compare = (a: string[], b: string[]) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
      }
      return 0;
    };
    return async (query) => {
      const since = new RegExp(`${timeColumn} >= '([^']+)'`).exec(query)![1]!;
      const until = new RegExp(`${timeColumn} < '([^']+)'`).exec(query)![1]!;
      const limit = Number(/LIMIT (\d+)$/.exec(query)![1]);
      const after = [...query.matchAll(/(\w+) > '([^']*)'/g)].map((m) => m[2]!);
      return rows
        .filter((r) => (r[timeColumn] as string) >= since && (r[timeColumn] as string) < until)
        .filter((r) => after.length === 0 || compare(tuple(r), after) > 0)
        .sort((a, b) => compare(tuple(a), tuple(b)))
        .slice(0, limit);
    };
  }

  async function occurrencesTotal(alertId: string) {
    const [row] = await rawSql<{ occurrences_total: number }[]>`
      SELECT "occurrencesTotal" AS occurrences_total FROM "Alert" WHERE id = ${alertId}`;
    return Number(row!.occurrences_total);
  }

  describe("rows emit checkpoint", () => {
    const CREATED_AT = new Date("2026-10-01T10:00:00.000Z");
    const NOW = new Date("2026-10-01T12:00:00.000Z");
    const ROW = {
      task_identifier: "my-task",
      error_fingerprint: "fp1",
      minute: "2026-10-01 11:01:00",
      occurrences: 2,
    };

    async function createErrorsAlert() {
      return createAlert(db, {
        ...BASE,
        capabilityKey: "errors.occurred_again",
        params: {
          environmentId: "env_pd",
          scope: { type: "errorGroup", taskIdentifier: "my-task", fingerprint: "fp1" },
        },
        condition: { kind: "occurrence" },
        createdAt: CREATED_AT,
      });
    }

    it("compiles a quoted checkpoint, advances it on success, keeps it on failure", async () => {
      const alert = await createErrorsAlert();

      const queries: string[] = [];
      let fail = false;
      const runner: QueryRowRunner = async (query) => {
        queries.push(query);
        if (fail) throw new Error("clickhouse down");
        return [ROW];
      };
      const binding = createProductionEvaluateBinding({ queryRowRunner: runner, now: () => NOW });

      const t1 = new Date();
      const r1 = await evaluateAlert(await claimOne(t1), {
        db,
        evaluateBinding: binding,
        enqueueDelivery: async () => {},
      });
      expect(r1.events).toEqual(["raised"]);
      expect(queries[0]).toContain("minute >= '2026-10-01 10:00:00'");

      const events = await listAlertEvents(db, alert.id);
      expect(events.map((e) => e.sourceEventId)).toEqual([
        "errors.occurred_again:env_pd:my-task:fp1:2026-10-01 11:01:00",
      ]);

      const [afterSuccess] = await rawSql<{ evaluator_state: Record<string, unknown> }[]>`
        SELECT "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${alert.id}`;
      const checkpoint = afterSuccess!.evaluator_state.checkpoint as string;
      expect(new Date(checkpoint).getTime()).toBe(NOW.getTime());

      fail = true;
      const t2 = new Date(t1.getTime() + 301_000);
      const r2 = await evaluateAlert(await claimOne(t2), {
        db,
        evaluateBinding: binding,
        enqueueDelivery: async () => {},
      });
      const [afterFailure] = await rawSql<{ evaluator_state: Record<string, unknown> }[]>`
        SELECT "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${alert.id}`;
      expect(afterFailure!.evaluator_state.checkpoint).toBe(checkpoint);
      expect(r2.bindingFailed).toBe(true);

      fail = false;
      const t3 = new Date(t2.getTime() + 301_000);
      await evaluateAlert(await claimOne(t3), {
        db,
        evaluateBinding: binding,
        enqueueDelivery: async () => {},
      });
      const since = new Date(Math.floor(Date.parse(checkpoint) / 60_000) * 60_000 - 3600_000);
      const literal = `'${since.toISOString().slice(0, 19).replace("T", " ")}'`;
      const forwardLiteral = `'${new Date(Math.floor(Date.parse(checkpoint) / 60_000) * 60_000).toISOString().slice(0, 19).replace("T", " ")}'`;
      expect(queries[2]).toContain(`minute >= ${forwardLiteral}`);
      expect(queries[3]).toContain(`minute >= ${literal} AND minute < ${forwardLiteral}`);

      const eventsAfter = await listAlertEvents(db, alert.id);
      expect(eventsAfter).toHaveLength(1);
    });

    it("scans ascending and advances the checkpoint to the newest row when capped", async () => {
      const alert = await createErrorsAlert();
      const allRows = ["11:01:00", "11:02:00", "11:03:00"].map((m) => ({
        ...ROW,
        minute: `2026-10-01 ${m}`,
      }));
      const queries: string[] = [];
      const runner: QueryRowRunner = async (query) => {
        queries.push(query);
        const since = /minute >= '([^']+)'/.exec(query)![1]!;
        return allRows.filter((r) => r.minute >= since);
      };
      const binding = createProductionEvaluateBinding({
        queryRowRunner: runner,
        now: () => NOW,
        checkpointLookbackSec: 0,
        queryEvaluatorConfig: { ...DEFAULT_QUERY_EVALUATOR_CONFIG, rowsCap: 2 },
      });
      const readCheckpoint = async () => {
        const [row] = await rawSql<{ evaluator_state: Record<string, unknown> }[]>`
          SELECT "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${alert.id}`;
        return row!.evaluator_state.checkpoint as string;
      };
      const keyAt = (m: string) => `errors.occurred_again:env_pd:my-task:fp1:2026-10-01 ${m}`;
      const seenKeys = async () =>
        Array.from(
          await listActiveSeenOccurrenceKeys(db, {
            alertId: alert.id,
            keys: ["11:01:00", "11:02:00", "11:03:00"].map(keyAt),
            now: NOW,
          })
        ).sort();

      const t1 = new Date();
      await evaluateAlert(await claimOne(t1), {
        db,
        evaluateBinding: binding,
        enqueueDelivery: async () => {},
      });
      expect(queries[0]).toMatch(
        /ORDER BY minute ASC, task_identifier ASC, error_fingerprint ASC LIMIT 3$/
      );
      expect(await readCheckpoint()).toBe("2026-10-01T11:02:00.000Z");
      expect((await listAlertEvents(db, alert.id)).map((e) => e.sourceEventId)).toEqual([
        keyAt("11:02:00"),
      ]);
      expect(await seenKeys()).toEqual([keyAt("11:01:00"), keyAt("11:02:00")]);

      await evaluateAlert(await claimOne(new Date(t1.getTime() + 301_000)), {
        db,
        evaluateBinding: binding,
        enqueueDelivery: async () => {},
      });
      expect(await readCheckpoint()).toBe(NOW.toISOString());
      expect(await seenKeys()).toEqual(["11:01:00", "11:02:00", "11:03:00"].map(keyAt));
    });

    it("errors.new pages through more than rowsCap groups first seen in one minute", async () => {
      const alert = await createAlert(db, {
        ...BASE,
        capabilityKey: "errors.new",
        params: { environmentId: "env_pd", scope: { type: "all" } },
        condition: { kind: "occurrence" },
        createdAt: CREATED_AT,
      });
      const fingerprints = Array.from(
        { length: 250 },
        (_, i) => `fp_${String(i).padStart(3, "0")}`
      );
      const rows = fingerprints.map((fp) => ({
        task_identifier: "my-task",
        error_fingerprint: fp,
        group_first_seen: "2026-10-01 11:30:00",
      }));
      const binding = createProductionEvaluateBinding({
        queryRowRunner: pagedRunner(rows, "group_first_seen"),
        now: () => NOW,
        seenRetentionSec: 90 * 86_400,
      });
      const t1 = new Date();
      for (let i = 0; i < 3; i++) {
        await evaluateAlert(await claimOne(new Date(t1.getTime() + i * 301_000)), {
          db,
          evaluateBinding: binding,
          enqueueDelivery: async () => {},
        });
      }

      const keys = fingerprints.map((fp) => `errors.new:env_pd:my-task:${fp}`);
      const seenKeys = await listActiveSeenOccurrenceKeys(db, {
        alertId: alert.id,
        keys,
        now: NOW,
      });
      expect(seenKeys.size).toBe(250);
      expect(await occurrencesTotal(alert.id)).toBe(250);
    });

    it("a reactivated alert ignores rows from while it was stopped", async () => {
      const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00.000Z`);
      const alert = await createAlert(db, {
        ...BASE,
        capabilityKey: "errors.occurred_again",
        params: {
          environmentId: "env_pd",
          scope: { type: "errorGroup", taskIdentifier: "my-task", fingerprint: "fp1" },
        },
        condition: { kind: "occurrence" },
        createdAt: at("09:00"),
      });
      await stopAlert(db, {
        id: alert.id,
        projectId: BASE.projectId,
        environmentId: BASE.environmentId,
        actorId: "user_pd",
        now: at("11:00"),
      });
      await activateAlert(db, {
        id: alert.id,
        projectId: BASE.projectId,
        environmentId: BASE.environmentId,
        now: at("12:00"),
      });

      const rows = [{ ...ROW, minute: "2026-10-01 11:30:00" }];
      let claims = 0;
      const evaluateAt = async (when: Date) => {
        const binding = createProductionEvaluateBinding({
          queryRowRunner: pagedRunner(rows, "minute"),
          now: () => when,
          seenRetentionSec: 90 * 86_400,
        });
        return evaluateAlert(await claimOne(new Date(Date.now() + ++claims * 86_400_000)), {
          db,
          evaluateBinding: binding,
          enqueueDelivery: async () => {},
        });
      };

      for (const when of [at("12:05"), at("12:10")]) {
        expect((await evaluateAt(when)).events).not.toContain("raised");
      }
      expect(await occurrencesTotal(alert.id)).toBe(0);

      rows.push({ ...ROW, minute: "2026-10-01 12:06:00" });
      expect((await evaluateAt(at("12:15"))).events).toContain("raised");
      expect(await occurrencesTotal(alert.id)).toBe(1);
    });

    describe("late-arrival range is scanned separately from the forward range", () => {
      const T = (m: string) => `2026-10-01 ${m}`;
      const keyAt = (m: string) => `errors.occurred_again:env_pd:my-task:fp1:${T(m)}`;
      const RET = 90 * 86_400;
      const OLD = ["11:10:00", "11:11:00", "11:12:00", "11:13:00", "11:14:00", "11:15:00"];
      const CP = new Date("2026-10-01T11:40:00.000Z");

      function rangeRunner(rows: Record<string, unknown>[]): QueryRowRunner {
        return pagedRunner(rows, "minute");
      }

      async function seed(rows: Record<string, unknown>[]) {
        const binding = createProductionEvaluateBinding({
          queryRowRunner: rangeRunner(rows),
          now: () => CP,
          seenRetentionSec: RET,
        });
        const t = new Date();
        await evaluateAlert(await claimOne(t), {
          db,
          evaluateBinding: binding,
          enqueueDelivery: async () => {},
        });
        return t;
      }

      async function readState(alertId: string, field: string) {
        const [row] = await rawSql<{ evaluator_state: Record<string, unknown> }[]>`
          SELECT "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${alertId}`;
        return row!.evaluator_state[field];
      }

      const readCheckpoint = async (alertId: string) =>
        (await readState(alertId, "checkpoint")) as string;

      const seen = (alertId: string, minutes: string[]) =>
        listActiveSeenOccurrenceKeys(db, {
          alertId,
          keys: minutes.map(keyAt),
          now: NOW,
        }).then((set) => Array.from(set).sort());

      it("a new row after the checkpoint is seen even when the lookback holds more than rowsCap seen rows", async () => {
        const alert = await createErrorsAlert();
        const oldRows = OLD.map((m) => ({ ...ROW, minute: T(m) }));
        const t1 = await seed(oldRows);
        expect(await readCheckpoint(alert.id)).toBe(CP.toISOString());

        const binding = createProductionEvaluateBinding({
          queryRowRunner: rangeRunner([...oldRows, { ...ROW, minute: T("11:50:00") }]),
          now: () => NOW,
          seenRetentionSec: RET,
          queryEvaluatorConfig: { ...DEFAULT_QUERY_EVALUATOR_CONFIG, rowsCap: 2 },
        });
        await evaluateAlert(await claimOne(new Date(t1.getTime() + 301_000)), {
          db,
          evaluateBinding: binding,
          enqueueDelivery: async () => {},
        });

        expect(await seen(alert.id, ["11:50:00"])).toEqual([keyAt("11:50:00")]);
        expect(await readCheckpoint(alert.id)).toBe(NOW.toISOString());
      });

      it("a capped forward scan pages through the rest of its minute with a cursor", async () => {
        const alert = await createErrorsAlert();
        const t1 = await seed([{ ...ROW, minute: T("11:10:00") }]);
        expect(await readCheckpoint(alert.id)).toBe(CP.toISOString());

        const sameMinute = ["fp_a", "fp_b", "fp_c"].map((fp) => ({
          ...ROW,
          error_fingerprint: fp,
          minute: T("11:40:00"),
        }));
        const next = { ...ROW, error_fingerprint: "fp_d", minute: T("11:41:00") };
        const binding = createProductionEvaluateBinding({
          queryRowRunner: rangeRunner([...sameMinute, next]),
          now: () => NOW,
          seenRetentionSec: RET,
          checkpointLookbackSec: 0,
          queryEvaluatorConfig: { ...DEFAULT_QUERY_EVALUATOR_CONFIG, rowsCap: 2 },
        });
        const run = async (offset: number) =>
          evaluateAlert(await claimOne(new Date(t1.getTime() + offset)), {
            db,
            evaluateBinding: binding,
            enqueueDelivery: async () => {},
          });

        await run(301_000);
        expect(await readCheckpoint(alert.id)).toBe("2026-10-01T11:40:00.000Z");
        expect(await readState(alert.id, "cursor")).toEqual([
          ["minute", T("11:40:00")],
          ["task_identifier", "my-task"],
          ["error_fingerprint", "fp_b"],
        ]);
        await run(602_000);
        expect(await readCheckpoint(alert.id)).toBe(NOW.toISOString());
        const keys = [
          `errors.occurred_again:env_pd:my-task:fp_c:${T("11:40:00")}`,
          `errors.occurred_again:env_pd:my-task:fp_d:${T("11:41:00")}`,
        ];
        const seenKeys = await listActiveSeenOccurrenceKeys(db, {
          alertId: alert.id,
          keys,
          now: NOW,
        });
        expect(Array.from(seenKeys).sort()).toEqual(keys);
      });

      it("a late arrival behind more than rowsCap seen rows is paged to", async () => {
        const alert = await createErrorsAlert();
        const oldRows = OLD.map((m) => ({ ...ROW, minute: T(m) }));
        const t1 = await seed(oldRows);

        const late = { ...ROW, minute: T("11:20:00") };
        const binding = createProductionEvaluateBinding({
          queryRowRunner: rangeRunner([...oldRows, late]),
          now: () => NOW,
          seenRetentionSec: RET,
          queryEvaluatorConfig: { ...DEFAULT_QUERY_EVALUATOR_CONFIG, rowsCap: 2 },
        });
        for (let i = 1; i <= 4; i++) {
          await evaluateAlert(await claimOne(new Date(t1.getTime() + i * 301_000)), {
            db,
            evaluateBinding: binding,
            enqueueDelivery: async () => {},
          });
        }

        expect(await seen(alert.id, ["11:20:00"])).toEqual([keyAt("11:20:00")]);
        expect(await occurrencesTotal(alert.id)).toBe(OLD.length + 1);
      });

      it("a capped late page keeps its window while the clock and checkpoint advance", async () => {
        const alert = await createErrorsAlert();
        const t1 = await seed([]);
        const lateMinutes = [
          "10:41:00",
          "10:42:00",
          "10:43:00",
          "10:44:00",
          "10:45:00",
          "10:46:00",
        ];
        const rows = lateMinutes.map((m) => ({ ...ROW, minute: T(m) }));
        let now = new Date("2026-10-01T12:05:00.000Z");
        const binding = createProductionEvaluateBinding({
          queryRowRunner: rangeRunner(rows),
          now: () => now,
          seenRetentionSec: RET,
          queryEvaluatorConfig: { ...DEFAULT_QUERY_EVALUATOR_CONFIG, rowsCap: 2 },
        });
        for (let i = 1; i <= 12; i++) {
          if (i === 3) rows.push({ ...ROW, minute: T("12:07:00") });
          await evaluateAlert(await claimOne(new Date(t1.getTime() + i * 301_000)), {
            db,
            evaluateBinding: binding,
            enqueueDelivery: async () => {},
          });
          now = new Date(now.getTime() + 5 * 60_000);
        }

        expect(await seen(alert.id, [...lateMinutes, "12:07:00"])).toEqual(
          [...lateMinutes, "12:07:00"].map(keyAt).sort()
        );
        expect(await occurrencesTotal(alert.id)).toBe(lateMinutes.length + 1);
      });

      it("a row landing just after a pinned late window is seen once the drain outlasts the lookback", async () => {
        const alert = await createErrorsAlert();
        const t1 = await seed([]);
        const lateMinutes = [
          "11:31:00",
          "11:32:00",
          "11:33:00",
          "11:34:00",
          "11:35:00",
          "11:36:00",
        ];
        const after = "11:45:00";
        const behind = "11:30:30";
        const afterReplay = "12:22:00";
        const rows = lateMinutes.map((m) => ({ ...ROW, minute: T(m) }));
        let now = new Date("2026-10-01T12:05:00.000Z");
        const binding = createProductionEvaluateBinding({
          queryRowRunner: rangeRunner(rows),
          now: () => now,
          seenRetentionSec: RET,
          checkpointLookbackSec: 600,
          queryEvaluatorConfig: { ...DEFAULT_QUERY_EVALUATOR_CONFIG, rowsCap: 2 },
        });
        for (let i = 1; i <= 24; i++) {
          if (i === 2) rows.push({ ...ROW, minute: T(after) });
          if (i === 3) rows.push({ ...ROW, minute: T(behind) });
          if (i === 6) rows.push({ ...ROW, minute: T(afterReplay) });
          await evaluateAlert(await claimOne(new Date(t1.getTime() + i * 301_000)), {
            db,
            evaluateBinding: binding,
            enqueueDelivery: async () => {},
          });
          now = new Date(now.getTime() + 5 * 60_000);
        }

        const expected = [...lateMinutes, after, behind, afterReplay];
        expect(await seen(alert.id, expected)).toEqual(expected.map(keyAt).sort());
        expect(await occurrencesTotal(alert.id)).toBe(expected.length);
        expect(await readState(alert.id, "lateResumeFrom")).toBeUndefined();
        expect(await readState(alert.id, "lateWindow")).toBeUndefined();
      });

      it("a late arrival inside the lookback is seen once", async () => {
        const alert = await createErrorsAlert();
        const oldRows = OLD.map((m) => ({ ...ROW, minute: T(m) }));
        const t1 = await seed(oldRows);

        const late = { ...ROW, minute: T("11:20:00") };
        const binding = createProductionEvaluateBinding({
          queryRowRunner: rangeRunner([...oldRows, late]),
          now: () => NOW,
          seenRetentionSec: RET,
        });
        expect(await seen(alert.id, ["11:20:00"])).toEqual([]);
        for (const offset of [301_000, 602_000]) {
          await evaluateAlert(await claimOne(new Date(t1.getTime() + offset)), {
            db,
            evaluateBinding: binding,
            enqueueDelivery: async () => {},
          });
          expect(await seen(alert.id, ["11:20:00"])).toEqual([keyAt("11:20:00")]);
        }
      });
    });
  });
});

describe("occurrence row time and expiry", () => {
  const RETENTION = 7 * 86_400;

  function fakeAlert(capabilityKey: string): Alert {
    return {
      id: "alert_rt",
      organizationId: "org_pd",
      projectId: "proj_pd",
      capabilityKey,
      params: {
        environmentId: "env_pd",
        scope: { type: "errorGroup", taskIdentifier: "my-task", fingerprint: "fp1" },
      },
      condition: { kind: "occurrence" },
      evaluatorState: null,
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
    } as unknown as Alert;
  }

  const errors: Array<[string, Record<string, unknown>]> = [];
  const recordingLogger = {
    error: (message: string, fields?: Record<string, unknown>) => {
      errors.push([message, fields ?? {}]);
    },
    warn: () => {},
  };

  async function run(capabilityKey: string, rows: Record<string, unknown>[]) {
    const binding = createProductionEvaluateBinding({
      queryRowRunner: async () => rows,
      seenRetentionSec: RETENTION,
      logger: recordingLogger,
    });
    const { result } = await binding(fakeAlert(capabilityKey), getCapability(capabilityKey)!);
    if (result.kind !== "occurrence") throw new Error("kind");
    return result.occurrences;
  }

  it("clamps the checkpoint literal sent to the runner to the seen retention", async () => {
    const queries: string[] = [];
    const binding = createProductionEvaluateBinding({
      queryRowRunner: async (query) => {
        queries.push(query);
        return [];
      },
      seenRetentionSec: RETENTION,
      checkpointLookbackSec: 3600,
    });
    const before = Date.now();
    const alert = {
      ...fakeAlert("errors.occurred_again"),
      createdAt: new Date(before - 60 * 86_400_000),
      evaluatorState: { checkpoint: new Date(before - 10 * 86_400_000).toISOString() },
    } as Alert;
    await binding(alert, getCapability("errors.occurred_again")!);
    const after = Date.now();
    const literal = /minute >= '([^']+)'/.exec(queries[0]!)![1]!;
    const bound = Date.parse(`${literal.replace(" ", "T")}Z`);
    const lo = before - (RETENTION - 3600) * 1000;
    const hi = after - (RETENTION - 3600) * 1000;
    expect(bound).toBeGreaterThanOrEqual(Math.floor(lo / 1000) * 1000);
    expect(bound).toBeLessThanOrEqual(hi);
  });

  it("errors.new expiresAt is group_first_seen plus retention", async () => {
    const [occ] = await run("errors.new", [
      {
        task_identifier: "my-task",
        error_fingerprint: "fp1",
        group_first_seen: "2026-10-05 12:01:00",
      },
    ]);
    expect(occ!.rowTime).toEqual(new Date("2026-10-05T12:01:00.000Z"));
    expect(occ!.expiresAt).toEqual(new Date("2026-10-12T12:01:00.000Z"));
  });

  it("errors.occurred_again rowTime is the minute", async () => {
    const [occ] = await run("errors.occurred_again", [
      {
        task_identifier: "my-task",
        error_fingerprint: "fp1",
        minute: "2026-10-05 12:07:00",
        occurrences: 2,
      },
    ]);
    expect(occ!.rowTime).toEqual(new Date("2026-10-05T12:07:00.000Z"));
  });

  it("parses ClickHouse timestamps as UTC regardless of process timezone", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const [occ] = await run("errors.new", [
        {
          task_identifier: "my-task",
          error_fingerprint: "fp1",
          group_first_seen: "2026-10-05 12:01:00.123",
        },
      ]);
      expect(occ!.rowTime.toISOString()).toBe("2026-10-05T12:01:00.123Z");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("drops an occurrence whose row time cannot be parsed and logs an error", async () => {
    errors.length = 0;
    const occurrences = await run("errors.new", [
      { task_identifier: "my-task", error_fingerprint: "fp1", group_first_seen: "garbage" },
      {
        task_identifier: "my-task",
        error_fingerprint: "fp2",
        group_first_seen: "2026-10-05 12:01:00",
      },
    ]);
    expect(occurrences.map((o) => o.sourceEventId)).toEqual(["errors.new:env_pd:my-task:fp2"]);
    expect(errors).toEqual([
      [
        "alerts.occurrence_row_time_missing",
        {
          alertId: "alert_rt",
          capabilityKey: "errors.new",
          rowKey: "errors.new:env_pd:my-task:fp1",
        },
      ],
    ]);
  });
});
