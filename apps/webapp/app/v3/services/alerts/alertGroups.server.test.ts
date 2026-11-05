import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";
import { rawSqlClient, startAlertsPostgres } from "../../../../test/helpers/alertTables";
import {
  claimAlertForEvaluation,
  createAlert,
  expireAlerts,
  getAlert,
  type Alert,
} from "./storage/alertStore.server";
import { evaluateAlert } from "./engine/evaluateAlert.server";
import { evaluateAlertGroup } from "./engine/evaluateAlertGroup.server";
import { createProductionEvaluateBinding } from "./engine/productionEvaluateBinding.server";
import {
  createInMemoryCurrentReadingCache,
  getCurrentReading,
} from "./engine/currentReading.server";
import {
  createAlertGroup,
  editAlertGroup,
  removeGroupMember,
  ungroupAlert,
} from "./alertGroups.server";
import {
  activateAlert,
  AlertActivationInvalidError,
  performAlertAction,
} from "./alertActions.server";

vi.setConfig({ testTimeout: 60_000 });

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

beforeEach(async () => {
  await rawSql`DELETE FROM "AlertDelivery"`;
  await rawSql`DELETE FROM "AlertEvent"`;
  await rawSql`DELETE FROM "Alert"`;
});

const ENV = { organizationId: "org_1", projectId: "proj_1", environmentId: "env_1" };
const lifecycle = { enqueue: async () => undefined, ack: async () => undefined };

type MemberSeed = {
  observedCondition?: "unknown" | "met" | "not_met";
  lifecycle?: "active" | "stopped";
  expiresAt?: Date;
  lastError?: boolean;
  environmentId?: string;
  groupId?: string;
  capabilityKey?: string;
  name?: string;
  occurrence?: { at: Date; seenAt: Date };
};

function member(seed: MemberSeed = {}) {
  return createAlert(db, {
    ...ENV,
    environmentId: seed.environmentId ?? ENV.environmentId,
    capabilityKey: seed.capabilityKey ?? "queue.depth",
    params: { scope: { type: "all" } },
    condition: seed.occurrence
      ? { kind: "occurrence" }
      : { kind: "threshold", operator: ">", value: 1, windowSec: 300 },
    createdBy: "user_1",
    name: seed.name ?? null,
    lastOccurrenceAt: seed.occurrence?.at,
    notifiers: [{ type: "channel", channelId: "member_chan" }],
    observedCondition: seed.observedCondition ?? "not_met",
    lifecycle: seed.lifecycle,
    expiresAt: seed.expiresAt,
    evaluatorState: seed.lastError
      ? { lastError: { reason: "x" } }
      : seed.occurrence
        ? { occurrenceSeenAt: seed.occurrence.seenAt.toISOString() }
        : null,
    groupId: seed.groupId,
  });
}

async function group(members: Alert[], compositeMode: "any" | "all" = "any") {
  const result = await createAlertGroup(
    db,
    {
      ...ENV,
      memberAlertIds: members.map((m) => m.id),
      compositeMode,
      notifiers: [{ type: "channel", channelId: "group_chan" }],
      createdBy: "user_1",
    },
    lifecycle
  );
  if (!result.ok) throw new Error(result.error);
  return result.alert;
}

const groupBinding = () =>
  createProductionEvaluateBinding({
    db,
    queryRowRunner: async () => {
      throw new Error("group must not run member queries");
    },
  });

async function evaluate(id: string) {
  const claim = await claimAlertForEvaluation(db, { id, now: new Date(), leaseMs: 60_000 });
  if (!claim.claimed) throw new Error(`not claimed: ${claim.reason}`);
  const enqueued: string[] = [];
  const outcome = await evaluateAlert(claim.alert, {
    db,
    evaluateBinding: async () => ({
      result: { kind: "stateful", outcome: "met", facts: { value: 5 } },
    }),
    enqueueDelivery: async ({ eventId }) => {
      enqueued.push(eventId);
    },
  });
  await db.alert.update({ where: { id }, data: { nextEvaluationAt: null } });
  return { outcome, enqueued };
}

