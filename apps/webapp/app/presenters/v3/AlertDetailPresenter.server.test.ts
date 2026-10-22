import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import type { PrismaClient } from "@trigger.dev/database";
import {
  applyEvaluationOutcome,
  claimAlertsForEvaluation,
  createAlert,
  resolveAlert,
  stopAlert,
} from "~/v3/services/alerts/storage/alertStore.server";
import { startAlertsPostgres } from "../../../test/helpers/alertTables";
import type { NotifierRef } from "@internal/alert-contracts";
import { AlertDetailPresenter } from "./AlertDetailPresenter.server";

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

const MONTH = new Date().toISOString().slice(0, 7);
const YEAR = Number(MONTH.slice(0, 4));
const MON0 = Number(MONTH.slice(5)) - 1;
const BASE = {
  organizationId: "org_detail",
  projectId: "proj_detail",
  environmentId: "env_detail",
  createdBy: "user_detail",
};

async function setCounters(
  alertId: string,
  c: { last_occurrence_at: string; occurrences_since_raise: number; occurrences_total: number }
) {
  await db.$executeRaw`UPDATE "Alert" SET "lastOccurrenceAt" = ${new Date(c.last_occurrence_at)}, "occurrencesSinceRaise" = ${c.occurrences_since_raise}, "occurrencesTotal" = ${c.occurrences_total} WHERE id = ${alertId}`;
}

function presenter(
  overrides?: Partial<{
    resolveChannels: ConstructorParameters<typeof AlertDetailPresenter>[2];
    resolveMemberName: (p: { userId: string; organizationId: string }) => Promise<string | null>;
    resolveQueueFriendlyId: (p: { queue: string; environmentId: string }) => Promise<string | null>;
  }>
) {
  return new AlertDetailPresenter(
    db,
    undefined as any,
    overrides?.resolveChannels ?? (async () => ({ environmentType: null, channels: new Map() })),
    overrides?.resolveMemberName ?? (async () => null),
    overrides?.resolveQueueFriendlyId ?? (async () => null),
    { evaluateBinding: async () => ({ result: { kind: "stateful", outcome: "met", facts: {} } }) }
  );
}

