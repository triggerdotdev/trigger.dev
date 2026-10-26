import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendAlertEvent,
  createAlert,
  type getAlertHealthEvents,
} from "~/v3/services/alerts/storage/alertStore.server";
import { startAlertsPostgres } from "./helpers/alertTables";
import { AlertDetailPresenter } from "~/presenters/v3/AlertDetailPresenter.server";
import { AlertsListPresenter } from "~/presenters/v3/AlertsListPresenter.server";

const bucketQuery = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("~/v3/services/alerts/storage/alertStore.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    getAlertHealthEvents: (...args: Parameters<typeof getAlertHealthEvents>) => {
      bucketQuery.calls.push([...args[1]]);
      return actual.getAlertHealthEvents(...args);
    },
  };
});

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

const BASE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  createdBy: "user_1",
};

const NO_FILTERS = { search: "", areas: [], period: undefined };

const MONTH = new Date().toISOString().slice(0, 7);

describe("AlertsListPresenter", () => {
  it("computes display status and sorts needs_attention, active, then inactive, most recent activity first within a tier", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-1" },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      lifecycle: "active",
      attention: "clear",
      name: "b-active",
      notifiers: [{ type: "chat", userId: "user_1" }],
    });

    const aNeedsAttention = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-2" },
      condition: { kind: "threshold", operator: ">", value: 50, windowSec: 60 },
      lifecycle: "active",
      attention: "needs_attention",
      name: "a-needs-attention",
      notifiers: [],
    });

    const cInactiveExpired = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-3" },
      condition: { kind: "absence", quietWindowSec: 600 },
      lifecycle: "expired",
      attention: "clear",
      name: "c-inactive-expired",
      notifiers: [],
    });

    const dInactiveStopped = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-4" },
      condition: { kind: "absence", quietWindowSec: 600 },
      lifecycle: "stopped",
      attention: "clear",
      name: "d-inactive-stopped",
      notifiers: [],
    });

    // Attention wins over lifecycle: an expired alert still needing attention displays
    // "Needs attention", not "Inactive · Expired", and sorts with the other raised rows.
    const a2NeedsAttentionExpired = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-5" },
      condition: { kind: "absence", quietWindowSec: 600 },
      lifecycle: "expired",
      attention: "needs_attention",
      name: "a2-needs-attention-expired",
      notifiers: [],
    });

    const eInactiveCompleted = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-6" },
      condition: { kind: "absence", quietWindowSec: 600 },
      lifecycle: "completed",
      attention: "clear",
      name: "e-inactive-completed",
      notifiers: [],
    });

    // Within a tier, rows sort by lastActivityAt descending, not by name: pick
    // createdAt values here whose order deliberately contradicts alphabetical order,
    // so a regression back to a name-based tiebreak would fail this assertion.
    const setUpdatedAt = (id: string, at: string) =>
      db.alert.update({ where: { id }, data: { createdAt: new Date(at) } });
    await Promise.all([
      setUpdatedAt(aNeedsAttention.id, "2026-01-01T00:00:00Z"),
      setUpdatedAt(a2NeedsAttentionExpired.id, "2026-01-01T00:01:00Z"),
      setUpdatedAt(cInactiveExpired.id, "2026-01-01T00:00:00Z"),
      setUpdatedAt(dInactiveStopped.id, "2026-01-01T00:02:00Z"),
      setUpdatedAt(eInactiveCompleted.id, "2026-01-01T00:01:00Z"),
    ]);

    const presenter = new AlertsListPresenter(db);
    const { rows } = await presenter.call({ environmentId: "env_1" });

    expect(rows.map((r) => r.name)).toEqual([
      "a2-needs-attention-expired",
      "a-needs-attention",
      "b-active",
      "d-inactive-stopped",
      "e-inactive-completed",
      "c-inactive-expired",
    ]);

    expect(rows[0]!.status).toBe("needs_attention");
    expect(rows[1]!.status).toBe("needs_attention");
    expect(rows[1]!.inactiveReason).toBeUndefined();
    expect(rows[2]!.status).toBe("active");
    expect(rows[2]!.notifierCount).toBe(1);
    expect(rows[2]!.conditionSummary).toBe("> 100 over 5m");
    expect(rows[3]!.status).toBe("inactive");
    expect(rows[3]!.inactiveReason).toBe("stopped");
    expect(rows[4]!.status).toBe("inactive");
    expect(rows[4]!.inactiveReason).toBe("completed");
    expect(rows[5]!.status).toBe("inactive");
    expect(rows[5]!.inactiveReason).toBe("expired");
  });

  it("derives lastEventAt from the latest event of any type, batched across alerts", async () => {
    const withEvents = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-7" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      name: "f-with-raises",
      notifiers: [],
    });

    const earlier = new Date(`${MONTH}-01T00:00:00Z`);
    const latest = new Date(`${MONTH}-02T00:00:00Z`);

    await appendAlertEvent(db, { alertId: withEvents.id, type: "raised", at: earlier });
    await appendAlertEvent(db, { alertId: withEvents.id, type: "raised", at: latest });
    await appendAlertEvent(db, {
      alertId: withEvents.id,
      type: "recovered",
      at: new Date(`${MONTH}-03T00:00:00Z`),
    });

    const withoutEvents = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-8" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      name: "g-no-raises",
      notifiers: [],
    });

    const presenter = new AlertsListPresenter(db);
    const { rows } = await presenter.call({ environmentId: "env_1" });

    const withEventsRow = rows.find((r) => r.id === withEvents.id);
    const withoutEventsRow = rows.find((r) => r.id === withoutEvents.id);

    expect(withEventsRow?.lastEventAt).toEqual(new Date(`${MONTH}-03T00:00:00Z`));
    expect(withoutEventsRow?.lastEventAt).toBeNull();
  });

  it("derives lastActivityAt from events and createdAt, never updatedAt", async () => {
    const createdAt = "2025-06-01T00:00:00Z";
    const eventAt = new Date(Date.now() - 15 * 60 * 60 * 1000);
    const withEvent = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-act-1" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      lifecycle: "active",
      attention: "needs_attention",
      name: "h-needs-attention-with-event",
      notifiers: [],
    });
    const noEvents = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-act-2" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      name: "i-no-events",
      notifiers: [],
    });
    await appendAlertEvent(db, { alertId: withEvent.id, type: "raised", at: eventAt });
    await db.alert.updateMany({
      where: { id: { in: [withEvent.id, noEvents.id] } },
      data: { createdAt: new Date(createdAt) },
    });

    const { rows } = await new AlertsListPresenter(db).call({ environmentId: "env_1" });
    const withEventRow = rows.find((r) => r.id === withEvent.id);
    const noEventsRow = rows.find((r) => r.id === noEvents.id);

    expect(withEventRow?.lastEventAt).toEqual(eventAt);
    expect(withEventRow?.lastActivityAt).toEqual(eventAt);
    expect(noEventsRow?.lastEventAt).toBeNull();
    expect(noEventsRow?.lastActivityAt).toEqual(new Date(createdAt));
  });

  it("includes event times for alerts beyond the sparkline slice", async () => {
    const WIDE = { ...BASE, environmentId: "env_wide" };
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
      const alert = await createAlert(db, {
        ...WIDE,
        capabilityKey: "queue.depth",
        params: { queue: `wide-${i}` },
        condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
        attention: "needs_attention",
        name: `wide-${i}`,
        notifiers: [],
      });
      ids.push(alert.id);
      await db.alert.update({
        where: { id: alert.id },
        data: { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i)) },
      });
    }
    const oldest = ids[25]!;
    const raisedAt = new Date(`${MONTH}-05T00:00:00Z`);
    await appendAlertEvent(db, { alertId: oldest, type: "raised", at: raisedAt });

    const { rows } = await new AlertsListPresenter(db).call({ environmentId: "env_wide" });

    expect(rows).toHaveLength(26);
    const row = rows.find((r) => r.id === oldest);
    expect(row?.lastEventAt).toEqual(raisedAt);
    expect(row?.episode).toMatchObject({ kind: "raised", at: raisedAt });
  });

  it("applies the status filter in the query so a match beyond the cap is returned", async () => {
    const env = { ...BASE, environmentId: "env_cap" };
    const stopped = await createAlert(db, {
      ...env,
      capabilityKey: "queue.depth",
      params: { queue: "q-stopped" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      lifecycle: "stopped",
      name: "only-inactive",
      notifiers: [],
    });
    for (let i = 0; i < 600; i++) {
      await createAlert(db, {
        ...env,
        capabilityKey: "queue.depth",
        params: { queue: `q-${i}` },
        condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
        lifecycle: "active",
        attention: "clear",
        name: `active-${i}`,
        notifiers: [],
      });
    }
    const { rows, truncated } = await new AlertsListPresenter(db).call({
      environmentId: "env_cap",
      filters: { search: "", statuses: ["inactive"], areas: [], period: undefined },
    });
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.id)).toEqual([stopped.id]);
  }, 120_000);

  it("uses stoppedAt as lastActivityAt when it is later than the last event", async () => {
    const stopped = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { queue: "worker-stop" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      lifecycle: "stopped",
      name: "j-stopped-after-event",
      notifiers: [],
    });
    const stoppedAt = `${MONTH}-28T00:00:00Z`;
    await appendAlertEvent(db, {
      alertId: stopped.id,
      type: "raised",
      at: new Date(`${MONTH}-15T00:00:00Z`),
    });
    await db.alert.update({
      where: { id: stopped.id },
      data: { createdAt: new Date("2026-01-01T00:00:00Z"), stoppedAt: new Date(stoppedAt) },
    });

    const { rows } = await new AlertsListPresenter(db).call({ environmentId: "env_1" });

    expect(rows.find((r) => r.id === stopped.id)?.lastActivityAt).toEqual(new Date(stoppedAt));
  });

  it("lastActivityAt follows lastOccurrenceAt and sorts above an older raise", async () => {
    const ENV = { ...BASE, environmentId: "env_occ_activity" };
    const DAY = 24 * 60 * 60 * 1000;
    const mk = async (queue: string, name: string) =>
      createAlert(db, {
        ...ENV,
        capabilityKey: "queue.depth",
        params: { queue },
        condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
        attention: "needs_attention",
        name,
        notifiers: [],
      });
    const recurring = await mk("occ-1", "recurring");
    const other = await mk("occ-2", "other");
    const occurredAt = new Date(Date.now() - 60 * 60 * 1000);
    await appendAlertEvent(db, {
      alertId: recurring.id,
      type: "raised",
      at: new Date(Date.now() - 3 * DAY),
    });
    await appendAlertEvent(db, {
      alertId: other.id,
      type: "raised",
      at: new Date(Date.now() - 2 * DAY),
    });
    await db.alert.update({ where: { id: recurring.id }, data: { lastOccurrenceAt: occurredAt } });
    await db.alert.updateMany({
      where: { id: { in: [recurring.id, other.id] } },
      data: { createdAt: new Date(Date.now() - 10 * DAY) },
    });

    const { rows } = await new AlertsListPresenter(db).call({ environmentId: ENV.environmentId });

    expect(rows.find((r) => r.id === recurring.id)?.lastActivityAt).toEqual(occurredAt);
    expect(rows.map((r) => r.id)).toEqual([recurring.id, other.id]);
  });

  it("lastEventAt follows lastOccurrenceAt so the default period filter keeps the alert", async () => {
    const ENV = { ...BASE, environmentId: "env_occ_last_event" };
    const DAY = 24 * 60 * 60 * 1000;
    const alert = await createAlert(db, {
      ...ENV,
      capabilityKey: "queue.depth",
      params: { queue: "occ-last" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      lifecycle: "active",
      attention: "clear",
      name: "occ-last",
      notifiers: [],
    });
    const occurredAt = new Date(Date.now() - 60 * 60 * 1000);
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "raised",
      at: new Date(Date.now() - 10 * DAY),
    });
    await db.alert.update({ where: { id: alert.id }, data: { lastOccurrenceAt: occurredAt } });

    const { rows } = await new AlertsListPresenter(db).call({
      environmentId: ENV.environmentId,
      filters: { search: "", statuses: [], areas: [], period: "7d" },
    });

    expect(rows.map((r) => r.id)).toEqual([alert.id]);
    expect(rows[0]!.lastEventAt).toEqual(occurredAt);
  });

  it("only returns alerts for the requested environment", async () => {
    await createAlert(db, {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_other",
      createdBy: "user_1",
      capabilityKey: "queue.depth",
      params: {},
      condition: { kind: "state", stateKey: "queue.stalled" },
      name: "other-env",
    });

    const presenter = new AlertsListPresenter(db);
    const { rows } = await presenter.call({ environmentId: "env_other" });

    expect(rows.map((r) => r.name)).toEqual(["other-env"]);
  });

  it("gives absence alerts state buckets like any other kind", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      environmentId: "env_absence",
      capabilityKey: "queue.depth",
      params: { environmentId: "env_absence", scope: { type: "queue", queue: "q1" } },
      condition: { kind: "absence", quietWindowSec: 1800 },
      name: "absence-alert",
      notifiers: [],
    });
    const { rows } = await new AlertsListPresenter(db).call({ environmentId: "env_absence" });
    expect(rows.find((r) => r.id === alert.id)?.stateBuckets).toHaveLength(24);
  });

  it("marks state buckets raised between a raise and its recovery", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      environmentId: "env_state_buckets",
      capabilityKey: "queue.depth",
      params: { queue: "state-buckets" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      name: "state-buckets",
      notifiers: [],
    });
    const hour = 3600_000;
    const now = Date.now();
    const raisedAt = new Date(now - 20 * hour);
    const recoveredAt = new Date(now - 10 * hour);
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "recovered",
      at: new Date(now - 60 * hour),
    });
    await appendAlertEvent(db, { alertId: alert.id, type: "raised", at: raisedAt });
    await appendAlertEvent(db, { alertId: alert.id, type: "recovered", at: recoveredAt });

    const { rows } = await new AlertsListPresenter(db).call({
      environmentId: "env_state_buckets",
    });
    const buckets = rows.find((r) => r.id === alert.id)!.stateBuckets!;
    expect(buckets).toHaveLength(24);
    const alignedNow = Math.floor(now / (2 * hour)) * 2 * hour;
    expect(buckets[0]!.date).toBe(alignedNow - 46 * hour);
    for (const b of buckets) {
      const end = b.date + 2 * hour;
      expect(b.raised).toBe(end > raisedAt.getTime() && b.date <= recoveredAt.getTime());
    }
  });

  it("seeds state buckets from a raise before the window", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      environmentId: "env_state_seed",
      capabilityKey: "health.flow",
      params: {},
      condition: { kind: "state", stateKey: "degraded" },
      name: "state-seed",
      notifiers: [],
    });
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "raised",
      at: new Date(Date.now() - 60 * 3600_000),
    });
    const { rows } = await new AlertsListPresenter(db).call({
      environmentId: "env_state_seed",
    });
    const buckets = rows.find((r) => r.id === alert.id)!.stateBuckets!;
    expect(buckets).toHaveLength(24);
    expect(buckets.every((b) => b.raised)).toBe(true);
  });

  it("raises state buckets when the condition is met again without a new event", async () => {
    const hour = 3600_000;
    const now = Date.now();
    const metAgainAt = new Date(now - 6 * hour);
    const alert = await createAlert(db, {
      ...BASE,
      environmentId: "env_state_remet",
      capabilityKey: "queue.depth",
      params: { queue: "state-remet" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      name: "state-remet",
      notifiers: [],
      attention: "needs_attention",
      observedCondition: "met",
      observedConditionChangedAt: metAgainAt,
    });
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "raised",
      at: new Date(now - 30 * hour),
    });
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "recovered",
      at: new Date(now - 20 * hour),
    });
    const { rows } = await new AlertsListPresenter(db).call({
      environmentId: "env_state_remet",
    });
    const buckets = rows.find((r) => r.id === alert.id)!.stateBuckets!;
    for (const b of buckets) {
      const end = b.date + 2 * hour;
      const inFirst = end > now - 30 * hour && b.date <= now - 20 * hour;
      expect(b.raised).toBe(inFirst || end > metAgainAt.getTime());
    }
    expect(buckets[buckets.length - 1]!.raised).toBe(true);
  });

  it("stops raised state buckets at a resolve while the condition stays met", async () => {
    const hour = 3600_000;
    const now = Date.now();
    const resolvedAt = new Date(now - 10 * hour);
    const alert = await createAlert(db, {
      ...BASE,
      environmentId: "env_state_resolved",
      capabilityKey: "queue.depth",
      params: { queue: "state-resolved" },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      name: "state-resolved",
      notifiers: [],
      attention: "clear",
      observedCondition: "met",
      observedConditionChangedAt: new Date(now - 20 * hour),
    });
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "raised",
      at: new Date(now - 20 * hour),
    });
    await appendAlertEvent(db, { alertId: alert.id, type: "resolved", at: resolvedAt });
    const { rows } = await new AlertsListPresenter(db).call({
      environmentId: "env_state_resolved",
    });
    const buckets = rows.find((r) => r.id === alert.id)!.stateBuckets!;
    for (const b of buckets.filter((b) => b.date > resolvedAt.getTime())) {
      expect(b.raised).toBe(false);
    }
    expect(buckets[buckets.length - 1]!.raised).toBe(false);
  });

  it("keeps early in-window state events when more than 50 follow", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      environmentId: "env_state_flap",
      capabilityKey: "health.flow",
      params: {},
      condition: { kind: "state", stateKey: "degraded" },
      name: "state-flap",
      notifiers: [],
    });
    const hour = 3600_000;
    const now = Date.now();
    const since = Math.floor(now / (2 * hour)) * 2 * hour - 46 * hour;
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "recovered",
      at: new Date(now - 60 * hour),
    });
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "raised",
      at: new Date(since + 30 * 60_000),
    });
    await appendAlertEvent(db, {
      alertId: alert.id,
      type: "recovered",
      at: new Date(since + 90 * 60_000),
    });
    for (let i = 0; i < 60; i++) {
      await appendAlertEvent(db, {
        alertId: alert.id,
        type: "recovered",
        at: new Date(now - (i + 1) * 10_000),
      });
    }
    const { rows } = await new AlertsListPresenter(db).call({
      environmentId: "env_state_flap",
    });
    const buckets = rows.find((r) => r.id === alert.id)!.stateBuckets!;
    expect(buckets[0]!.raised).toBe(true);
    expect(buckets[1]!.raised).toBe(false);
  });

  it("gives a never-raised row 24 empty state buckets", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      environmentId: "env_state_never",
      capabilityKey: "health.flow",
      params: {},
      condition: { kind: "state", stateKey: "degraded" },
      name: "state-never",
      notifiers: [],
    });
    const { rows } = await new AlertsListPresenter(db).call({
      environmentId: "env_state_never",
    });
    const buckets = rows.find((r) => r.id === alert.id)!.stateBuckets!;
    expect(buckets).toHaveLength(24);
    expect(buckets.some((b) => b.raised)).toBe(false);
  });

  it("carries the parsed scope, and no scope when params don't parse", async () => {
    const env = { ...BASE, environmentId: "env_scope" };
    const parsed = await createAlert(db, {
      ...env,
      capabilityKey: "queue.depth",
      params: { environmentId: "env_scope", scope: { type: "queue", queue: "emails" } },
      condition: { kind: "threshold", operator: ">", value: 1, windowSec: 60 },
      lifecycle: "active",
      attention: "clear",
      name: "parsed",
      notifiers: [],
    });
    const broken = await createAlert(db, {
      ...env,
      capabilityKey: "queue.depth",
      params: { queue: "emails" },
      condition: { kind: "threshold", operator: ">", value: 1, windowSec: 60 },
      lifecycle: "active",
      attention: "clear",
      name: "broken",
      notifiers: [],
    });

    const { rows } = await new AlertsListPresenter(db).call({ environmentId: "env_scope" });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(parsed.id)!.scope).toEqual({ type: "queue", queue: "emails" });
    expect(byId.get(broken.id)!.scope).toBeUndefined();
    expect(byId.get(parsed.id)!.capabilityKey).toBe("queue.depth");
    expect(byId.get(parsed.id)!.environmentId).toBe("env_scope");
  });

  it("pages 60 alerts as 50 then 10", async () => {
    const env = "env_paged";
    for (let i = 0; i < 60; i++) {
      await createAlert(db, {
        ...BASE,
        environmentId: env,
        capabilityKey: "queue.depth",
        params: { queue: `paged-${i}` },
        condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
        name: `paged-${i}`,
        notifiers: [],
      });
    }
    const presenter = new AlertsListPresenter(db);
    const first = await presenter.call({ environmentId: env, page: 1 });
    const second = await presenter.call({ environmentId: env, page: 2 });
    expect(first.rows).toHaveLength(50);
    expect(first.totalPages).toBe(2);
    expect(first.rows.every((r) => r.stateBuckets)).toBe(true);
    expect(second.rows).toHaveLength(10);
    expect(second.page).toBe(2);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(60);
  });

  it("filters before paging: 60 of 120 match, pages 50 then 10", async () => {
    const env = "env_filtered_paged";
    for (let i = 0; i < 120; i++) {
      await createAlert(db, {
        ...BASE,
        environmentId: env,
        capabilityKey: "queue.depth",
        params: { queue: `filtered-${i}` },
        condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
        lifecycle: "active",
        attention: i % 2 === 0 ? "needs_attention" : "clear",
        name: `filtered-${i}`,
        notifiers: [],
      });
    }
    const presenter = new AlertsListPresenter(db);
    const filters = {
      search: "",
      statuses: ["needs_attention" as const],
      areas: [],
      period: undefined,
    };
    const first = await presenter.call({ environmentId: env, page: 1, filters });
    const second = await presenter.call({ environmentId: env, page: 2, filters });
    expect(first.rows).toHaveLength(50);
    expect(first.totalPages).toBe(2);
    expect(second.rows).toHaveLength(10);
    expect([...first.rows, ...second.rows].every((r) => r.status === "needs_attention")).toBe(true);
  });

  it("fetches state buckets only for the visible page", async () => {
    const presenter = new AlertsListPresenter(db);
    bucketQuery.calls.length = 0;
    const { rows } = await presenter.call({ environmentId: "env_paged", page: 2 });
    expect(rows).toHaveLength(10);
    expect(bucketQuery.calls).toHaveLength(1);
    expect(bucketQuery.calls[0]!.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("clamps out-of-range pages", async () => {
    const presenter = new AlertsListPresenter(db);
    const low = await presenter.call({ environmentId: "env_paged", page: 0 });
    const high = await presenter.call({ environmentId: "env_paged", page: 99 });
    expect(low.page).toBe(1);
    expect(low.rows).toHaveLength(50);
    expect(high.page).toBe(2);
    expect(high.rows).toHaveLength(10);
  });

  it("flags truncation only when more alerts exist than the list cap", async () => {
    const env = "env_truncated";
    const add = (i: number) =>
      createAlert(db, {
        ...BASE,
        environmentId: env,
        capabilityKey: "queue.depth",
        params: { queue: `trunc-${i}` },
        condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
        name: `trunc-${i}`,
        notifiers: [],
      });
    for (let i = 0; i < 500; i++) await add(i);
    const presenter = new AlertsListPresenter(db);
    const exact = await presenter.call({ environmentId: env });
    expect(exact.truncated).toBe(false);
    expect(exact.totalPages).toBe(10);
    await add(500);
    const capped = await presenter.call({ environmentId: env });
    expect(capped.truncated).toBe(true);
    expect(capped.totalPages).toBe(10);
    const small = await presenter.call({ environmentId: "env_1" });
    expect(small.truncated).toBe(false);
  }, 120_000);
});

async function seedWorld(prisma: PrismaClient, environmentTypes: RuntimeEnvironmentType[]) {
  const slug = `w${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: slug,
    },
  });
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_channel_${slug}`,
      name: "ops",
      type: "EMAIL",
      projectId: project.id,
      properties: { email: "ops@example.com" },
      alertTypes: [],
      environmentTypes,
    },
  });
  return { organization, project, environment, channel };
}

