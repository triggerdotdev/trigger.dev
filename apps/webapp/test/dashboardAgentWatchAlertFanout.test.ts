import { beforeEach, describe, expect, test, vi } from "vitest";
import type * as OrgIntegrationModule from "~/models/orgIntegration.server";
import type * as SecretStoreModule from "~/services/secrets/secretStore.server";

const EMAIL_CHANNEL = {
  id: "chan_email",
  type: "EMAIL" as const,
  properties: { email: "watcher@example.com" },
};
const SLACK_CHANNEL = {
  id: "chan_slack",
  type: "SLACK" as const,
  properties: { channelId: "C123", channelName: "#alerts" },
};
const WEBHOOK_CHANNEL = {
  id: "chan_webhook",
  type: "WEBHOOK" as const,
  properties: {
    url: "https://example.com/hook",
    secret: { nonce: "n", ciphertext: "c", tag: "t" },
  },
};

const ctx = vi.hoisted(() => ({
  channels: [] as Array<{ id: string; type: string; properties: unknown }>,
  /** Set to model replica lag: what the replica still sees. Null means "same as primary". */
  replicaChannels: null as Array<{ id: string; type: string; properties: unknown }> | null,
  gateAllowed: true,
  webhookFails: false,
}));

const sendAlertEmail = vi.hoisted(() => vi.fn(async () => undefined));
const postMessage = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const safeWebhookFetch = vi.hoisted(() =>
  vi.fn(async (_url: string, _init: { body: string }) => ({
    ok: !ctx.webhookFails,
    status: ctx.webhookFails ? 500 : 200,
  }))
);

vi.mock("~/db.server", () => {
  const channelReader = (rows: () => Array<{ id: string; type: string; properties: unknown }>) => ({
    findMany: async () => rows(),
    findFirst: async ({ where }: { where: { id: string } }) =>
      rows().find((channel) => channel.id === where.id) ?? null,
  });
  const db = {
    runtimeEnvironment: {
      findFirst: async () => ({
        type: "PRODUCTION",
        slug: "prod",
        branchName: null,
        project: {
          name: "My Project",
          slug: "my-project-abcd",
          externalRef: "proj_abc",
          organization: { slug: "acme", title: "Acme" },
        },
      }),
    },
    organizationIntegration: {
      findFirst: async () => ({
        id: "int_1",
        service: "SLACK",
        organizationId: "org_1",
        tokenReference: { provider: "DATABASE", key: "k" },
      }),
    },
  };
  return {
    prisma: { ...db, projectAlertChannel: channelReader(() => ctx.channels) },
    $replica: {
      ...db,
      projectAlertChannel: channelReader(() => ctx.replicaChannels ?? ctx.channels),
    },
    sqlDatabaseSchema: undefined,
  };
});

vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => ctx.gateAllowed,
}));

vi.mock("~/services/email.server", () => ({ sendAlertEmail }));
vi.mock("~/services/dashboardAgentAlertUnsubscribeToken.server", () => ({
  mintDashboardAgentAlertUnsubscribeToken: async () => "unsub-token",
}));
vi.mock("~/v3/services/alerts/safeWebhookFetch.server", () => ({ safeWebhookFetch }));

vi.mock("~/services/secrets/secretStore.server", async (importOriginal) => ({
  ...(await importOriginal<typeof SecretStoreModule>()),
  decryptSecret: async () => "webhook-secret",
}));

vi.mock("~/models/orgIntegration.server", async (importOriginal) => ({
  ...(await importOriginal<typeof OrgIntegrationModule>()),
  OrgIntegrationRepository: {
    getAuthenticatedClientForIntegration: async () => ({ chat: { postMessage } }),
  },
}));

const { DeliverDashboardAgentWatchAlertService, DeliverDashboardAgentWatchChannelAlertService } =
  await import("~/v3/services/alerts/deliverDashboardAgentWatchAlert.server");
const { alertsWorker } = await import("~/v3/alertsWorker.server");

const enqueue = alertsWorker.enqueue as unknown as ReturnType<typeof vi.fn>;

