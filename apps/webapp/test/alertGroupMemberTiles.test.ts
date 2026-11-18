import type { PrismaClient } from "@trigger.dev/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertDetailPresenter, type ChartAlert } from "~/presenters/v3/AlertDetailPresenter.server";
import {
  appendAlertEvent,
  createAlert,
  getAlertsByIds,
} from "~/v3/services/alerts/storage/alertStore.server";
import {
  EMPTY_SERIES,
  loadGroupMemberTiles,
  type loadAlertSeries,
} from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.$alertId/alertDetailSeries.server";
import { rawSqlClient, startAlertsPostgres } from "./helpers/alertTables";

vi.setConfig({ testTimeout: 60_000 });

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

beforeEach(async () => {
  await rawSqlClient(db)`DELETE FROM "Alert"`;
});

const ENV = { organizationId: "org_1", projectId: "proj_1", environmentId: "env_1" };
const PROJECT = { id: ENV.projectId, organizationId: ENV.organizationId };
const NO_SERIES = (async () => EMPTY_SERIES) as unknown as typeof loadAlertSeries;

function member(seed: {
  name: string;
  observedCondition?: "met" | "not_met";
  lifecycle?: "active" | "stopped";
  lastError?: boolean;
}) {
  return createAlert(db, {
    ...ENV,
    capabilityKey: "queue.depth",
    params: { environmentId: ENV.environmentId, scope: { type: "all" } },
    condition: { kind: "threshold", operator: ">", value: 1, windowSec: 300 },
    createdBy: "user_1",
    name: seed.name,
    notifiers: [{ type: "channel", channelId: "chan" }],
    observedCondition: seed.observedCondition ?? "not_met",
    lifecycle: seed.lifecycle,
    evaluatorState: seed.lastError ? { lastError: { reason: "x" } } : null,
  });
}

const CHART_KEYS = [
  "id",
  "name",
  "kind",
  "capabilityKey",
  "capabilityTitle",
  "capabilityDescription",
  "conditionSummary",
  "operator",
  "thresholdValue",
  "unitSuffix",
  "windowSec",
  "scope",
  "status",
  "evaluated",
  "episode",
  "events",
] as const satisfies readonly (keyof ChartAlert)[];

describe("loadGroupMemberTiles", () => {
  it("projects each member to the same chart fields the full detail presenter returns", async () => {
    const now = Date.now();
    const window = { since: new Date(now - 3600_000), until: new Date(now - 60_000) };
    const seeds = [
      {
        capabilityKey: "queue.depth",
        params: { scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: 5, windowSec: 300 },
      },
      {
        capabilityKey: "custom.absence",
        params: { scope: { type: "task", taskIdentifier: "task-a" } },
        condition: { kind: "absence", quietWindowSec: 600 },
      },
      {
        capabilityKey: "custom.errors",
        params: {
          scope: { type: "errorGroup", fingerprint: "fp_123456789", taskIdentifier: "task-b" },
        },
        condition: { kind: "occurrence" },
      },
      {
        capabilityKey: "health.flow",
        params: { scope: { type: "all" } },
        condition: { kind: "state", stateKey: "degraded" },
      },
      {
        capabilityKey: "queue.depth",
        params: { scope: { type: "queue", queue: "q1" } },
        condition: { kind: "threshold", operator: "<", value: 2, windowSec: 60 },
      },
    ];
    const members = [];
    for (const [i, seed] of seeds.entries()) {
      const alert = await createAlert(db, {
        ...ENV,
        ...seed,
        params: { environmentId: ENV.environmentId, ...seed.params },
        createdBy: "user_1",
        name: i === 1 ? null : `member ${i}`,
        notifiers: [],
        attention: i % 2 ? "needs_attention" : "clear",
        lastEvaluatedAt: i === 3 ? null : new Date(now - 120_000),
      } as Parameters<typeof createAlert>[1]);
      for (let e = 0; e < (i === 0 ? 70 : 6); e++) {
        await appendAlertEvent(db, {
          alertId: alert.id,
          type: e % 2 ? "recovered" : "raised",
          at: new Date(now - 30_000 - e * (i === 0 ? 55_000 : 1_200_000)),
          facts: { value: e, threshold: 5, fingerprint: `fp_${e}` },
        });
      }
      members.push(alert);
    }
    const elsewhere = await createAlert(db, {
      ...ENV,
      environmentId: "env_2",
      capabilityKey: "queue.depth",
      params: { scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 1, windowSec: 300 },
      createdBy: "user_1",
      notifiers: [],
    });

    const order = [members[3]!, members[0]!, members[4]!, members[1]!, members[2]!];
    const rows = await getAlertsByIds(db, {
      ids: [order[0]!.id, "alert_missing", elsewhere.id, ...order.slice(1).map((m) => m.id)],
      projectId: ENV.projectId,
      environmentId: ENV.environmentId,
    });
    const tiles = await loadGroupMemberTiles(
      db,
      { members: rows, concurrency: 2, window, project: PROJECT },
      { loadSeries: NO_SERIES }
    );

    const presenter = new AlertDetailPresenter(db, db, undefined, undefined, async () => null, {
      evaluateBinding: async () => {
        throw new Error("no query engine");
      },
    });
    const expected = [];
    for (const row of rows) {
      const detail = await presenter.call({ ...ENV, id: row.id, eventsWindow: window });
      expected.push(Object.fromEntries(CHART_KEYS.map((key) => [key, detail![key]])));
    }
    // Catches: member tiles drifting from the detail presenter (event cap, window, episode, status, order, env scoping).
    expect(tiles.map((tile) => tile.alert)).toEqual(expected);
    expect(tiles.map((tile) => tile.id)).toEqual(order.map((m) => m.id));
  });

  it("loads each member's series on the alerts lane, in member order, isolating a failing member", async () => {
    const fired = await member({ name: "Fired" });
    const broken = await member({ name: "Broken", lastError: true });
    const stopped = await member({ name: "Stopped", lifecycle: "stopped" });
    const quiet = await member({ name: "Quiet" });
    const more = [await member({ name: "More 1" }), await member({ name: "More 2" })];
    const members = [fired, broken, stopped, quiet, ...more];

    let running = 0;
    let peak = 0;
    const calls: { alertId: string; lane?: string }[] = [];
    const series = { ...EMPTY_SERIES, healthBands: [{ bucket: 1 }] };
    const loadSeries = vi.fn(async (_db, input) => {
      calls.push({ alertId: input.alertId, lane: input.lane });
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (input.alertId === broken.id) throw new Error("query failed");
      return series;
    }) as unknown as typeof loadAlertSeries;

    const tiles = await loadGroupMemberTiles(
      db,
      {
        members,
        concurrency: 2,
        window: { since: new Date(0), until: new Date(1000) },
        project: PROJECT,
      },
      { loadSeries }
    );

    expect(calls.map((c) => c.lane)).toEqual(members.map(() => "alerts"));
    expect(peak).toBe(2);
    expect(tiles.map((t) => t.healthBands.length)).toEqual([1, 0, 1, 1, 1, 1]);
  });
});
