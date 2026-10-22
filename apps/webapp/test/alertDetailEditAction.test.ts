import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const edited = vi.hoisted(() => ({ calls: [] as any[] }));
const activated = vi.hoisted(() => ({
  calls: [] as any[],
  reject: undefined as string | undefined,
}));
const DEFAULT_NOTIFIERS = vi.hoisted(() => [
  { type: "chat", chatId: "chat_9", userId: "user_2" },
  { type: "chat" },
  { type: "channel", channelId: "ch_1" },
]);
const current = vi.hoisted(() => ({ notifiers: [] as unknown[] }));
const canCalls = vi.hoisted(() => [] as unknown[][]);
const presented = vi.hoisted(() => ({ calls: [] as any[], alert: null as unknown }));
const chats = vi.hoisted(() => ({ exists: true }));
const CHANNELS = vi.hoisted(() => [
  { id: "ch_1", projectId: "p1" },
  { id: "ch_foreign", projectId: "p2" },
]);

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (_options: unknown, handler: any) => (args: any) =>
    handler({
      ...args,
      user: { id: "user_1" },
      ability: {
        can: (...args: unknown[]) => {
          canCalls.push(args);
          return true;
        },
      },
      params: {
        organizationSlug: "org",
        projectParam: "proj",
        envParam: "prod",
        alertId: "alert_1",
      },
    });
  return { dashboardLoader: wrap, dashboardAction: wrap };
});

vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({
    id: "p1",
    organizationId: "o1",
    organization: { featureFlags: {} },
  }),
}));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "e1", type: "PRODUCTION" }),
}));

vi.mock("~/db.server", () => ({
  prisma: {
    projectAlertChannel: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; projectId?: string } }) =>
        CHANNELS.filter(
          (c) =>
            (!where.id || where.id.in.includes(c.id)) &&
            (where.projectId === undefined || c.projectId === where.projectId)
        ).map(({ id }) => ({ id })),
    },
  },
  $replica: {},
}));

vi.mock("~/presenters/v3/AlertDetailPresenter.server", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    AlertDetailPresenter: class {
      async call(input: unknown) {
        presented.calls.push(input);
        return presented.alert;
      }
    },
  };
});

vi.mock("~/v3/canUseAlertsList.server", () => ({ canUseAlertsList: async () => true }));

vi.mock("~/components/alerts/hasLegacyAlerts.server", () => ({
  hasLegacyAlerts: async () => ({ hasLegacyAlerts: false, hasMigratableLegacyAlerts: false }),
}));

vi.mock("~/v3/services/alerts/alertActions.server", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    performAlertAction: async () => {},
    editAlert: async (_db: unknown, input: unknown) => {
      edited.calls.push(input);
    },
    activateAlert: async (_db: unknown, input: unknown) => {
      if (activated.reject) {
        const Invalid = original.AlertActivationInvalidError as new (m: string) => Error;
        throw new Invalid(activated.reject);
      }
      activated.calls.push(input);
    },
  };
});

vi.mock("@internal/dashboard-agent-db", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    chatExists: async () => chats.exists,
  };
});

vi.mock("~/v3/services/alerts/storage/alertStore.server", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getAlert: async () => ({
      id: "alert_1",
      notifiers: current.notifiers.length > 0 ? current.notifiers : DEFAULT_NOTIFIERS,
    }),
  };
});

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/alerts/alert_1", { method: "POST", body });
}