describe("group evaluation", () => {
  const PAST = new Date(Date.now() - 60_000);
  it.each<[string, "any" | "all", MemberSeed[], string, string?]>([
    ["any: one met fires", "any", [{ observedCondition: "met" }, {}], "met"],
    [
      "any: late occurrence seen now fires",
      "any",
      [
        {
          capabilityKey: "errors.new",
          observedCondition: "unknown",
          occurrence: { at: new Date(Date.now() - 40 * 60_000), seenAt: new Date() },
        },
        {},
      ],
      "met",
    ],
    [
      "any: stale occurrence member holds",
      "any",
      [
        {
          capabilityKey: "errors.new",
          observedCondition: "unknown",
          occurrence: {
            at: new Date(Date.now() - 11 * 60_000),
            seenAt: new Date(Date.now() - 11 * 60_000),
          },
        },
        {},
      ],
      "not_met",
    ],
    ["all: one not met holds", "all", [{ observedCondition: "met" }, {}], "not_met"],
    [
      "all: every met fires",
      "all",
      [{ observedCondition: "met" }, { observedCondition: "met" }],
      "met",
    ],
    [
      "unknown member ignored",
      "all",
      [{ observedCondition: "met" }, { observedCondition: "unknown" }],
      "met",
    ],
    [
      "stopped member ignored",
      "all",
      [{ observedCondition: "met" }, { lifecycle: "stopped" }],
      "met",
    ],
    ["expired member ignored", "all", [{ observedCondition: "met" }, { expiresAt: PAST }], "met"],
    ["erroring member ignored", "all", [{ observedCondition: "met" }, { lastError: true }], "met"],
    [
      "all unavailable",
      "any",
      [{ observedCondition: "unknown" }, { lastError: true }],
      "unavailable",
      "members_unavailable",
    ],
  ])("%s", async (_name, mode, seeds, expected, reason) => {
    const members = await Promise.all(seeds.map((s) => member({ ...s, lifecycle: undefined })));
    const alert = await group(members, mode);
    await db.alert.updateMany({
      where: { id: { in: members.filter((_, i) => seeds[i]!.lifecycle).map((m) => m.id) } },
      data: { lifecycle: "stopped" },
    });
    const { result } = await evaluateAlertGroup(db, alert);
    expect(result.outcome).toBe(expected);
    expect(result.facts.unavailableReason).toBe(reason);
    expect(Object.keys(result.facts.members as object).sort()).toEqual(
      members.map((m) => m.id).sort()
    );
  });

  it("a resolved group ignores occurrences seen before resolution", async () => {
    const members = await Promise.all([
      member({
        capabilityKey: "errors.new",
        observedCondition: "unknown",
        occurrence: { at: new Date(), seenAt: new Date(Date.now() - 60_000) },
      }),
      member(),
    ]);
    const alert = await group(members);
    const { result } = await evaluateAlertGroup(db, { ...alert, resolvedAt: new Date() });
    expect(result.outcome).toBe("not_met");
  });

  it("raises through hysteresis on member states only and lists fired members", async () => {
    const fired = await member({ observedCondition: "met", name: "API rate limit" });
    const quiet = await member({ name: "Webhook waiters" });
    const alert = await group([fired, quiet]);
    const claim = await claimAlertForEvaluation(db, {
      id: alert.id,
      now: new Date(),
      leaseMs: 60_000,
    });
    if (!claim.claimed) throw new Error("not claimed");
    const deps = { db, evaluateBinding: groupBinding(), enqueueDelivery: async () => undefined };
    expect((await evaluateAlert(claim.alert, deps)).events).toEqual([]);
    await db.alert.update({ where: { id: alert.id }, data: { nextEvaluationAt: null } });
    const second = await claimAlertForEvaluation(db, {
      id: alert.id,
      now: new Date(),
      leaseMs: 60_000,
    });
    if (!second.claimed) throw new Error("not claimed");
    const outcome = await evaluateAlert(second.alert, deps);
    expect(outcome.events).toEqual(["raised"]);
    expect(outcome.deliveryCount).toBe(1);
    const reading = await getCurrentReading(alert, {
      evaluateBinding: groupBinding(),
      cache: createInMemoryCurrentReadingCache(),
    });
    expect(reading.status === "available" && reading.result.outcome).toBe("met");
  });
});

describe("member notifications", () => {
  const PAST = new Date(Date.now() - 60_000);
  it.each<[string, (groupId: string) => Promise<unknown>, number]>([
    ["active group suppresses", async () => undefined, 0],
    [
      "stopped group does not",
      (id) => db.alert.update({ where: { id }, data: { lifecycle: "stopped" } }),
      1,
    ],
    [
      "expired group does not",
      (id) => db.alert.update({ where: { id }, data: { expiresAt: PAST } }),
      1,
    ],
    ["ungrouped member notifies", (id) => ungroupAlert(db, { ...ENV, groupId: id }, lifecycle), 1],
  ])("%s", async (_name, change, deliveries) => {
    const a = await member();
    const alert = await group([a, await member()]);
    await change(alert.id);
    const { outcome, enqueued } = await evaluate(a.id);
    expect(outcome.events).toEqual(["raised"]);
    expect(outcome.deliveryCount).toBe(deliveries);
    expect(enqueued).toHaveLength(deliveries);
  });
});

