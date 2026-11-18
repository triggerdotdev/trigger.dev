import type { PrismaClient } from "@trigger.dev/database";
import { Prisma } from "@trigger.dev/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alertStateBuckets,
  listAlertStateBuckets,
  stateBucketsSince,
} from "~/presenters/v3/AlertsListPresenter.server";
import {
  createAlert,
  listAlerts,
  type Alert,
} from "~/v3/services/alerts/storage/alertStore.server";
import { startAlertsPostgres } from "./helpers/alertTables";

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

const HOUR = 3600_000;
const BUCKET = 2 * HOUR;
const TYPES = ["raised", "recovered", "resolved", "stopped", "expired", "acknowledged"];

async function oldHealthEvents(alertIds: string[], since: Date) {
  const ids = Prisma.sql`ARRAY[${Prisma.join(alertIds)}]::text[]`;
  const sinceAt = Prisma.sql`${since.toISOString()}::timestamptz`;
  const rows = await db.$queryRaw<Array<{ alert_id: string; type: string; at: Date }>>`
    WITH ids AS (SELECT unnest(${ids}) AS id)
    SELECT ids.id AS alert_id, w.type, w.at FROM ids
    JOIN LATERAL (
      SELECT "type" AS type, "at" AS at FROM "AlertEvent"
      WHERE "alertId" = ids.id AND "at" >= ${sinceAt}
      ORDER BY "at" DESC LIMIT 1000
    ) w ON true
    UNION ALL
    SELECT ids.id AS alert_id, s.type, s.at FROM ids
    JOIN LATERAL (
      SELECT "type" AS type, "at" AS at FROM "AlertEvent"
      WHERE "alertId" = ids.id AND "at" < ${sinceAt}
      ORDER BY "at" DESC LIMIT 1
    ) s ON true`;
  const result = new Map<string, { type: string; at: Date }[]>();
  for (const row of rows) {
    result.set(row.alert_id, [...(result.get(row.alert_id) ?? []), row]);
  }
  return result;
}

function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function eventTimes(rand: () => number, since: number, count: number): number[] {
  const times = new Set<number>();
  for (let b = 0; b <= 24; b += 3) {
    times.add(since + b * BUCKET);
    times.add(since + b * BUCKET - 1);
  }
  for (let k = 0; k < 6; k++) times.add(since + 5 * BUCKET + 1000 + k * 60_000);
  while (times.size < count) {
    times.add(Math.floor(since - 20 * HOUR + rand() * (70 * HOUR)));
  }
  return [...times].filter((t) => t < since || Math.floor((t - since) / BUCKET) % 7 !== 3);
}

async function seed(now: number) {
  const since = stateBucketsSince(now).getTime();
  const rand = random(42);
  const ids: string[] = [];
  const alertIds: string[] = [];
  const types: string[] = [];
  const ats: Date[] = [];
  for (let i = 0; i < 200; i++) {
    const met = i % 5 === 0;
    const alert = await createAlert(db, {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_diff",
      createdBy: "user_1",
      capabilityKey: "health.flow",
      params: {},
      condition: { kind: "state", stateKey: "degraded" },
      name: `diff-${i}`,
      notifiers: [],
      attention: met ? "needs_attention" : "clear",
      observedCondition: met ? "met" : "unknown",
      observedConditionChangedAt: met ? new Date(since + rand() * 48 * HOUR) : undefined,
    });
    const times = i === 0 ? [] : i === 1 ? [since - 5 * HOUR] : eventTimes(rand, since, 500);
    for (const t of times) {
      ids.push(`ev_${i}_${t}`);
      alertIds.push(alert.id);
      types.push(i === 1 ? "raised" : TYPES[Math.floor(rand() * TYPES.length)]!);
      ats.push(new Date(t));
    }
  }
  await db.$executeRaw`
    INSERT INTO "AlertEvent" ("id", "alertId", "type", "at")
    SELECT * FROM unnest(${ids}::text[], ${alertIds}::text[], ${types}::text[], ${ats}::timestamptz[])`;
  return listAlerts(db, { environmentId: "env_diff", limit: 1000 });
}

describe("alert list state buckets", () => {
  it("bucket events in SQL with the same result as the raw-event path", async () => {
    // Catches: SQL bucketing diverges from the in-memory bucketing
    const now = Math.floor(Date.now() / BUCKET) * BUCKET + 1234;
    const alerts: Alert[] = await seed(now);
    const since = stateBucketsSince(now);
    const ids = alerts.map((a) => a.id);

    const oldEvents = await oldHealthEvents(ids, since);

    const expected = Object.fromEntries(
      alerts.map((a) => [a.id, alertStateBuckets(a, oldEvents.get(a.id) ?? [], since)])
    );
    expect(alerts).toHaveLength(200);
    expect(await listAlertStateBuckets(db, alerts, now)).toEqual(expected);
  }, 120_000);

  it("keeps the oldest in-window raise when an alert has more than 1,000 events", async () => {
    // Catches: the 1,000-event cap dropped the oldest events in the window
    const now = Math.floor(Date.now() / BUCKET) * BUCKET + 1234;
    const since = stateBucketsSince(now);
    const alert = await createAlert(db, {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_cap",
      createdBy: "user_1",
      capabilityKey: "health.flow",
      params: {},
      condition: { kind: "state", stateKey: "degraded" },
      name: "capped",
      notifiers: [],
    });
    const ats = [new Date(since.getTime() + 1000)];
    for (let k = 0; k < 1199; k++) ats.push(new Date(since.getTime() + BUCKET + k * 60_000));
    const types = ats.map((_, i) => (i === 0 ? "raised" : "recovered"));
    const ids = ats.map((_, i) => `cap_${i}`);
    await db.$executeRaw`
      INSERT INTO "AlertEvent" ("id", "alertId", "type", "at")
      SELECT id, ${alert.id}, type, at
      FROM unnest(${ids}::text[], ${types}::text[], ${ats}::timestamptz[]) AS e(id, type, at)`;

    const oldEvents = (await oldHealthEvents([alert.id], since)).get(alert.id) ?? [];
    const oldBuckets = alertStateBuckets(alert, oldEvents, since);
    const newBuckets = (await listAlertStateBuckets(db, [alert], now))[alert.id]!;
    expect(oldBuckets[0]!.raised).toBe(false);
    expect(newBuckets[0]!.raised).toBe(true);
    expect(newBuckets.slice(2).some((b) => b.raised)).toBe(false);
  });
});
