import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  canWriteWebhooks: false,
  generated: 0,
  stored: 0,
  verifyTokens: 0,
}));

vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "user_1" }),
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "proj_1", organizationId: "org_1" }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "PRODUCTION" }),
}));
vi.mock("~/v3/webhooksAccess.server", () => ({
  requireWebhooksAccess: async () => {},
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      ability: {
        can: (action: string, resource: { type: string }) =>
          !(action === "write" && resource.type === "webhooks" && !STATE.canWriteWebhooks),
      },
    }),
  },
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("~/utils/webhookIngressUrl.server", () => ({
  webhookIngressUrl: (opaqueId: string) => `https://example.test/webhooks/v1/ingest/${opaqueId}`,
}));
vi.mock("~/presenters/v3/WebhookDetailPresenter.server", () => ({
  WebhookDetailPresenter: class {
    async findEndpoint() {
      return {
        id: "wh_1",
        friendlyId: "whe_1",
        verifierArtifact: {
          kind: "config",
          config: { scheme: "shared-secret", placement: "header" },
          getHandshake: { tokenParam: "hub.verify_token", challengeParam: "hub.challenge" },
        },
      };
    }
  },
}));
vi.mock("~/services/secrets/secretStore.server", () => ({
  getSecretStore: () => ({
    getSecret: async () => null,
    setSecret: async () => {
      STATE.verifyTokens++;
    },
  }),
}));
vi.mock("~/v3/webhookSigningSecret.server", () => ({
  generateWebhookSigningSecret: async () => {
    STATE.generated++;
    return { ok: true, secret: "whsec_generated", previousSecretExpiresAt: undefined };
  },
  storeWebhookSigningSecret: async () => {
    STATE.stored++;
  },
}));
vi.mock("~/v3/webhookEngine.server", () => ({
  webhookEngine: {},
  webhookVerifyTokenKey: (id: string) => `webhook-verify-token:${id}`,
}));

let action: any;

beforeAll(async () => {
  action = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.webhooks.endpoints.$endpointParam/route")
  ).action;
}, 120_000);

beforeEach(() => {
  STATE.canWriteWebhooks = false;
  STATE.generated = 0;
  STATE.stored = 0;
  STATE.verifyTokens = 0;
});

const params = {
  organizationSlug: "org",
  projectParam: "proj",
  envParam: "prod",
  endpointParam: "whe_1",
};

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request("http://localhost/endpoint", { method: "POST", body });
}

async function status(promise: Promise<unknown>) {
  try {
    const result = await promise;
    return result instanceof Response ? result.status : 200;
  } catch (e) {
    return (e as Response).status;
  }
}

const intents = [
  { name: "generate-secret", fields: { intent: "generate-secret" } },
  { name: "set-secret", fields: { intent: "set-secret", secret: "whsec_pasted" } },
  { name: "generate-verify-token", fields: { intent: "generate-verify-token" } },
];

describe("endpoint secret actions require write:webhooks", () => {
  it.each(intents)(
    "$name is 403 without write:webhooks and changes nothing",
    async ({ fields }) => {
      expect(await status(action({ request: post(fields), params }))).toBe(403);
      expect(STATE).toMatchObject({ generated: 0, stored: 0, verifyTokens: 0 });
    }
  );

  it("each action succeeds with write:webhooks", async () => {
    STATE.canWriteWebhooks = true;
    for (const { fields } of intents) {
      const result = await action({ request: post(fields), params });
      expect(result).toMatchObject({ success: true });
    }
    expect(STATE).toMatchObject({ generated: 1, stored: 1, verifyTokens: 1 });
  });
});
