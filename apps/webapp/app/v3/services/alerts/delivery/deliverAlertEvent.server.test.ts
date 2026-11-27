import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import type { PrismaClient } from "@trigger.dev/database";
import {
  ensureAlertPartitions,
  rawSqlClient,
  startAlertsPostgres,
} from "../../../../../test/helpers/alertTables";
import {
  type AlertDelivery,
  createAlert,
  applyEvaluationOutcome,
  claimDelivery,
  findStalePendingDeliveries,
  listPendingDeliveriesForEvent,
} from "../storage/alertStore.server";
import { deliverAlertEvent, type DeliverAlertEventDeps } from "./deliverAlertEvent.server";
import { DeliverAlertEventPayload } from "./deliverAlertEventPayload";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { ErrorCode } from "@slack/web-api";
import { deliverWebhookPayload, SkipRetryError, toSlackSendError } from "../alertTransport.server";
import { enqueueAlertEventDelivery } from "./enqueueAlertEventDelivery.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { encryptSecret } from "~/services/secrets/secretStore.server";
import { resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import type { NotifierRef } from "@internal/alert-contracts";

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

async function deliveriesForEvent(alertEventId: string) {
  const rows = await db.alertDelivery.findMany({ where: { alertEventId } });
  return rows as unknown as AlertDelivery[];
}

const BASE_ALERT = {
  organizationId: "org_test",
  projectId: "proj_test",
  environmentId: "env_test",
  capabilityKey: "queue.depth",
  params: { queue: "worker-1" } as Record<string, unknown>,
  condition: { operator: ">", value: 100 } as Record<string, unknown>,
  createdBy: "user_test",
  name: "Queue depth high",
};

const BASE_NOTIFIERS: NotifierRef[] = [
  { type: "channel", channelId: "chan_slack" },
  { type: "channel", channelId: "chan_email" },
];

async function seedAlertWithLease(opts?: {
  notifiers?: NotifierRef[];
  facts?: Record<string, unknown>;
  eventType?: "raised" | "recovered";
}) {
  const notifiers = opts?.notifiers ?? BASE_NOTIFIERS;
  const alert = await createAlert(db, {
    ...BASE_ALERT,
    notifiers,
  });

  const leaseId = "test-lease";
  await rawSql`UPDATE "Alert" SET "evaluationLeaseId" = ${leaseId} WHERE id = ${alert.id}`;

  const outcome = await applyEvaluationOutcome(db, {
    alertId: alert.id,
    leaseId,
    patch: { attention: "needs_attention", observedCondition: "met" },
    events: [
      {
        type: opts?.eventType ?? "raised",
        at: new Date(),
        facts: opts?.facts ?? { queueDepth: 142, threshold: 100 },
      },
    ],
    deliveries: notifiers.map((notifier) => ({
      alertEventIndex: 0,
      notifier,
    })),
  });

  return { alert, event: outcome.events[0]!, deliveries: outcome.deliveries };
}

function mockChannel(
  id: string,
  type: "EMAIL" | "SLACK" | "WEBHOOK",
  projectId = "proj_test",
  enabled = true
) {
  const props: Record<string, unknown> = {};
  if (type === "EMAIL") props.email = "test@example.com";
  if (type === "SLACK") {
    props.channelId = "C123";
    props.channelName = "#alerts";
    props.integrationId = "int_1";
  }
  if (type === "WEBHOOK") {
    props.url = "https://example.com/webhook";
    props.secret = { encrypted: "secret123", nonce: "abc" };
  }
  return { id, type, enabled, properties: props, projectId };
}

function makeDeps(overrides?: Partial<Omit<DeliverAlertEventDeps, "db">>): DeliverAlertEventDeps {
  return {
    db,
    sendSlackMessage: overrides?.sendSlackMessage ?? vi.fn().mockResolvedValue({ ts: "ts_123" }),
    deliverWebhook: overrides?.deliverWebhook ?? vi.fn().mockResolvedValue(new Response("ok")),
    sendEmail: overrides?.sendEmail ?? vi.fn().mockResolvedValue(undefined),
    findSlackIntegration: overrides?.findSlackIntegration ?? vi.fn().mockResolvedValue(null),
    findChannel: overrides?.findChannel ?? vi.fn().mockResolvedValue(null),
    checkRateLimit: overrides?.checkRateLimit ?? vi.fn().mockResolvedValue({ allowed: true }),
    loadAlertContext: overrides?.loadAlertContext ?? vi.fn().mockResolvedValue(ALERT_CONTEXT),
    isOrganizationEnabled: overrides?.isOrganizationEnabled ?? vi.fn().mockResolvedValue(true),
    retryCap: overrides?.retryCap,
    scheduleRetry: overrides?.scheduleRetry ?? vi.fn().mockResolvedValue(undefined),
    random: overrides?.random,
  };
}

const ALERT_CONTEXT = {
  organization: { slug: "acme", title: "Acme Inc" },
  project: { slug: "billing-abc", name: "Billing Worker" },
  environment: { slug: "prod", name: "Prod" },
};

async function resetAlerts() {
  await rawSql`DELETE FROM "AlertDelivery"`;
  await rawSql`DELETE FROM "AlertEvent"`;
  await rawSql`DELETE FROM "Alert"`;
}

describe("deliverAlertEvent", () => {
  beforeEach(async () => {
    await resetAlerts();
  });

  it("delivers to email and slack independently; slack failure marks that row failed", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [
        { type: "channel", channelId: "chan_slack" },
        { type: "channel", channelId: "chan_email" },
      ],
    });

    const findChannel = vi.fn().mockImplementation(async ({ id }: { id: string }) => {
      if (id === "chan_slack") return mockChannel("chan_slack", "SLACK");
      if (id === "chan_email") return mockChannel("chan_email", "EMAIL");
      return null;
    });

    const sendSlack = vi.fn().mockRejectedValue(new SkipRetryError("Slack: account_inactive"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({ findChannel, sendSlackMessage: sendSlack, sendEmail });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(sendEmail).toHaveBeenCalledTimes(1);

    const remaining = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(remaining).toHaveLength(0);
  });

  it("releases claim and rethrows on retryable error", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });

    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const sendEmail = vi.fn().mockRejectedValue(new Error("SMTP timeout"));
    const deps = makeDeps({ findChannel, sendEmail });

    const error = (await deliverAlertEvent(event.id, event.at, deps).catch(
      (e) => e
    )) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]).toEqual(expect.objectContaining({ message: "SMTP timeout" }));
    expect(error.message).toBe("1 deliveries failed: EMAIL: Error");

    const pending = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
  });

  it("reports a failure by class name and safe code only, never its message", async () => {
    const nullPrototype = Object.create(null);
    const throwingCode = Object.defineProperty(new TypeError("x"), "code", {
      get() {
        throw new Error("boom");
      },
    });
    const cases: [unknown, string][] = [
      [new Error("550 5.1.1 <o'brien@customer.example>: rejected"), "Error"],
      [Object.assign(new Error("x"), { reason: "customer_identifier" }), "Error"],
      [Object.assign(new TypeError("x"), { code: "P2024" }), "TypeError P2024"],
      [Object.assign(new TypeError("x"), { code: "abc123" }), "TypeError"],
      [Object.assign(new TypeError("x"), { code: "internalhost" }), "TypeError"],
      [throwingCode, "unknown"],
      [
        Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
        "TypeError ECONNREFUSED",
      ],
      [new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } }), "TypeError ETIMEDOUT"],
      [Object.assign(new TypeError("fetch failed"), { code: "not a code" }), "TypeError"],
      [Object.assign(new TypeError("fetch failed"), { code: "jane@corp.example" }), "TypeError"],
      [Object.assign(new TypeError("fetch failed"), { code: "E".repeat(200) }), "TypeError"],
      ["rejected jane@corp.example", "unknown"],
      [undefined, "unknown"],
      [{ message: 42 }, "unknown"],
      [nullPrototype, "unknown"],
    ];

    for (const [thrown, reason] of cases) {
      await resetAlerts();
      const { event } = await seedAlertWithLease({
        notifiers: [
          { type: "channel", channelId: "chan_email" },
          { type: "channel", channelId: "chan_email_2" },
        ],
      });
      const findChannel = vi
        .fn()
        .mockImplementation(async ({ id }: { id: string }) => mockChannel(id, "EMAIL"));
      const sendEmail = vi.fn().mockRejectedValueOnce(thrown).mockResolvedValue(undefined);

      const error = (await deliverAlertEvent(
        event.id,
        event.at,
        makeDeps({ findChannel, sendEmail })
      ).catch((e) => e)) as AggregateError;

      expect(error.message).toBe(`1 deliveries failed: EMAIL: ${reason}`);
      expect(error.errors[0]).toBe(thrown);
      expect(sendEmail).toHaveBeenCalledTimes(2);
    }
  });

  it("reports a retryable webhook HTTP failure by status, without the host", async () => {
    const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_webhook" }],
    });
    const findChannel = vi.fn().mockResolvedValue({
      ...mockChannel("chan_webhook", "WEBHOOK"),
      properties: {
        url: "https://hooks.customer.example/alerts",
        secret: await encryptSecret(keyring, "whsec_test"),
      },
    });
    const deliverWebhook: DeliverAlertEventDeps["deliverWebhook"] = (params) =>
      deliverWebhookPayload({
        ...params,
        encryptionKey: keyring,
        fetchWebhook: vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
      });

    const error = (await deliverAlertEvent(
      event.id,
      event.at,
      makeDeps({ findChannel, deliverWebhook })
    ).catch((e) => e)) as AggregateError;

    expect(error.message).toBe("1 deliveries failed: WEBHOOK: http_500");
    expect(error.errors[0].message).toBe("Failed to send alert webhook to hooks.customer.example");
  });

  it("reports a retryable Slack failure by its code or label", async () => {
    const slackError = (code: ErrorCode, extra: Record<string, unknown> = {}) =>
      Object.assign(new Error("An API error occurred"), { code, ...extra });
    const cases: [unknown, string][] = [
      [
        slackError(ErrorCode.PlatformError, { data: { ok: false, error: "ratelimited" } }),
        "ratelimited",
      ],
      [slackError(ErrorCode.RateLimitedError, { retryAfter: 30 }), "rate_limited"],
      [slackError(ErrorCode.HTTPError, { statusCode: 503 }), "http_error"],
      [slackError(ErrorCode.RequestError), "request_error"],
    ];

    for (const [sdkError, reason] of cases) {
      await resetAlerts();
      const { event } = await seedAlertWithLease({
        notifiers: [{ type: "channel", channelId: "chan_slack" }],
      });

      const error = (await deliverAlertEvent(
        event.id,
        event.at,
        makeDeps({
          findChannel: vi.fn().mockResolvedValue(mockChannel("chan_slack", "SLACK")),
          findSlackIntegration: vi.fn().mockResolvedValue({ id: "int_1" } as any),
          sendSlackMessage: async () => {
            throw toSlackSendError(sdkError);
          },
        })
      ).catch((e) => e)) as AggregateError;

      expect(error.message).toBe(`1 deliveries failed: SLACK: ${reason}`);
    }
  });

  it("enqueues the delivery job with the given availableAt", async () => {
    const eventAt = new Date("2026-01-01T00:00:00Z");
    const availableAt = new Date("2026-01-01T00:01:00Z");
    const enqueue = vi.mocked(alertsWorker.enqueue);
    enqueue.mockClear();

    await enqueueAlertEventDelivery({ eventId: "evt_1", eventAt, availableAt });
    await enqueueAlertEventDelivery({ eventId: "evt_2", eventAt });

    expect(enqueue.mock.calls).toEqual([
      [
        {
          id: "alert-event:evt_1",
          job: "v3.deliverAlertEvent",
          payload: { eventId: "evt_1", eventAt },
          availableAt,
        },
      ],
      [
        {
          id: "alert-event:evt_2",
          job: "v3.deliverAlertEvent",
          payload: { eventId: "evt_2", eventAt },
          availableAt: undefined,
        },
      ],
    ]);
  });

  it("a retryable failure on one notifier does not stop delivery to the others", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [
        { type: "channel", channelId: "chan_email" },
        { type: "channel", channelId: "chan_slack" },
      ],
    });

    const findChannel = vi.fn().mockImplementation(async ({ id }: { id: string }) => {
      if (id === "chan_email") return mockChannel("chan_email", "EMAIL");
      if (id === "chan_slack") return mockChannel("chan_slack", "SLACK");
      return null;
    });
    const sendEmail = vi.fn().mockRejectedValue(new Error("SMTP timeout"));
    const sendSlack = vi.fn().mockResolvedValue({ ts: "ts_1" });
    const findSlackIntegration = vi.fn().mockResolvedValue({ id: "int_1" } as any);
    const deps = makeDeps({
      findChannel,
      sendEmail,
      sendSlackMessage: sendSlack,
      findSlackIntegration,
    });

    const error = (await deliverAlertEvent(event.id, event.at, deps).catch(
      (e) => e
    )) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(sendSlack).toHaveBeenCalledTimes(1);

    const pending = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.notifierId).toBe("channel:chan_email");
  });

  it("reclaims stale delivery after 5 minutes", async () => {
    const { event, deliveries } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });

    const delivery = deliveries[0]!;
    const staleClaim = await claimDelivery(db, {
      id: delivery.id,
      eventAt: event.at,
      claimId: "old-claim",
      staleBefore: new Date(0),
      cap: { maxAttempts: 10, maxAgeMs: 24 * 60 * 60_000 },
    });
    expect(staleClaim).not.toBeNull();

    await rawSql`UPDATE "AlertDelivery" SET "claimedAt" = NOW() - INTERVAL '6 minutes' WHERE id = ${delivery.id}`;

    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ findChannel, sendEmail });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("marks delivery failed when channel is missing", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_deleted" }],
    });

    const findChannel = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({ findChannel });
    await deliverAlertEvent(event.id, event.at, deps);

    const pending = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(pending).toHaveLength(0);
  });

  it("marks delivery failed when channel is disabled", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_disabled" }],
    });

    const findChannel = vi
      .fn()
      .mockResolvedValue(mockChannel("chan_disabled", "EMAIL", "proj_test", false));
    const deps = makeDeps({ findChannel });
    await deliverAlertEvent(event.id, event.at, deps);

    const pending = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(pending).toHaveLength(0);
  });

  it("renders payload from frozen facts only", async () => {
    const frozenFacts = { queueDepth: 142, threshold: 100 };
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
      facts: frozenFacts,
    });

    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ findChannel, sendEmail });
    await deliverAlertEvent(event.id, event.at, deps);

    const emailCall = sendEmail.mock.calls[0]![0];
    expect(emailCall.facts).toEqual(
      expect.arrayContaining([
        { label: "Queue Depth", value: "142" },
        { label: "Threshold", value: "100" },
      ])
    );
    expect(emailCall.facts).toHaveLength(2);
  });

  it("email links to the alert page and shows names, loading context once", async () => {
    const { alert, event } = await seedAlertWithLease({
      notifiers: [
        { type: "channel", channelId: "chan_email" },
        { type: "channel", channelId: "chan_email_2" },
      ],
    });

    const findChannel = vi
      .fn()
      .mockImplementation(async ({ id }: { id: string }) => mockChannel(id, "EMAIL"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const loadAlertContext = vi.fn().mockResolvedValue(ALERT_CONTEXT);
    await deliverAlertEvent(
      event.id,
      event.at,
      makeDeps({ findChannel, sendEmail, loadAlertContext })
    );

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(loadAlertContext).toHaveBeenCalledTimes(1);
    const emailCall = sendEmail.mock.calls[0]![0];
    expect(emailCall.dashboardLink).toBe(
      `${env.APP_ORIGIN}/orgs/acme/projects/billing-abc/env/prod/alerts/${alert.id}`
    );
    expect(emailCall).toMatchObject({
      organization: "Acme Inc",
      project: "Billing Worker",
      environment: "Prod",
    });
  });

  async function deliverRateLimited(opts: {
    eventId: string;
    eventAt: Date;
    retryAfter: number;
    random?: () => number;
    retryCap?: DeliverAlertEventDeps["retryCap"];
  }) {
    const scheduleRetry = vi.fn().mockResolvedValue(undefined);
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const before = Date.now();
    await deliverAlertEvent(
      opts.eventId,
      opts.eventAt,
      makeDeps({
        findChannel: vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL")),
        sendEmail,
        checkRateLimit: vi.fn().mockResolvedValue({ allowed: false, retryAfter: opts.retryAfter }),
        scheduleRetry,
        random: opts.random,
        retryCap: opts.retryCap,
      })
    );
    const delays = scheduleRetry.mock.calls.map(([at]: [Date]) => ({
      min: at.getTime() - Date.now(),
      max: at.getTime() - before,
    }));
    return { scheduleRetry, sendEmail, delays };
  }

  it("a rate-limited delivery is rescheduled after retryAfter, not failed", async () => {
    const { event, deliveries } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });

    const { scheduleRetry, sendEmail, delays } = await deliverRateLimited({
      eventId: event.id,
      eventAt: event.at,
      retryAfter: 20_000,
      random: () => 0.999,
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    expect(delays[0]!.max).toBeGreaterThanOrEqual(20_000 + 4995);
    expect(delays[0]!.min).toBeLessThan(25_000);
    const [row] = await rawSql<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM "AlertDelivery" WHERE id = ${deliveries[0]!.id}`;
    expect(row).toEqual({ status: "pending", attempts: 0 });
  });

  it("throws only real errors and does not reschedule when a delivery also failed", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [
        { type: "channel", channelId: "chan_email" },
        { type: "channel", channelId: "chan_slack" },
        { type: "channel", channelId: "chan_webhook" },
      ],
    });

    const findChannel = vi.fn().mockImplementation(async ({ id }: { id: string }) => {
      if (id === "chan_email") return mockChannel("chan_email", "EMAIL");
      if (id === "chan_slack") return mockChannel("chan_slack", "SLACK");
      return mockChannel("chan_webhook", "WEBHOOK");
    });
    const checkRateLimit = vi
      .fn()
      .mockImplementation(async (channelId: string) =>
        channelId === "chan_webhook" ? { allowed: false, retryAfter: 5000 } : { allowed: true }
      );
    const sendSlackMessage = vi.fn().mockRejectedValue(new Error("slack timeout"));
    const findSlackIntegration = vi.fn().mockResolvedValue({ id: "int_1" } as any);
    const scheduleRetry = vi.fn().mockResolvedValue(undefined);

    const error = (await deliverAlertEvent(
      event.id,
      event.at,
      makeDeps({
        findChannel,
        checkRateLimit,
        sendSlackMessage,
        findSlackIntegration,
        scheduleRetry,
      })
    ).catch((e) => e)) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect(error.message).toBe("1 deliveries failed: SLACK: Error");
    expect(scheduleRetry).not.toHaveBeenCalled();
    const statuses = Object.fromEntries(
      (await deliveriesForEvent(event.id)).map((d) => [d.notifierId, d.status])
    );
    expect(statuses).toEqual({
      "channel:chan_email": "delivered",
      "channel:chan_slack": "pending",
      "channel:chan_webhook": "pending",
    });
  });

  it("grows the rate-limit delay with the wait, with a 1 s floor", async () => {
    const hour = 60 * 60_000;
    const retryCap = { maxAttempts: 10, maxAgeMs: 24 * hour };
    const cases: { retryAfter: number; waitedMs: number; expected: number; slack?: number }[] = [
      { retryAfter: 0, waitedMs: 0, expected: 1000 },
      { retryAfter: 10 * 60_000, waitedMs: 0, expected: 600_000 },
      { retryAfter: Number.NaN, waitedMs: 0, expected: 1000 },
      { retryAfter: 2000, waitedMs: 2 * 60_000, expected: 30_000 },
      { retryAfter: 2000, waitedMs: 60 * 60_000, expected: 900_000 },
      { retryAfter: 2000, waitedMs: 20 * hour, expected: 4 * hour - 60_000, slack: 1000 },
      { retryAfter: 2000, waitedMs: 24 * hour - 30_000, expected: (24 * hour - 30_000) / 4 },
      { retryAfter: 5 * hour, waitedMs: 20 * hour, expected: 5 * hour },
    ];

    for (const { retryAfter, waitedMs, expected, slack = 0 } of cases) {
      await resetAlerts();
      const { event, deliveries } = await seedAlertWithLease({
        notifiers: [{ type: "channel", channelId: "chan_email" }],
      });
      if (waitedMs > 0) {
        await rawSql`UPDATE "AlertDelivery" SET "firstAttemptAt" = ${new Date(Date.now() - waitedMs)}
          WHERE id = ${deliveries[0]!.id}`;
      }

      const { delays } = await deliverRateLimited({
        eventId: event.id,
        eventAt: event.at,
        retryAfter,
        random: () => 0,
        retryCap,
      });

      expect(delays[0]!.max, `retryAfter ${retryAfter}, waited ${waitedMs}`).toBeGreaterThanOrEqual(
        expected - slack
      );
      expect(delays[0]!.min, `retryAfter ${retryAfter}, waited ${waitedMs}`).toBeLessThan(
        expected + 1000
      );
    }
  });

  it("schedules a shared retry ahead of the earliest delivery deadline", async () => {
    const maxAgeMs = 24 * 60 * 60_000;
    const { event, deliveries } = await seedAlertWithLease({
      notifiers: [
        { type: "channel", channelId: "chan_email" },
        { type: "channel", channelId: "chan_email_2" },
      ],
    });
    const earlierStart = new Date(Date.now() - maxAgeMs + 10 * 60_000);
    const laterStart = new Date(earlierStart.getTime() + 2 * 60_000);
    await rawSql`UPDATE "AlertDelivery" SET "firstAttemptAt" = ${earlierStart}
      WHERE id = ${deliveries[0]!.id}`;
    await rawSql`UPDATE "AlertDelivery" SET "firstAttemptAt" = ${laterStart}
      WHERE id = ${deliveries[1]!.id}`;

    const { scheduleRetry } = await deliverRateLimited({
      eventId: event.id,
      eventAt: event.at,
      retryAfter: 2000,
      random: () => 0,
      retryCap: { maxAttempts: 10, maxAgeMs },
    });

    const [stored] = await rawSql<{ first_attempt_at: Date }[]>`
      SELECT "firstAttemptAt" AS first_attempt_at FROM "AlertDelivery"
      WHERE id = ${deliveries[0]!.id}`;
    const latest = stored!.first_attempt_at.getTime() + maxAgeMs - 60_000;
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    const at = (scheduleRetry.mock.calls[0]![0] as Date).getTime();
    expect(at).toBeLessThan(latest + 1000);
    expect(at).toBeGreaterThan(latest - 1000);
  });

  it("keeps firstAttemptAt across rate-limited releases so an old delivery ends exhausted", async () => {
    const { event, deliveries } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });
    const retryCap = { maxAttempts: 10, maxAgeMs: 24 * 60 * 60_000 };
    const firstAttemptAt = async () => {
      const [row] = await rawSql<{ first_attempt_at: Date | null }[]>`
        SELECT "firstAttemptAt" AS first_attempt_at FROM "AlertDelivery"
        WHERE id = ${deliveries[0]!.id}`;
      return row!.first_attempt_at;
    };

    await deliverRateLimited({ eventId: event.id, eventAt: event.at, retryAfter: 0, retryCap });
    const first = await firstAttemptAt();
    expect(first).not.toBeNull();
    await deliverRateLimited({ eventId: event.id, eventAt: event.at, retryAfter: 0, retryCap });
    expect(await firstAttemptAt()).toEqual(first);

    await rawSql`UPDATE "AlertDelivery" SET "firstAttemptAt" = NOW() - INTERVAL '25 hours'
      WHERE id = ${deliveries[0]!.id}`;
    const { scheduleRetry } = await deliverRateLimited({
      eventId: event.id,
      eventAt: event.at,
      retryAfter: 0,
      retryCap,
    });

    expect(scheduleRetry).not.toHaveBeenCalled();
    const [row] = await rawSql<{ status: string; failure_reason: string }[]>`
      SELECT status, "failureReason" AS failure_reason FROM "AlertDelivery"
      WHERE id = ${deliveries[0]!.id}`;
    expect(row).toEqual({ status: "failed", failure_reason: "retries_exhausted" });
  });

  it("second run for same event delivers nothing new (dedup)", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });

    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ findChannel, sendEmail });

    await deliverAlertEvent(event.id, event.at, deps);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    sendEmail.mockClear();
    await deliverAlertEvent(event.id, event.at, deps);
    expect(sendEmail).toHaveBeenCalledTimes(0);
  });

  it("stores message_ts in provider_metadata for slack", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_slack" }],
    });

    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_slack", "SLACK"));
    const fakeSlackLookup = vi.fn().mockResolvedValue({ id: "int_1" } as any);
    const sendSlack = vi.fn().mockResolvedValue({ ts: "1234567890.123456" });
    const deps = makeDeps({
      findChannel,
      sendSlackMessage: sendSlack,
      findSlackIntegration: fakeSlackLookup,
    });
    await deliverAlertEvent(event.id, event.at, deps);

    const allDeliveries = await deliveriesForEvent(event.id);
    const delivered = allDeliveries.find((d) => d.status === "delivered");
    expect(delivered?.providerMetadata).toEqual({ message_ts: "1234567890.123456" });
  });

  it("channel from another project is never used (tenancy)", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_foreign" }],
    });

    const findChannel = vi
      .fn()
      .mockImplementation(async ({ id, projectId }: { id: string; projectId: string }) => {
        if (id === "chan_foreign" && projectId === "proj_test") return null;
        return mockChannel("chan_foreign", "EMAIL", "proj_other");
      });

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ findChannel, sendEmail });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("marks delivery failed on invalid notifier properties", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_bad" }],
    });

    const findChannel = vi.fn().mockResolvedValue({
      id: "chan_bad",
      type: "EMAIL",
      enabled: true,
      properties: { invalid: true },
      projectId: "proj_test",
    });

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ findChannel, sendEmail });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(sendEmail).not.toHaveBeenCalled();
    const pending = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(pending).toHaveLength(0);
  });

  it("marks a stored chat notifier failed chat_not_supported without retry or append", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [
        { type: "channel", channelId: "chan_email" },
        { type: "chat", chatId: "conv_1" },
      ],
    });
    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    await deliverAlertEvent(event.id, event.at, makeDeps({ findChannel, sendEmail }));

    const allDeliveries = await deliveriesForEvent(event.id);
    const chatDelivery = allDeliveries.find((d) => d.notifier.type === "chat");
    expect(chatDelivery?.status).toBe("failed");
    expect(chatDelivery?.failureReason).toBe("chat_not_supported");
    expect(findChannel).toHaveBeenCalledTimes(1);
    expect(allDeliveries.find((d) => d.notifier.type === "channel")?.status).toBe("delivered");
  });

  it("rejects a delivery payload without eventAt", () => {
    expect(DeliverAlertEventPayload.safeParse({ eventId: "evt_1" }).success).toBe(false);
    const parsed = DeliverAlertEventPayload.safeParse({
      eventId: "evt_1",
      eventAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.eventAt).toBeInstanceOf(Date);
  });

  it("returns without delivering when eventAt does not match the event", async () => {
    const { event } = await seedAlertWithLease();
    const wrongAt = new Date(Date.UTC(event.at.getUTCFullYear(), event.at.getUTCMonth() + 1, 15));
    await ensureAlertPartitions(db, { from: wrongAt, to: wrongAt });

    const warn = vi.spyOn(logger, "warn");
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const findChannel = vi.fn();
    await expect(
      deliverAlertEvent(event.id, wrongAt, makeDeps({ sendEmail, findChannel }))
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("[deliverAlertEvent] Event not found", {
      eventId: event.id,
    });
    warn.mockRestore();
    expect(findChannel).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await listPendingDeliveriesForEvent(db, event.id, event.at)).toHaveLength(2);
  });

  it("acks without sending when the org flag is off", async () => {
    const { alert, event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const isOrganizationEnabled = vi.fn().mockResolvedValue(false);

    await expect(
      deliverAlertEvent(
        event.id,
        event.at,
        makeDeps({ sendEmail, findChannel, isOrganizationEnabled })
      )
    ).resolves.toBeUndefined();

    expect(isOrganizationEnabled).toHaveBeenCalledWith(alert.organizationId);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await listPendingDeliveriesForEvent(db, event.id, event.at)).toHaveLength(1);
  });

  it("fails a delivery with retries_exhausted after max attempts and stops sweeping it", async () => {
    const { event, deliveries } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });
    const retryCap = { maxAttempts: 3, maxAgeMs: 60 * 60_000 };
    const sendEmail = vi.fn().mockRejectedValue(new Error("SMTP timeout"));
    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const deps = makeDeps({ sendEmail, findChannel, retryCap });

    for (let i = 1; i < retryCap.maxAttempts; i++) {
      await expect(deliverAlertEvent(event.id, event.at, deps)).rejects.toBeInstanceOf(
        AggregateError
      );
    }
    await expect(deliverAlertEvent(event.id, event.at, deps)).resolves.toBeUndefined();

    expect(sendEmail).toHaveBeenCalledTimes(retryCap.maxAttempts);
    const [row] = await rawSql<{ status: string; failure_reason: string; attempts: number }[]>`
      SELECT status, "failureReason" AS failure_reason, attempts FROM "AlertDelivery"
      WHERE id = ${deliveries[0]!.id}`;
    expect(row).toEqual({
      status: "failed",
      failure_reason: "retries_exhausted",
      attempts: retryCap.maxAttempts,
    });

    const swept = await findStalePendingDeliveries(db, {
      olderThan: new Date(Date.now() + 60_000),
      staleClaimBefore: new Date(Date.now() + 60_000),
      limit: 100,
      cap: retryCap,
      now: new Date(),
    });
    expect(swept.map((d) => d.id)).not.toContain(deliveries[0]!.id);
  });
});