const payload = {
  watchId: "watch_1",
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
  identity: "queue:my-queue",
  kind: "queue_depth",
  note: "the queue drains",
  firedAt: "2026-07-30T10:00:00.000Z",
  facts: { depth: 0 },
};

beforeEach(() => {
  ctx.channels = [EMAIL_CHANNEL, SLACK_CHANNEL, WEBHOOK_CHANNEL];
  ctx.replicaChannels = null;
  ctx.gateAllowed = true;
  ctx.webhookFails = false;
  enqueue.mockClear();
  sendAlertEmail.mockClear();
  postMessage.mockClear();
  safeWebhookFetch.mockClear();
});

describe("dashboard agent watch alert fan-out", () => {
  test("enqueues one delivery job per channel, keyed per channel", async () => {
    await new DeliverDashboardAgentWatchAlertService().call(payload);

    expect(enqueue).toHaveBeenCalledTimes(3);
    const calls = enqueue.mock.calls.map(([arg]) => arg);

    expect(calls.map((call) => call.id)).toEqual([
      "watch-alert:watch_1:channel:chan_email",
      "watch-alert:watch_1:channel:chan_slack",
      "watch-alert:watch_1:channel:chan_webhook",
    ]);
    for (const call of calls) {
      expect(call.job).toBe("v3.deliverDashboardAgentWatchAlertChannel");
    }
    expect(calls[2].payload).toMatchObject({ ...payload, channelId: "chan_webhook" });

    expect(sendAlertEmail).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(safeWebhookFetch).not.toHaveBeenCalled();
  });

  test("the fan-out is idempotent: a retry re-enqueues the same job ids", async () => {
    await new DeliverDashboardAgentWatchAlertService().call(payload);
    const first = enqueue.mock.calls.map(([arg]) => arg.id);
    enqueue.mockClear();

    await new DeliverDashboardAgentWatchAlertService().call(payload);
    expect(enqueue.mock.calls.map(([arg]) => arg.id)).toEqual(first);
  });

  test("a denied gate enqueues nothing", async () => {
    ctx.gateAllowed = false;
    await new DeliverDashboardAgentWatchAlertService().call(payload);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("dashboard agent watch alert per-channel delivery", () => {
  test("a failing webhook retry re-sends only the webhook", async () => {
    const service = new DeliverDashboardAgentWatchChannelAlertService();

    await service.call({ ...payload, channelId: "chan_email" });
    await service.call({ ...payload, channelId: "chan_slack" });
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);

    ctx.webhookFails = true;
    await expect(service.call({ ...payload, channelId: "chan_webhook" })).rejects.toThrow(
      /Failed to send watch alert webhook/
    );
    await expect(service.call({ ...payload, channelId: "chan_webhook" })).rejects.toThrow(
      /Failed to send watch alert webhook/
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(safeWebhookFetch).toHaveBeenCalledTimes(2);
  });

  test("the webhook event id and created are stable across attempts", async () => {
    const service = new DeliverDashboardAgentWatchChannelAlertService();
    ctx.webhookFails = true;

    await expect(service.call({ ...payload, channelId: "chan_webhook" })).rejects.toThrow();
    await expect(service.call({ ...payload, channelId: "chan_webhook" })).rejects.toThrow();

    const bodies = safeWebhookFetch.mock.calls.map(([, init]) => JSON.parse(init.body));

    expect(bodies).toHaveLength(2);
    expect(bodies[0].id).toBe("watch:watch_1:channel:chan_webhook");
    expect(bodies[1].id).toBe(bodies[0].id);
    expect(bodies[0].created).toBe(payload.firedAt);
    expect(bodies[1].created).toBe(bodies[0].created);
  });

  test("an unsubscribe the replica hasn't caught up on still stops the email", async () => {
    ctx.channels = [];
    ctx.replicaChannels = [EMAIL_CHANNEL];

    await new DeliverDashboardAgentWatchChannelAlertService().call({
      ...payload,
      channelId: "chan_email",
    });

    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  test("an unsubscribed channel delivers nothing", async () => {
    ctx.channels = [];
    await new DeliverDashboardAgentWatchChannelAlertService().call({
      ...payload,
      channelId: "chan_email",
    });
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });
});