describe("group membership changes", () => {
  const actor = { ...ENV, actorId: "user_1" };
  const stop = (id: string) => db.alert.update({ where: { id }, data: { lifecycle: "stopped" } });
  it.each<[string, number, (group: Alert, members: Alert[]) => Promise<unknown>, boolean, number]>([
    [
      "stop group frees members",
      2,
      (g) => performAlertAction(db, { ...actor, intent: "stop", alertId: g.id }, lifecycle),
      true,
      0,
    ],
    [
      "ungroup deletes the group",
      2,
      (g) => performAlertAction(db, { ...actor, intent: "ungroup", alertId: g.id }, lifecycle),
      false,
      0,
    ],
    [
      "delete stopped group",
      2,
      async (g) => {
        await performAlertAction(db, { ...actor, intent: "stop", alertId: g.id }, lifecycle);
        await performAlertAction(db, { ...actor, intent: "delete", alertId: g.id }, lifecycle);
      },
      false,
      0,
    ],
    [
      "delete member of three keeps two",
      3,
      async (_g, [m]) => {
        await stop(m!.id);
        await performAlertAction(db, { ...actor, intent: "delete", alertId: m!.id }, lifecycle);
      },
      true,
      2,
    ],
    [
      "delete member of two dissolves",
      2,
      async (_g, [m]) => {
        await stop(m!.id);
        await performAlertAction(db, { ...actor, intent: "delete", alertId: m!.id }, lifecycle);
      },
      false,
      0,
    ],
    [
      "expired group frees members",
      2,
      async (g) => {
        await db.alert.update({
          where: { id: g.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        await expireAlerts(db, new Date(), { limit: 10 });
      },
      true,
      0,
    ],
    [
      "reactivated group reclaims members",
      2,
      async (g) => {
        await performAlertAction(db, { ...actor, intent: "stop", alertId: g.id }, lifecycle);
        await activateAlert(db, { ...actor, alertId: g.id }, lifecycle);
      },
      true,
      2,
    ],
    [
      "reactivated group prunes a member taken by another group",
      3,
      async (g, [m]) => {
        await performAlertAction(db, { ...actor, intent: "stop", alertId: g.id }, lifecycle);
        await group([m!, await member()]);
        await activateAlert(db, { ...actor, alertId: g.id }, lifecycle);
        const after = await getAlert(db, { id: g.id });
        expect(after?.condition.memberAlertIds).not.toContain(m!.id);
        expect(after?.condition.memberAlertIds).toHaveLength(2);
      },
      true,
      2,
    ],
    [
      "reactivated group is rejected when its members are taken",
      3,
      async (g, [a, b, free]) => {
        await performAlertAction(db, { ...actor, intent: "stop", alertId: g.id }, lifecycle);
        await group([a!, b!]);
        await expect(activateAlert(db, { ...actor, alertId: g.id }, lifecycle)).rejects.toThrow(
          AlertActivationInvalidError
        );
        expect((await getAlert(db, { id: g.id }))?.lifecycle).toBe("stopped");
        expect((await getAlert(db, { id: free!.id }))?.groupId).toBeNull();
      },
      true,
      0,
    ],
  ])("%s", async (_name, size, act, groupKept, grouped) => {
    const members = await Promise.all(Array.from({ length: size }, () => member()));
    const alert = await group(members);
    await act(alert, members);
    expect(!!(await getAlert(db, { id: alert.id }))).toBe(groupKept);
    expect(await db.alert.count({ where: { groupId: alert.id } })).toBe(grouped);
  });

  it("editing a group changes only its own fields", async () => {
    const members = await Promise.all([member({ name: "A" }), member({ name: "B" })]);
    const alert = await group(members);
    const edited = await editAlertGroup(db, {
      ...ENV,
      groupId: alert.id,
      compositeMode: "all",
      name: "Renamed",
    });
    expect(edited?.condition.compositeMode).toBe("all");
    expect(edited?.name).toBe("Renamed");
    const after = await db.alert.findMany({
      where: { groupId: alert.id },
      orderBy: { name: "asc" },
    });
    expect(after.map((m) => m.name)).toEqual(["A", "B"]);
  });

  it("concurrent member removals dissolve the group", async () => {
    const members = await Promise.all([member(), member(), member()]);
    const alert = await group(members);
    await Promise.all(
      members
        .slice(0, 2)
        .map((m) => removeGroupMember(db, { ...ENV, groupId: alert.id, alertId: m.id }, lifecycle))
    );
    expect(await getAlert(db, { id: alert.id })).toBeNull();
    expect(await db.alert.count({ where: { groupId: alert.id } })).toBe(0);
  });
});

describe("createAlertGroup validation", () => {
  it.each<[string, () => Promise<Alert[]>, string]>([
    ["one member", async () => [await member()], "at least 2"],
    [
      "other environment",
      async () => [await member(), await member({ environmentId: "env_2" })],
      "this environment",
    ],
    [
      "already grouped",
      async () => [await member(), await member({ groupId: "grp_x" })],
      "already in a group",
    ],
    [
      "nested group",
      async () => [await member(), await group([await member(), await member()])],
      "another group",
    ],
    [
      "inactive member",
      async () => [await member(), await member({ lifecycle: "stopped" })],
      "active",
    ],
  ])("rejects %s", async (_name, members, message) => {
    const ids = (await members()).map((m) => m.id);
    const result = await createAlertGroup(
      db,
      {
        ...ENV,
        memberAlertIds: ids,
        compositeMode: "any",
        notifiers: [{ type: "channel", channelId: "group_chan" }],
        createdBy: "user_1",
      },
      lifecycle
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });
});