async function seedChannel(prisma: PrismaClient, environmentTypes: RuntimeEnvironmentType[]) {
  const { organization, project, environment, channel } = await seedWorld(prisma, environmentTypes);
  const alert = (lifecycle: "active" | "stopped") =>
    createAlert(db, {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      createdBy: "user_1",
      capabilityKey: "queue.depth",
      params: { queue: "worker-1" },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      lifecycle,
      name: lifecycle,
      notifiers: [{ type: "channel", channelId: channel.id }],
    });
  await alert("active");
  await alert("stopped");
  const { rows } = await new AlertsListPresenter(db, prisma).call({
    environmentId: environment.id,
  });
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

describe("AlertsListPresenter channel warning", () => {
  postgresTest("flags a channel that does not deliver for the environment", async ({ prisma }) => {
    const rows = await seedChannel(prisma, ["STAGING"]);
    expect(rows.active).toMatchObject({ status: "active", hasChannelIssue: true });
    expect(rows.stopped).toMatchObject({ status: "inactive", inactiveReason: "stopped" });
  });

  postgresTest("stays active when the channel delivers for the environment", async ({ prisma }) => {
    const rows = await seedChannel(prisma, ["PRODUCTION"]);
    expect(rows.active!.status).toBe("active");
    expect(rows.active!.hasChannelIssue).toBe(false);
  });

  postgresTest(
    "status filter ignores channel issues",
    async ({ prisma }) => {
      const { organization, project, environment, channel } = await seedWorld(prisma, ["STAGING"]);
      const create = (name: string, notifiers: object[]) =>
        createAlert(db, {
          organizationId: organization.id,
          projectId: project.id,
          environmentId: environment.id,
          createdBy: "user_1",
          capabilityKey: "queue.depth",
          params: { queue: "worker-1" },
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
          lifecycle: "active",
          name,
          notifiers,
        });
      await create("bad", [{ type: "channel", channelId: channel.id }]);
      await create("healthy", []);
      const names = async (statuses: ("needs_attention" | "active")[]) => {
        const { rows } = await new AlertsListPresenter(db, prisma).call({
          environmentId: environment.id,
          filters: { search: "", statuses, areas: [], period: undefined },
        });
        return rows.map((r) => r.name);
      };
      expect((await names(["active"])).sort()).toEqual(["bad", "healthy"]);
      expect(await names(["needs_attention"])).toEqual([]);
    },
    120_000
  );

  postgresTest(
    "a raised alert with a broken channel still filters as needs attention",
    async ({ prisma }) => {
      const { organization, project, environment, channel } = await seedWorld(prisma, ["STAGING"]);
      await createAlert(db, {
        organizationId: organization.id,
        projectId: project.id,
        environmentId: environment.id,
        createdBy: "user_1",
        capabilityKey: "queue.depth",
        params: { queue: "worker-1" },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        attention: "needs_attention",
        name: "raised",
        notifiers: [{ type: "channel", channelId: channel.id }],
      });
      const presenter = new AlertsListPresenter(db, prisma);
      const list = (statuses: ("needs_attention" | "active" | "inactive")[]) =>
        presenter
          .call({ environmentId: environment.id, filters: { ...NO_FILTERS, statuses } })
          .then((r) => r.rows.map((row) => row.name));

      const { rows } = await presenter.call({ environmentId: environment.id });
      expect(rows[0]).toMatchObject({ status: "needs_attention", hasChannelIssue: true });
      expect(await list(["needs_attention"])).toEqual(["raised"]);
      expect(await list(["active"])).toEqual([]);
    }
  );

  postgresTest(
    "reports a deleted channel when the environment is not found",
    async ({ prisma }) => {
      const { organization, project } = await seedWorld(prisma, ["STAGING"]);
      const alert = await createAlert(db, {
        organizationId: organization.id,
        projectId: project.id,
        environmentId: "env_missing",
        createdBy: "user_1",
        capabilityKey: "queue.depth",
        params: { environmentId: "env_missing", scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        name: "orphan",
        notifiers: [{ type: "channel", channelId: "chan_deleted" }],
      });

      const { rows } = await new AlertsListPresenter(db, prisma).call({
        environmentId: "env_missing",
      });
      expect(rows[0]).toMatchObject({ status: "active", hasChannelIssue: true });

      const detail = await new AlertDetailPresenter(
        db,
        prisma,
        undefined,
        async () => null,
        async () => null,
        {
          evaluateBinding: async () => ({
            result: { kind: "stateful", outcome: "not_met", facts: {} },
          }),
        }
      ).call({ id: alert.id, projectId: project.id, environmentId: "env_missing" });
      expect(detail?.channelIssues).toEqual([
        { channelId: "chan_deleted", name: null, reason: "deleted" },
      ]);
      expect(detail?.status).toEqual({ status: "active" });
    }
  );
});