describe("AlertDetailPresenter", () => {
  it("returns null when the alert doesn't exist in this project", async () => {
    const result = await presenter().call({
      id: "does_not_exist",
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result).toBeNull();
  });

  it("orders events newest first", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "queue", queue: "worker-1" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [{ type: "channel", channelId: "chan_1" } satisfies NotifierRef],
      name: "Queue depth high",
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    const claimedAlert = claimed.find((a) => a.id === alert.id)!;

    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimedAlert.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [
        {
          type: "raised",
          at: new Date(`${MONTH}-01T00:00:00Z`),
          facts: { value: 120, threshold: 100 },
        },
      ],
      deliveries: [],
    });

    const secondClaim = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    const secondClaimedAlert = secondClaim.find((a) => a.id === alert.id)!;
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: secondClaimedAlert.evaluationLeaseId,
      patch: { attention: "clear" },
      events: [
        {
          type: "recovered",
          at: new Date(`${MONTH}-02T00:00:00Z`),
          facts: { value: 50, threshold: 100 },
        },
      ],
      deliveries: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.events.map((e) => e.type)).toEqual(["recovered", "raised"]);
    expect(result?.events[0]?.factsSummary).toBe("50 vs 100");
  });

  it("renders a channel notifier's name from ProjectAlertChannel and a chat notifier as 'This chat'", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [
        { type: "channel", channelId: "chan_1" },
        { type: "chat", userId: "user_1" },
      ] satisfies NotifierRef[],
    });

    const result = await presenter({
      resolveChannels: async () => ({
        environmentType: "PRODUCTION",
        channels: new Map([
          [
            "chan_1",
            {
              id: "chan_1",
              name: "Slack #alerts",
              enabled: true,
              type: "SLACK",
              integrationId: "int_1",
              environmentTypes: ["PRODUCTION"],
            },
          ],
        ]),
      }),
    }).call({ id: alert.id, projectId: BASE.projectId, environmentId: BASE.environmentId });

    expect(result?.notifiers).toEqual([
      { key: "channel:chan_1", label: "Slack #alerts" },
      { key: "chat:project:user_1", label: "This chat" },
    ]);
  });

  it("computes displayStatus from lifecycle and attention", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.status).toEqual({ status: "active" });
  });

  it("resolves a queue deep-link's friendlyId for a single-queue scope (REQ-051)", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "queue", queue: "worker-1" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
    });

    const result = await presenter({
      resolveQueueFriendlyId: async ({ queue, environmentId }) =>
        queue === "worker-1" && environmentId === BASE.environmentId ? "queue_abc123" : null,
    }).call({ id: alert.id, projectId: BASE.projectId, environmentId: BASE.environmentId });

    expect(result?.objectLink).toEqual({
      kind: "queue",
      friendlyId: "queue_abc123",
      name: "worker-1",
    });
  });

  it("produces a fingerprint deep-link for an occurrence alert from the latest raised event", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "errors.new_issue",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "occurrence" },
      notifiers: [],
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    const claimedAlert = claimed.find((a) => a.id === alert.id)!;
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimedAlert.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [{ type: "raised", at: new Date(), facts: { fingerprint: "fp_abc" } }],
      deliveries: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.objectLink).toEqual({
      kind: "fingerprint",
      fingerprint: "fp_abc",
      name: "fp_abc",
    });
  });

  it("links an errorGroup-scoped alert to its error and reads snake_case raised facts", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "errors.occurred_again",
      params: {
        environmentId: BASE.environmentId,
        scope: {
          type: "errorGroup",
          taskIdentifier: "sync-inventory",
          fingerprint: "744b415906a201cc",
        },
      },
      condition: { kind: "occurrence" },
      notifiers: [],
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimed.find((a) => a.id === alert.id)!.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [
        {
          type: "raised",
          at: new Date(),
          facts: {
            occurrences: 1,
          },
        },
      ],
      deliveries: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.objectLink).toEqual({
      kind: "fingerprint",
      fingerprint: "744b415906a201cc",
      name: "Error 744b4159 in sync-inventory",
    });
    expect(result?.events[0]).toMatchObject({
      fingerprint: "744b415906a201cc",
      taskIdentifier: "sync-inventory",
    });
  });

  it("reads snake_case raised facts for fingerprint, task and object link", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "errors.new",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "occurrence" },
      notifiers: [],
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimed.find((a) => a.id === alert.id)!.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [
        {
          type: "raised",
          at: new Date(),
          facts: { error_fingerprint: "744b415906a201cc", task_identifier: "sync-inventory" },
        },
      ],
      deliveries: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.events[0]).toMatchObject({
      fingerprint: "744b415906a201cc",
      taskIdentifier: "sync-inventory",
    });
    expect(result?.objectLink).toEqual({
      kind: "fingerprint",
      fingerprint: "744b415906a201cc",
      name: "744b415906a2",
    });
    expect(result?.latestRaisedEventFacts).toMatchObject({
      occurrences: [{ fingerprint: "744b415906a201cc", taskIdentifier: "sync-inventory" }],
    });
  });

  it("exposes the resolved-by member's display name when an alert is resolved", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    const claimedAlert = claimed.find((a) => a.id === alert.id)!;
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimedAlert.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [{ type: "raised", at: new Date(), facts: {} }],
      deliveries: [],
    });
    await resolveAlert(db, { id: alert.id, actorId: "user_resolver" });

    const result = await presenter({
      resolveMemberName: async ({ userId }) => (userId === "user_resolver" ? "Jamie" : null),
    }).call({ id: alert.id, projectId: BASE.projectId, environmentId: BASE.environmentId });

    expect(result?.status).toEqual({ status: "active" });
    expect(result?.resolvedByLabel).toBe("Jamie");
  });

  it("exposes the stopped-by member's display name when an alert is stopped", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
    });

    await stopAlert(db, {
      id: alert.id,
      actorId: "user_stopper",
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    const result = await presenter({
      resolveMemberName: async ({ userId }) => (userId === "user_stopper" ? "Robin" : null),
    }).call({ id: alert.id, projectId: BASE.projectId, environmentId: BASE.environmentId });

    expect(result?.status).toEqual({ status: "inactive", reason: "stopped" });
    expect(result?.stoppedByLabel).toBe("Robin");
  });

  it("error evidence is the raised event's facts; summary comes from the alert columns (REQ-059/061)", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "errors.new_issue",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "occurrence" },
      notifiers: [],
    });

    const claim = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claim.find((a) => a.id === alert.id)!.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [
        { type: "raised", at: new Date(`${MONTH}-01T00:00:00Z`), facts: { fingerprint: "fp_a" } },
      ],
      deliveries: [],
    });
    await setCounters(alert.id, {
      last_occurrence_at: `${MONTH}-01T00:05:00Z`,
      occurrences_since_raise: 5,
      occurrences_total: 7,
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.latestRaisedEventFacts).toEqual({
      occurrences: [
        { fingerprint: "fp_a", taskIdentifier: undefined, at: new Date(`${MONTH}-01T00:00:00Z`) },
      ],
    });
    expect(result?.occurrenceSummary).toEqual({
      lastOccurrenceAt: new Date(`${MONTH}-01T00:05:00Z`),
      countSinceRaise: 5,
    });
    expect(result?.countSinceRaise).toBe(5);
    expect(result?.occurrenceCount).toBe(7);
    expect(result?.lastEventAt).toEqual(new Date(`${MONTH}-01T00:05:00Z`));
  });

  it("scope summary includes the area label", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "queue", queue: "worker-1" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.scopeSummary).toBe("Queues · Queue worker-1");
  });

  it("scope summary for runs with all scope", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "runs.failure_rate",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 600 },
      notifiers: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.scopeSummary).toBe("Runs · All tasks");
  });

  it("curated query capability produces a non-empty compiledQuery", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.compiledQuery).toBeTruthy();
    expect(result?.compiledQuery).toContain("SELECT");
  });

  it("state alert compiledQuery merges declared defaults with condition params", async () => {
    const call = async (params?: Record<string, number>) => {
      const alert = await createAlert(db, {
        ...BASE,
        capabilityKey: "health.execution",
        params: { environmentId: BASE.environmentId, scope: { type: "all" } },
        condition: { kind: "state", stateKey: "unhealthy", ...(params ? { params } : {}) },
        notifiers: [],
      });
      return presenter().call({
        id: alert.id,
        projectId: BASE.projectId,
        environmentId: BASE.environmentId,
      });
    };

    const defaults = await call();
    expect(defaults?.compiledQuery).not.toContain("{{");
    const partial = await call({ failureRatePct: 42 });
    expect(partial?.compiledQuery).toContain("> 42");
    expect(partial?.compiledQuery).not.toContain("{{");
  });

  it("scope summary for queuePattern avoids duplicating the area", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: {
        environmentId: BASE.environmentId,
        scope: { type: "queuePattern", pattern: "worker-*" },
      },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.scopeSummary).toBe("Queues · Matching worker-*");
  });

  it("stored alert.query is returned verbatim in compiledQuery", async () => {
    const customSql = "SELECT count() FROM runs WHERE status = 'FAILED'";
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      notifiers: [],
      query: customSql,
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.compiledQuery).toBe(customSql);
  });

  it("compiles the stored checkpoint into a ctx capability's compiledQuery", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "errors.new",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "occurrence" },
      notifiers: [],
    });
    const evaluatorState = { checkpoint: "2020-01-02T03:04:05.000Z" };
    await db.$executeRaw`UPDATE "Alert" SET "evaluatorState" = ${JSON.stringify(evaluatorState)}::jsonb WHERE id = ${alert.id}`;

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.compiledQuery).toContain("'2020-01-02 03:04:05'");
    expect(result?.compiledQuery).not.toContain("{{ctx.");
  });

  it("exposes factsComponents for a composite (health.all) alert from the latest raised event", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "state", stateKey: "health" },
      notifiers: [],
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    const claimedAlert = claimed.find((a) => a.id === alert.id)!;
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimedAlert.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [
        {
          type: "raised",
          at: new Date(),
          facts: {
            components: {
              flow: {
                outcome: "met",
                effectiveParams: { schedulingDelayMs: 30000, backlogCount: 1000 },
              },
              execution: {
                outcome: "not_met",
                effectiveParams: { failureRatePct: 10, durationP95Ms: 300000 },
              },
              liveness: { outcome: "unavailable", effectiveParams: { silenceSec: 300 } },
            },
          },
        },
      ],
      deliveries: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.factsComponents).toEqual({
      flow: { outcome: "met", effectiveParams: { schedulingDelayMs: 30000, backlogCount: 1000 } },
      execution: {
        outcome: "not_met",
        effectiveParams: { failureRatePct: 10, durationP95Ms: 300000 },
      },
      liveness: { outcome: "unavailable", effectiveParams: { silenceSec: 300 } },
    });
    expect(result?.effectiveParams.length).toBeGreaterThan(0);
    expect(result?.effectiveParams.find((p) => p.key === "schedulingDelayMs")?.label).toBe(
      "Scheduling delay p95"
    );
  });

  it("prefers live currentReading components over null from legacy events", async () => {
    const liveComponents = {
      flow: { outcome: "met", effectiveParams: { schedulingDelayMs: 30000, backlogCount: 1000 } },
      execution: {
        outcome: "not_met",
        effectiveParams: { failureRatePct: 10, durationP95Ms: 300000 },
      },
      liveness: { outcome: "unavailable", effectiveParams: { silenceSec: 300 } },
    };

    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "state", stateKey: "health" },
      notifiers: [],
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    const claimedAlert = claimed.find((a) => a.id === alert.id)!;
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimedAlert.evaluationLeaseId,
      patch: { attention: "needs_attention" },
      events: [{ type: "raised", at: new Date(), facts: { findings: ["legacy shape"] } }],
      deliveries: [],
    });

    const result = await new AlertDetailPresenter(
      db,
      undefined as any,
      async () => ({ environmentType: null, channels: new Map() }),
      async () => null,
      async () => null,
      {
        evaluateBinding: async () => ({
          result: { kind: "stateful", outcome: "met", facts: { components: liveComponents } },
        }),
      }
    ).call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.factsComponents).toEqual(liveComponents);
  });

  it("falls back to evaluatorState.lastComponents when events have no components", async () => {
    const lastComponents = {
      flow: {
        outcome: "not_met",
        effectiveParams: { schedulingDelayMs: 30000, backlogCount: 1000 },
      },
      execution: {
        outcome: "met",
        effectiveParams: { failureRatePct: 10, durationP95Ms: 300000 },
      },
      liveness: { outcome: "unavailable", effectiveParams: { silenceSec: 300 } },
    };

    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: { kind: "state", stateKey: "health" },
      notifiers: [],
    });

    const claimed = await claimAlertsForEvaluation(db, {
      now: new Date(),
      leaseMs: 60_000,
      limit: 10,
    });
    const claimedAlert = claimed.find((a) => a.id === alert.id)!;
    await applyEvaluationOutcome(db, {
      alertId: alert.id,
      leaseId: claimedAlert.evaluationLeaseId,
      patch: {
        evaluatorState: { lastComponents, observedAt: new Date().toISOString() },
      },
      events: [],
      deliveries: [],
    });

    const result = await new AlertDetailPresenter(
      db,
      undefined as any,
      async () => ({ environmentType: null, channels: new Map() }),
      async () => null,
      async () => null,
      {
        evaluateBinding: async () => ({
          result: { kind: "stateful", outcome: "not_met", facts: {} },
        }),
      }
    ).call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.factsComponents).toEqual(lastComponents);
  });

  it("returns null factsComponents for a non-composite state alert", async () => {
    const alert = await createAlert(db, {
      ...BASE,
      capabilityKey: "health.flow",
      params: { environmentId: BASE.environmentId, scope: { type: "all" } },
      condition: {
        kind: "state",
        stateKey: "health",
        params: { schedulingDelayMs: 30000, backlogCount: 1000 },
      },
      notifiers: [],
    });

    const result = await presenter().call({
      id: alert.id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    expect(result?.factsComponents).toBeNull();
  });

  describe("detail page display fields", () => {
    const query = (id: string) => ({
      id,
      projectId: BASE.projectId,
      environmentId: BASE.environmentId,
    });

    async function seed(
      events: Array<{ type: "raised" | "recovered" | "resolved"; facts?: any }>,
      extra: Record<string, unknown> = {}
    ) {
      const alert = await createAlert(db, {
        ...BASE,
        capabilityKey: "errors.new_issue",
        params: { environmentId: BASE.environmentId, scope: { type: "all" } },
        condition: { kind: "occurrence" },
        notifiers: [],
        ...extra,
      });
      if (events.length === 0) return alert;
      const claimed = await claimAlertsForEvaluation(db, {
        now: new Date(),
        leaseMs: 60_000,
        limit: 100,
      });
      const claimedAlert = claimed.find((a) => a.id === alert.id)!;
      await applyEvaluationOutcome(db, {
        alertId: alert.id,
        leaseId: claimedAlert.evaluationLeaseId,
        patch: { attention: "needs_attention" },
        events: events.map((e, i) => ({
          type: e.type,
          at: new Date(Date.UTC(YEAR, MON0, 1 + i)),
          facts: e.facts ?? {},
        })),
        deliveries: [],
      });
      return alert;
    }

    it("occurrenceCount and countSinceRaise come from the alert columns", async () => {
      const alert = await seed([{ type: "raised" }, { type: "resolved" }]);
      await setCounters(alert.id, {
        last_occurrence_at: `${MONTH}-01T00:00:00Z`,
        occurrences_since_raise: 2,
        occurrences_total: 9,
      });
      const result = await presenter().call(query(alert.id));
      expect(result?.events).toHaveLength(2);
      expect(result?.occurrenceCount).toBe(9);
      expect(result?.countSinceRaise).toBe(2);
    });

    it("eventsWindow limits the activity events, not the episode count", async () => {
      const alert = await seed([{ type: "raised" }, { type: "recovered" }, { type: "raised" }]);
      await setCounters(alert.id, {
        last_occurrence_at: `${MONTH}-03T00:00:00Z`,
        occurrences_since_raise: 3,
        occurrences_total: 3,
      });
      const result = await presenter().call({
        ...query(alert.id),
        eventsWindow: {
          since: new Date(Date.UTC(YEAR, MON0, 2)),
          until: new Date(Date.UTC(YEAR, MON0, 2)),
        },
      });
      expect(result?.events.map((e) => e.at.toISOString())).toEqual([`${MONTH}-02T00:00:00.000Z`]);
      expect(result?.countSinceRaise).toBe(3);
      expect(result?.firstEventAt?.toISOString()).toBe(`${MONTH}-01T00:00:00.000Z`);
      expect(result?.lastEventAt?.toISOString()).toBe(`${MONTH}-03T00:00:00.000Z`);
    });

    it("behaviorLabel reads like the prototype", async () => {
      const alert = await seed([]);
      const result = await presenter().call(query(alert.id));
      expect(result?.behaviorLabel).toBe("Recurring");
    });

    it("behavior expiry uses the formatted form, not an ISO string", async () => {
      const alert = await seed([], { expiresAt: new Date(Date.now() + 3 * 86_400_000) });
      const result = await presenter().call(query(alert.id));
      expect(result?.behaviorSummary).toMatch(/^Recurring, expires in /);
      expect(result?.behaviorSummary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it("occurrence events fall back to scalar facts", async () => {
      const alert = await seed([
        { type: "raised", facts: { deployId: "deploy_seed_1", nested: { a: 1 } } },
      ]);
      const result = await presenter().call(query(alert.id));
      expect(result!.events[0]!.factsSummary).toBe("deployId: deploy_seed_1");
    });

    it("threshold events use the configured threshold when facts lack one", async () => {
      const alert = await seed([{ type: "raised", facts: { value: 90 } }], {
        capabilityKey: "queue.depth",
        condition: { kind: "threshold", operator: ">", value: 80, windowSec: 300 },
      });
      const result = await presenter().call(query(alert.id));
      expect(result!.events[0]!.factsSummary).toBe("90 vs 80");
    });

    it("state alerts report their condition state instead of a number", async () => {
      const alert = await seed([{ type: "raised" }, { type: "recovered" }], {
        capabilityKey: "health.flow",
        condition: {
          kind: "state",
          stateKey: "health",
          params: { schedulingDelayMs: 30000, backlogCount: 1000 },
        },
      });
      const statePresenter = new AlertDetailPresenter(
        db,
        undefined as any,
        async () => ({ environmentType: null, channels: new Map() }),
        async () => null,
        async () => null,
        {
          evaluateBinding: async () => ({
            result: { kind: "stateful", outcome: "met", facts: { value: 1, unit: "count" } },
          }),
        }
      );
      const result = await statePresenter.call(query(alert.id));
      expect(result!.reading).toMatchObject({ kind: "state", state: "met" });
    });

    it("a stale live reading reports no data with the last raised value", async () => {
      const alert = await seed([{ type: "raised", facts: { value: 142 } }], {
        capabilityKey: "queue.depth",
        condition: { kind: "threshold", operator: ">", value: 80, windowSec: 300 },
      });
      const stalePresenter = new AlertDetailPresenter(
        db,
        undefined as any,
        async () => ({ environmentType: null, channels: new Map() }),
        async () => null,
        async () => null,
        {
          evaluateBinding: async () => ({
            result: {
              kind: "stateful",
              outcome: "unavailable",
              facts: { value: null, unavailableReason: "stale_beyond_horizon" },
            },
          }),
        }
      );
      const result = await stalePresenter.call(query(alert.id));
      expect(result!.reading).toMatchObject({
        kind: "noData",
        reason: "stale_beyond_horizon",
        windowSec: 300,
        lastRaised: { value: 142 },
      });
    });

    it("a live low-volume reading explains itself instead of returning null", async () => {
      const alert = await seed([{ type: "raised" }], {
        capabilityKey: "queue.depth",
        condition: { kind: "threshold", operator: ">", value: 80, windowSec: 600 },
      });
      const lowPresenter = new AlertDetailPresenter(
        db,
        undefined as any,
        async () => ({ environmentType: null, channels: new Map() }),
        async () => null,
        async () => null,
        {
          evaluateBinding: async () => ({
            result: {
              kind: "stateful",
              outcome: "not_met",
              facts: { value: 1, total: 4, lowVolume: true },
            },
          }),
        }
      );
      const result = await lowPresenter.call(query(alert.id));
      expect(result!.reading).toEqual({ kind: "lowVolume", total: 4, windowSec: 600 });
    });

    it("threshold events without a value print no scalar dump", async () => {
      const alert = await seed(
        [
          {
            type: "recovered",
            facts: { unit: "percent", total: 0, threshold: 20, windowSec: 600 },
          },
        ],
        {
          capabilityKey: "queue.depth",
          condition: { kind: "threshold", operator: ">", value: 20, windowSec: 600 },
        }
      );
      const result = await presenter().call(query(alert.id));
      expect(result!.events[0]!.factsSummary).toBe("No data");
    });

    it("composite event summary lists component outcomes", async () => {
      const alert = await seed([
        {
          type: "raised",
          facts: {
            components: {
              flow: { outcome: "met", effectiveParams: { a: 1, b: 2 } },
              execution: { outcome: "not_met", effectiveParams: { c: 3 } },
            },
            effectiveParams: { x: 1 },
          },
        },
        { type: "recovered", facts: { value: 91, threshold: 80, unit: "percent" } },
      ]);
      const result = await presenter().call(query(alert.id));
      expect(result!.events[1]!.factsSummary).toBe("flow met, execution not met");
      expect(result!.events[0]!.factsSummary).toBe("91% vs 80%");
    });

    it("state events print no raw 0/1 and absence events print the quiet window", async () => {
      const state = await seed(
        [{ type: "raised", facts: { value: 1, unit: "count", windowSec: 300 } }],
        {
          capabilityKey: "health.flow",
          condition: {
            kind: "state",
            stateKey: "health",
            params: { schedulingDelayMs: 30000, backlogCount: 1000 },
          },
        }
      );
      const absence = await seed(
        [{ type: "raised", facts: { value: 0, unit: "count", windowSec: 1800 } }],
        { condition: { kind: "absence", quietWindowSec: 1800 } }
      );
      expect((await presenter().call(query(state.id)))!.events[0]!.factsSummary).toBe("");
      expect((await presenter().call(query(absence.id)))!.events[0]!.factsSummary).toBe(
        "No events in 30m"
      );
    });

    it("occurrenceCount is exact beyond the 50-event page", async () => {
      const alert = await seed(Array.from({ length: 60 }, () => ({ type: "raised" as const })));
      await setCounters(alert.id, {
        last_occurrence_at: `${MONTH}-01T00:00:00Z`,
        occurrences_since_raise: 1,
        occurrences_total: 60,
      });
      const result = await presenter().call(query(alert.id));
      expect(result!.events).toHaveLength(50);
      expect(result!.occurrenceCount).toBe(60);
    });

    const stateAlert = {
      capabilityKey: "health.all",
      condition: { kind: "state", stateKey: "health" },
    };

    it("a raise then recovery is one recovered episode with a Healthy state", async () => {
      const alert = await seed([{ type: "raised" }, { type: "recovered" }], stateAlert);
      const result = await presenter().call(query(alert.id));
      expect(result?.episode.outcome).toBe("recovered");
      expect(result?.episode.recoveredAt).toEqual(new Date(Date.UTC(YEAR, MON0, 2)));
      expect(result?.stateOutcome).toBe("not_met");
    });

    it("an old raise with a recent recovery stays recovered under a 7d eventsWindow", async () => {
      const alert = await createAlert(db, {
        ...BASE,
        ...stateAlert,
        params: { environmentId: BASE.environmentId, scope: { type: "all" } },
        notifiers: [],
      });
      const claimed = await claimAlertsForEvaluation(db, {
        now: new Date(),
        leaseMs: 60_000,
        limit: 100,
      });
      const now = Date.now();
      await applyEvaluationOutcome(db, {
        alertId: alert.id,
        leaseId: claimed.find((a) => a.id === alert.id)!.evaluationLeaseId,
        patch: { attention: "needs_attention" },
        events: [
          { type: "raised", at: new Date(now - 40 * 86_400_000), facts: {} },
          { type: "recovered", at: new Date(now - 15 * 3_600_000), facts: {} },
        ],
        deliveries: [],
      });
      const result = await presenter().call({
        ...query(alert.id),
        eventsWindow: { since: new Date(now - 7 * 86_400_000), until: new Date(now) },
      });
      expect(result?.events.map((e) => e.type)).toEqual(["recovered"]);
      expect(result?.episode.outcome).toBe("recovered");
      expect(result?.firstEventAt?.getTime()).toBe(now - 40 * 86_400_000);
    });

    it("a raise after a recovery is a raised episode with a Degraded state", async () => {
      const alert = await seed(
        [{ type: "raised" }, { type: "recovered" }, { type: "raised" }],
        stateAlert
      );
      const result = await presenter().call(query(alert.id));
      expect(result?.episode).toEqual({
        raisedAt: new Date(Date.UTC(YEAR, MON0, 3)),
        recoveredAt: null,
        outcome: "raised",
      });
      expect(result?.stateOutcome).toBe("met");
    });

    it("a recovery is void once the condition is met again without a new raise", async () => {
      const alert = await seed([{ type: "raised" }, { type: "recovered" }], stateAlert);
      const claimed = await claimAlertsForEvaluation(db, {
        now: new Date(),
        leaseMs: 60_000,
        limit: 100,
      });
      await applyEvaluationOutcome(db, {
        alertId: alert.id,
        leaseId: claimed.find((a) => a.id === alert.id)!.evaluationLeaseId,
        patch: { observedCondition: "met" },
        events: [],
        deliveries: [],
      });
      const result = await presenter().call(query(alert.id));
      expect(result?.episode.outcome).toBe("raised");
      expect(result?.episode.recoveredAt).toBeNull();
      expect(result?.stateOutcome).toBe("met");
    });

    it("a re-activated healthy alert ignores its old raise and uses the live reading", async () => {
      const alert = await seed([{ type: "raised" }], stateAlert);
      const claimed = await claimAlertsForEvaluation(db, {
        now: new Date(),
        leaseMs: 60_000,
        limit: 100,
      });
      await applyEvaluationOutcome(db, {
        alertId: alert.id,
        leaseId: claimed.find((a) => a.id === alert.id)!.evaluationLeaseId,
        patch: { attention: "clear", observedCondition: "not_met" },
        events: [],
        deliveries: [],
      });
      const result = await new AlertDetailPresenter(
        db,
        undefined as any,
        async () => ({ environmentType: null, channels: new Map() }),
        async () => null,
        async () => null,
        {
          evaluateBinding: async () => ({
            result: { kind: "stateful", outcome: "not_met", facts: {} },
          }),
        }
      ).call(query(alert.id));
      expect(result?.episode.outcome).toBeNull();
      expect(result?.stateOutcome).toBe("not_met");
    });

    it("the episode uses the exact latest raise beyond the 50-event page", async () => {
      const alert = await seed([
        { type: "raised" },
        ...Array.from({ length: 60 }, () => ({ type: "resolved" as const })),
      ]);
      const result = await presenter().call(query(alert.id));
      expect(result!.events).toHaveLength(50);
      expect(result!.episode.raisedAt).toEqual(new Date(Date.UTC(YEAR, MON0, 1)));
      expect(result!.episode.outcome).toBe("raised");
    });

    it("exposes expiresAt for the activate flow", async () => {
      const expiresAt = new Date(Date.now() - 1000);
      const expired = await seed([], { expiresAt });
      const open = await seed([]);
      expect((await presenter().call(query(expired.id)))?.expiresAt).toEqual(expiresAt);
      expect((await presenter().call(query(open.id)))?.expiresAt).toBeNull();
    });
  });
});
