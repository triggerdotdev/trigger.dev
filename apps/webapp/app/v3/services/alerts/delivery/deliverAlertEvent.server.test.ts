import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import {
  type DashboardAgentDb,
  type DashboardAgentDbClient,
  createDashboardAgentDb,
  createChat,
  getChatMessages,
} from "@internal/dashboard-agent-db";
import {
  applyDashboardAgentMigrations,
  type MigrationExecutor,
} from "@internal/dashboard-agent-db/testing";
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
import { SkipRetryError } from "../alertTransport.server";
import type { NotifierRef } from "@internal/alert-contracts";

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let client: DashboardAgentDbClient;
let chatDb: DashboardAgentDb;
let db: PrismaClient;
let rawSql: ReturnType<typeof rawSqlClient>;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
  rawSql = rawSqlClient(db);
  client = createDashboardAgentDb(pg.container.getConnectionUri(), { max: 5 });
  chatDb = client.db;
  const execute: MigrationExecutor = (statement) => client.sql.unsafe(statement).then(() => {});
  await applyDashboardAgentMigrations(execute);
}, 120_000);

afterAll(async () => {
  await client?.close();
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

function makeDeps(
  overrides?: Partial<Omit<DeliverAlertEventDeps, "db" | "chatDb">>
): DeliverAlertEventDeps {
  return {
    db,
    chatDb,
    sendSlackMessage: overrides?.sendSlackMessage ?? vi.fn().mockResolvedValue({ ts: "ts_123" }),
    deliverWebhook: overrides?.deliverWebhook ?? vi.fn().mockResolvedValue(new Response("ok")),
    sendEmail: overrides?.sendEmail ?? vi.fn().mockResolvedValue(undefined),
    findSlackIntegration: overrides?.findSlackIntegration ?? vi.fn().mockResolvedValue(null),
    findChannel: overrides?.findChannel ?? vi.fn().mockResolvedValue(null),
    checkRateLimit: overrides?.checkRateLimit ?? vi.fn().mockResolvedValue({ allowed: true }),
    deliverChatWake: overrides?.deliverChatWake ?? vi.fn().mockResolvedValue("appended"),
    verifyChatForAlert: overrides?.verifyChatForAlert ?? vi.fn().mockResolvedValue(true),
    loadAlertContext: overrides?.loadAlertContext ?? vi.fn().mockResolvedValue(ALERT_CONTEXT),
    isOrganizationEnabled: overrides?.isOrganizationEnabled ?? vi.fn().mockResolvedValue(true),
    retryCap: overrides?.retryCap,
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

    const pending = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
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

  it("rate-limited delivery is released for a retry, not failed", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "channel", channelId: "chan_email" }],
    });

    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const checkRateLimit = vi.fn().mockResolvedValue({ allowed: false });
    const error = await deliverAlertEvent(
      event.id,
      event.at,
      makeDeps({ findChannel, sendEmail, checkRateLimit })
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AggregateError);
    expect(sendEmail).not.toHaveBeenCalled();
    const pending = await listPendingDeliveriesForEvent(db, event.id, event.at);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
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

  it("delivers a chat wake and marks email delivered independently", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [
        { type: "channel", channelId: "chan_email" },
        { type: "chat", chatId: "conv_1" },
      ],
    });

    const findChannel = vi.fn().mockResolvedValue(mockChannel("chan_email", "EMAIL"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const deliverChatWake = vi.fn().mockResolvedValue("appended");
    const deps = makeDeps({ findChannel, sendEmail, deliverChatWake });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(deliverChatWake).toHaveBeenCalledTimes(1);
    const wakeCall = deliverChatWake.mock.calls[0]![0];
    expect(wakeCall.chatId).toBe("conv_1");
    expect(wakeCall.actionId).toBe(`alert:${event.id}`);
    expect(wakeCall.alert.id).toBe(event.alertId);
    expect(wakeCall.event.facts).toEqual({ queueDepth: 142, threshold: 100 });

    const allDeliveries = await deliveriesForEvent(event.id);
    const chatDelivery = allDeliveries.find((d) => d.notifier.type === "chat");
    expect(chatDelivery?.status).toBe("delivered");
    expect(chatDelivery?.notifierId).toBe("chat:conv_1:-");

    const emailDelivery = allDeliveries.find((d) => d.notifier.type === "channel");
    expect(emailDelivery?.status).toBe("delivered");
  });

  it.each([
    ["raised", "Alert raised"],
    ["recovered", "Alert recovered"],
  ] as const)("appends an assistant text message for a %s event", async (eventType, prefix) => {
    const chatId = `conv_text_${eventType}`;
    await createChat(chatDb, { id: chatId, organizationId: "org_test", userId: "user_test" });
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "chat", chatId }],
      eventType,
      facts: { value: 142, threshold: 100, unit: "count", windowSec: 300 },
    });

    await deliverAlertEvent(event.id, event.at, {
      ...makeDeps(),
      deliverChatWake: undefined,
    });

    const messages = await getChatMessages(chatDb, {
      chatId,
      userId: "user_test",
      organizationId: "org_test",
    });
    const message = (messages as Array<{ id: string }>).find(
      (m) => m.id === `alert:${event.id}`
    ) as {
      role: string;
      parts: Array<{ type: string; text: string }>;
    };
    expect(message.role).toBe("assistant");
    expect(message.parts[0]!.type).toBe("text");
    expect(message.parts[0]!.text).toContain("Queue depth high");
    expect(message.parts[0]!.text.startsWith(prefix)).toBe(true);
  });

  it("marks chat delivery failed when wake returns not_found", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "chat", chatId: "conv_gone" }],
    });

    const deliverChatWake = vi.fn().mockResolvedValue("not_found");
    const deps = makeDeps({ deliverChatWake });
    await deliverAlertEvent(event.id, event.at, deps);

    const allDeliveries = await deliveriesForEvent(event.id);
    const chatDelivery = allDeliveries.find((d) => d.notifier.type === "chat");
    expect(chatDelivery?.status).toBe("failed");
    expect(chatDelivery?.failureReason).toBe("chat_not_found");
    expect(chatDelivery?.notifierId).toBe("chat:conv_gone:-");
  });

  it("marks chat delivery failed when chatId is missing", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "chat", userId: "user_test" }],
    });

    const deliverChatWake = vi.fn();
    const deps = makeDeps({ deliverChatWake });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(deliverChatWake).not.toHaveBeenCalled();

    const allDeliveries = await deliveriesForEvent(event.id);
    const chatDelivery = allDeliveries.find((d) => d.notifier.type === "chat");
    expect(chatDelivery?.status).toBe("failed");
    expect(chatDelivery?.failureReason).toBe("chat_not_found");
  });

  it("chat delivery action id is stable across replays (idempotent)", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "chat", chatId: "conv_replay" }],
    });

    const deliverChatWake = vi.fn().mockResolvedValue("appended");
    const deps = makeDeps({ deliverChatWake });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(deliverChatWake.mock.calls[0]![0].actionId).toBe(`alert:${event.id}`);

    deliverChatWake.mockClear();
    await deliverAlertEvent(event.id, event.at, deps);
    expect(deliverChatWake).not.toHaveBeenCalled();
  });

  it("crash after append but before markDelivered: retry marks delivered via duplicate", async () => {
    const { event, deliveries } = await seedAlertWithLease({
      notifiers: [{ type: "chat", chatId: "conv_crash" }],
    });

    const deliverChatWake = vi.fn().mockResolvedValue("appended");
    const deps = makeDeps({ deliverChatWake });
    await deliverAlertEvent(event.id, event.at, deps);
    expect(deliverChatWake).toHaveBeenCalledTimes(1);

    const delivery = deliveries[0]!;
    await rawSql`UPDATE "AlertDelivery" SET status = 'delivering', "claimedAt" = NOW() - INTERVAL '6 minutes' WHERE id = ${delivery.id}`;

    deliverChatWake.mockClear();
    deliverChatWake.mockResolvedValue("duplicate");
    await deliverAlertEvent(event.id, event.at, deps);

    expect(deliverChatWake).toHaveBeenCalledTimes(1);

    const allDeliveries = await deliveriesForEvent(event.id);
    expect(allDeliveries[0]!.status).toBe("delivered");
    expect(allDeliveries[0]!.claimId).not.toBeNull();
  });

  it("marks delivery failed when chat belongs to another tenant", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "chat", chatId: "conv_foreign" }],
    });

    const verifyChatForAlert = vi.fn().mockResolvedValue(false);
    const deliverChatWake = vi.fn();
    const deps = makeDeps({ verifyChatForAlert, deliverChatWake });
    await deliverAlertEvent(event.id, event.at, deps);

    expect(deliverChatWake).not.toHaveBeenCalled();

    const allDeliveries = await deliveriesForEvent(event.id);
    const chatDelivery = allDeliveries.find((d) => d.notifier.type === "chat");
    expect(chatDelivery?.status).toBe("failed");
    expect(chatDelivery?.failureReason).toBe("notifier_invalid");
  });

  it("chat soft-deleted between verify and append marks failed, not delivered", async () => {
    const { event } = await seedAlertWithLease({
      notifiers: [{ type: "chat", chatId: "conv_deleted" }],
    });

    const deliverChatWake = vi.fn().mockResolvedValue("not_found");
    const deps = makeDeps({ deliverChatWake });
    await deliverAlertEvent(event.id, event.at, deps);

    const allDeliveries = await deliveriesForEvent(event.id);
    const chatDelivery = allDeliveries.find((d) => d.notifier.type === "chat");
    expect(chatDelivery?.status).toBe("failed");
    expect(chatDelivery?.failureReason).toBe("chat_not_found");
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
