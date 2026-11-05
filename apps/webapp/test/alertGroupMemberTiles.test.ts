import type { PrismaClient } from "@trigger.dev/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { createAlert } from "~/v3/services/alerts/storage/alertStore.server";
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

function member(seed: {
  name: string;
  observedCondition?: "met" | "not_met";
  lifecycle?: "active" | "stopped";
  lastError?: boolean;
}) {
  return createAlert(db, {
    ...ENV,
    capabilityKey: "queue.depth",
    params: { scope: { type: "all" } },
    condition: { kind: "threshold", operator: ">", value: 1, windowSec: 300 },
    createdBy: "user_1",
    name: seed.name,
    notifiers: [{ type: "channel", channelId: "chan" }],
    observedCondition: seed.observedCondition ?? "not_met",
    lifecycle: seed.lifecycle,
    evaluatorState: seed.lastError ? { lastError: { reason: "x" } } : null,
  });
}

describe("loadGroupMemberTiles", () => {
  it("loads each member's series on the alerts lane, in member order, isolating a failing member", async () => {
    const fired = await member({ name: "Fired" });
    const broken = await member({ name: "Broken", lastError: true });
    const stopped = await member({ name: "Stopped", lifecycle: "stopped" });
    const quiet = await member({ name: "Quiet" });
    const more = [await member({ name: "More 1" }), await member({ name: "More 2" })];
    const ids = [fired.id, broken.id, stopped.id, quiet.id, ...more.map((m) => m.id)];

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
        memberIds: ids,
        concurrency: 2,
        window: { since: new Date(0), until: new Date(1000) },
        project: { id: ENV.projectId, organizationId: ENV.organizationId },
        environmentId: ENV.environmentId,
      },
      {
        getDetail: async (id) => ({ id, name: `detail ${id}`, kind: "threshold" }) as AlertDetail,
        loadSeries,
      }
    );

    expect(calls.map((c) => c.lane)).toEqual(ids.map(() => "alerts"));
    expect(peak).toBe(2);

    expect(tiles.map((t) => t.healthBands.length)).toEqual([1, 0, 1, 1, 1, 1]);
  });

  it("a member whose detail throws is skipped and the others still load", async () => {
    const bad = await member({ name: "Bad" });
    const good = await member({ name: "Good" });
    const tiles = await loadGroupMemberTiles(
      db,
      {
        memberIds: [bad.id, good.id],
        concurrency: 2,
        window: { since: new Date(0), until: new Date(1000) },
        project: { id: ENV.projectId, organizationId: ENV.organizationId },
        environmentId: ENV.environmentId,
      },
      {
        getDetail: async (id) => {
          if (id === bad.id) throw new Error("presenter failed");
          return { id, name: "Good", kind: "threshold" } as AlertDetail;
        },
        loadSeries: (async () => EMPTY_SERIES) as unknown as typeof loadAlertSeries,
      }
    );
    expect(tiles.map((t) => t.id)).toEqual([good.id]);
  });
});