describe("alert detail edit action", () => {
  let action: (args: unknown) => Promise<unknown>;
  let loader: (args: unknown) => Promise<unknown>;
  beforeAll(async () => {
    const mod =
      await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.$alertId/route");
    action = mod.action as never;
    loader = mod.loader as never;
  }, 180_000);

  it("checks write and delete for the environment type", async () => {
    canCalls.length = 0;
    await action({
      request: post({ intent: "delete", respond: "json" }),
      params: {},
      context: {},
    } as any);
    expect(canCalls).toEqual([
      ["write", { type: "alerts", envType: "PRODUCTION" }],
      ["delete", { type: "alerts", envType: "PRODUCTION" }],
    ]);
  });

  it("loader checks read, write and delete for the environment type", async () => {
    presented.alert = { id: "alert_1", kind: "threshold" };
    canCalls.length = 0;
    await loader({
      request: new Request("http://localhost/alerts/alert_1"),
      params: {},
      context: {},
    } as any);
    presented.alert = null;
    expect(canCalls).toEqual([
      ["read", { type: "alerts", envType: "PRODUCTION" }],
      ["write", { type: "alerts", envType: "PRODUCTION" }],
      ["delete", { type: "alerts", envType: "PRODUCTION" }],
    ]);
  });

  it("edit rejects a channel from another project", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "channel:ch_foreign", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Channel is not available" });
    expect(edited.calls).toHaveLength(0);
  });

  it("edit rejects a forged teammate chat ref", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "chat:x:user_2", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unauthorized chat notifier" });
    expect(edited.calls).toHaveLength(0);
  });

  it("edit rejects a chat the editor does not own", async () => {
    edited.calls = [];
    chats.exists = false;
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "chat:chat_other:user_1", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    chats.exists = true;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unauthorized chat notifier" });
    expect(edited.calls).toHaveLength(0);
  });

  it("edit rejects a past expiry", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", expiresAt: "2000-01-01T00:00:00.000Z", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Pick an expiry in the future" });
    expect(edited.calls).toHaveLength(0);
  });

  it("edit keeps one copy of a repeated notifier", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "channel:ch_1,channel:ch_1", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(edited.calls[0].notifiers).toEqual([
      { type: "channel", channelId: "ch_1" },
      { type: "chat", chatId: "chat_9", userId: "user_2" },
    ]);
  });

  it("loader ignores unusable from and to", async () => {
    presented.calls = [];
    await loader({
      request: new Request("http://localhost/alerts/alert_1?from=99999999999999999999&to=abc"),
      params: {},
      context: {},
    } as any).catch(() => undefined);
    const window = presented.calls[0].eventsWindow;
    expect(Number.isNaN(window.since.getTime())).toBe(false);
    expect(Number.isNaN(window.until.getTime())).toBe(false);
  });

  it("returns ok JSON when asked for JSON", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(edited.calls).toEqual([expect.objectContaining({ alertId: "alert_1" })]);
  });

  it("keeps a teammate's chat ref the editor can't own", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "chat:chat_9:user_2", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(edited.calls[0].notifiers).toEqual([
      { type: "chat", chatId: "chat_9", userId: "user_2" },
    ]);
  });

  it("re-adds a teammate's chat ref the request left out", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "chat:chat_own:user_1", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(edited.calls[0].notifiers).toEqual([
      expect.objectContaining({ type: "chat", chatId: "chat_own", userId: "user_1" }),
      { type: "chat", chatId: "chat_9", userId: "user_2" },
    ]);
  });

  it("removing a project chat ref removes it, a teammate's ref stays", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "chat:chat_9:user_2", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(edited.calls[0].notifiers).toEqual([
      { type: "chat", chatId: "chat_9", userId: "user_2" },
    ]);
  });

  it("keeping a project chat ref keeps it", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({
        intent: "edit",
        notifierIds: "chat:project:-,chat:chat_9:user_2",
        respond: "json",
      }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(edited.calls[0].notifiers).toEqual([
      { type: "chat" },
      { type: "chat", chatId: "chat_9", userId: "user_2" },
    ]);
  });

  it("an edit without notifierIds leaves notifiers untouched", async () => {
    edited.calls = [];
    await action({
      request: post({ intent: "edit", respond: "json" }),
      params: {},
      context: {},
    } as any);
    expect(edited.calls[0].notifiers).toBeUndefined();
  });

  it("edit passes a parsed expiry through", async () => {
    edited.calls = [];
    const iso = new Date(Date.now() + 3_600_000).toISOString();
    const response = (await action({
      request: post({ intent: "edit", expiresAt: iso, respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(edited.calls[0].expiresAt).toEqual(new Date(iso));
  });

  it("edit with expiresAt none clears the expiry", async () => {
    edited.calls = [];
    await action({
      request: post({ intent: "edit", expiresAt: "none", respond: "json" }),
      params: {},
      context: {},
    } as any);
    expect(edited.calls[0].expiresAt).toBeNull();
  });

  it("edit without expiresAt keeps the expiry", async () => {
    edited.calls = [];
    await action({
      request: post({ intent: "edit", respond: "json" }),
      params: {},
      context: {},
    } as any);
    expect(edited.calls[0].expiresAt).toBeUndefined();
  });

  it("edit rejects an unparsable expiry", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", expiresAt: "soon", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(400);
    expect(edited.calls).toHaveLength(0);
  });

  it("rejects an unparsable notifier key and leaves notifiers unchanged", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "channel:ch_1,bogus", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid notifier" });
    expect(edited.calls).toHaveLength(0);
  });

  it("rejects an edit that removes every notifier", async () => {
    edited.calls = [];
    current.notifiers = [{ type: "channel", channelId: "ch_1" }];
    const response = (await action({
      request: post({ intent: "edit", notifierIds: "", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "At least one notifier is required" });
    expect(edited.calls).toHaveLength(0);
    current.notifiers = [];
  });

  it("activate passes the picked expiry and notifiers", async () => {
    activated.calls = [];
    const response = (await action({
      request: post({
        intent: "activate",
        expiresAt: "none",
        notifierIds: "chat:project:-,chat:chat_9:user_2",
        respond: "json",
      }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(200);
    expect(activated.calls[0]).toMatchObject({
      alertId: "alert_1",
      expiresAt: null,
      notifiers: [{ type: "chat" }, { type: "chat", chatId: "chat_9", userId: "user_2" }],
    });
  });

  it("activate rejects an unparsable expiry", async () => {
    activated.calls = [];
    const response = (await action({
      request: post({ intent: "activate", expiresAt: "soon", respond: "json" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Pick an expiry in the future" });
    expect(activated.calls).toHaveLength(0);
  });

  it("activate shows the service's validation error", async () => {
    activated.reject = "Pick an expiry in the future";
    const response = (await action({
      request: post({
        intent: "activate",
        notifierIds: "chat:project:-",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        respond: "json",
      }),
      params: {},
      context: {},
    } as any)) as Response;
    activated.reject = undefined;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Pick an expiry in the future" });
  });

  it("still redirects without respond=json", async () => {
    edited.calls = [];
    const response = (await action({
      request: post({ intent: "edit" }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(response.status).toBe(302);
    expect(edited.calls).toHaveLength(1);
  });
});
