import { postgresTest } from "@internal/testcontainers";
import plugin from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { describe, expect, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const mocks = vi.hoisted(() => {
  const defaults = {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "test-magic-link-secret",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
    WEBHOOK_ENABLED: "1",
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

  const state = {
    db: undefined as unknown as Record<string | symbol, unknown>,
    rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
    deliveryEnvId: "",
    dbProxy: () => new Proxy({}, { get: (_, prop) => state.db[prop] }),
  };
  return state;
});

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", () => ({
  $replica: mocks.dbProxy(),
  prisma: mocks.dbProxy(),
  webhookPrisma: mocks.dbProxy(),
  webhookReplica: mocks.dbProxy(),
  webhookPartitionPrisma: mocks.dbProxy(),
  boundedIn: <T>(values: T[]) => values,
  // Mirrors the real helper's overloads: an optional span name comes before the callback.
  $transaction: (
    db: PrismaClient,
    fnOrName: string | Parameters<PrismaClient["$transaction"]>[0],
    fnOrOptions?: Parameters<PrismaClient["$transaction"]>[0] | object,
    options?: object
  ) =>
    typeof fnOrName === "string"
      ? db.$transaction(fnOrOptions as never, options)
      : db.$transaction(fnOrName as never, fnOrOptions as object | undefined),
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) =>
          mocks.rbac[prop](...args),
    }
  ),
}));

vi.mock("~/v3/alertEngineWorker.server", () => ({
  enqueueAlertEvaluation: async () => {},
  ackAlertEvaluation: async () => {},
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server", () => ({
  webhookDeliveriesRepository: () => ({
    getDelivery: async ({ environmentId }: { environmentId: string }) =>
      environmentId === mocks.deliveryEnvId
        ? { id: "delivery-internal", createdAt: new Date() }
        : null,
  }),
}));
// Mirrors the real engine's contract: it runs `authorize` over the subscribers it would run.
vi.mock("~/v3/webhookEngine.server", () => ({
  webhookEngine: {
    replayDelivery: async ({ authorize }: { authorize: (s: unknown[]) => string[] }) => {
      const denied = authorize([{ taskId: "my-task", type: "task", id: "sub_1" }]);
      return denied.length > 0
        ? { outcome: "forbidden", denied }
        : { outcome: "replayed", deliveryFriendlyId: "whd_new" };
    },
  },
}));

import { alertsWriteTools } from "~/mcp/tools/alertsWrite.server";
import { createFeedbackTools } from "~/mcp/tools/feedback.server";
import { webhooksWriteTools } from "~/mcp/tools/webhooksWrite.server";
import type { McpIdentity } from "~/mcp/gate/types";
import {
  expectPending,
  getMcpConfirmationStore,
  pending,
  resetConfirmations,
} from "./helpers/mcpConfirm";

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true }) as any;
  resetConfirmations({ autoApprove: true });

  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  await prisma.organization.update({
    where: { id: a.organization.id },
    data: { featureFlags: { alertsEnabled: true } },
  });
  const env = await createRuntimeEnvironment(prisma, {
    projectId: a.project.id,
    organizationId: a.organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });

  const pat = `tr_pat_${uniqueId("tok")}`;
  const token = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: createHash("sha256").update(pat).digest("hex"),
      userId: a.user.id,
    },
  });
  const identity: McpIdentity = { kind: "pat", userId: a.user.id, tokenId: token.id };
  const request = new Request("https://api.trigger.dev/mcp", {
    headers: { Authorization: `Bearer ${pat}` },
  });

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      friendlyId: uniqueId("wh"),
      opaqueId: uniqueId("opaque"),
      organizationId: a.organization.id,
      projectId: a.project.id,
      runtimeEnvironmentId: env.id,
      environmentType: "PRODUCTION",
      source: "stripe",
      declaredId: "payments",
      verifierArtifact: {},
    },
  });

  const alert = await prisma.alert.create({
    data: {
      id: uniqueId("alert"),
      organizationId: a.organization.id,
      projectId: a.project.id,
      environmentId: env.id,
      capabilityKey: "queue.depth",
      params: {},
      condition: {},
      attention: "needs_attention",
      createdBy: a.user.id,
    },
  });

  mocks.deliveryEnvId = env.id;
  return { a, b, env, identity, request, endpoint, alert };
}

const tool = (tools: { name: string; handler: Function }[], name: string) =>
  tools.find((t) => t.name === name)!.handler as (
    args: unknown,
    identity: McpIdentity,
    request: Request
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;

const textOf = (result: { content: { text: string }[] }) =>
  result.content.map((c) => c.text).join("\n");

const denyAbility = (denied: (action: string, resource: { envType?: string }) => boolean) => {
  const real = mocks.rbac;
  mocks.rbac = {
    ...real,
    authenticatePat: async (...args: unknown[]) => {
      const result = await real.authenticatePat(...args);
      const { ability } = result;
      return {
        ...result,
        ability: {
          ...ability,
          can: (action: string, resource: { envType?: string }) =>
            !denied(action, resource) && ability.can(action, resource),
        },
      };
    },
  };
};

const storedSecret = async (prisma: PrismaClient, key: string) =>
  JSON.stringify(await prisma.secretStore.findUnique({ where: { key } }));

describe("legacy MCP write tools", () => {
  postgresTest("set_webhook_secret output does not contain the secret", async ({ prisma }) => {
    const { a, identity, request, endpoint } = await seed(prisma);
    const secret = "whsec_super_secret_value";

    const result = await tool(webhooksWriteTools, "set_webhook_secret")(
      { projectRef: a.project.externalRef, environment: "prod", endpointId: "payments", secret },
      identity,
      request
    );

    expect(textOf(result)).toBe(`Stored the signing secret for ${endpoint.friendlyId}.`);
    expect(textOf(result)).not.toContain(secret);
  });

  // Catches: the pending record (and confirm page) holding the plaintext secret.
  postgresTest(
    "set_webhook_secret keeps the secret out of the pending preview",
    async ({ prisma }) => {
      const { a, identity, request } = await seed(prisma);
      resetConfirmations({ autoApprove: false });
      const secret = "whsec_super_secret_value";

      await expectPending(
        tool(webhooksWriteTools, "set_webhook_secret")(
          {
            projectRef: a.project.externalRef,
            environment: "prod",
            endpointId: "payments",
            secret,
          },
          identity,
          request
        )
      );

      const [record] = pending();
      expect(record!.preview).toContain("[redacted]");
      expect(JSON.stringify(record)).not.toContain(secret);
    }
  );

  postgresTest(
    "generate_webhook_secret rotates the stored secret and returns it once",
    async ({ prisma }) => {
      const { a, identity, request } = await seed(prisma);
      const generate = tool(webhooksWriteTools, "generate_webhook_secret");
      const args = {
        projectRef: a.project.externalRef,
        environment: "prod",
        endpointId: "payments",
      };

      const first = await generate(args, identity, request);
      const endpoint = await prisma.webhookEndpoint.findFirstOrThrow({
        where: { declaredId: "payments" },
      });
      const before = await storedSecret(prisma, endpoint.signingSecretKey!);
      const second = await generate(args, identity, request);
      const after = await storedSecret(prisma, endpoint.signingSecretKey!);

      const secret = textOf(first).match(/whsec_[0-9a-f]{64}/)![0];
      expect(textOf(first).split(secret)).toHaveLength(2);
      expect(before).not.toEqual(after);
      expect(after).not.toContain(secret);
      expect(textOf(second)).not.toContain(secret);
    }
  );

  postgresTest("resolve_alert changes the alert state", async ({ prisma }) => {
    const { a, identity, request, alert } = await seed(prisma);

    const result = await tool(alertsWriteTools, "resolve_alert")(
      { projectRef: a.project.externalRef, environment: "prod", alertId: alert.id },
      identity,
      request
    );

    expect(textOf(result)).toBe(`Alert ${alert.id} resolved.`);
    const row = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(row.attention).toBe("clear");
  });

  // Catches: a write running before approval, or an approval unlocking different args.
  postgresTest("resolve_alert waits for approval of the exact call", async ({ prisma }) => {
    const { a, identity, request, alert } = await seed(prisma);
    resetConfirmations({ autoApprove: false });
    const resolve = tool(alertsWriteTools, "resolve_alert");
    const args = { projectRef: a.project.externalRef, environment: "prod", alertId: alert.id };
    const attention = async () =>
      (await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).attention;

    const id = await expectPending(resolve(args, identity, request));
    expect(await attention()).toBe("needs_attention");
    expect(await getMcpConfirmationStore().approve(id, identity.userId)).toBe(true);

    await expectPending(resolve({ ...args, alertId: "alert_other" }, identity, request));
    expect(textOf(await resolve(args, identity, request))).toBe(`Alert ${alert.id} resolved.`);
    expect(await attention()).toBe("clear");
    expect(pending()).toHaveLength(1);
  });

  postgresTest("a non-member projectRef is denied by write tools", async ({ prisma }) => {
    const { b, identity, request, alert } = await seed(prisma);

    const result = await tool(alertsWriteTools, "resolve_alert")(
      { projectRef: b.project.externalRef, environment: "prod", alertId: alert.id },
      identity,
      request
    );

    expect(result).toMatchObject({ isError: true, content: [{ text: "Not authorized" }] });
    const row = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(row.attention).toBe("needs_attention");
  });

  postgresTest("submit_feedback is callable without a project", async ({ prisma }) => {
    const { identity, request } = await seed(prisma);
    resetConfirmations({ autoApprove: false });

    const captureFeedback = vi.fn();
    const result = await tool(createFeedbackTools({ captureFeedback }), "submit_feedback")(
      { message: "list_runs returned a confusing error" },
      identity,
      request
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("your feedback was sent");
    expect(captureFeedback).toHaveBeenCalledWith({
      userId: identity.userId,
      message: "list_runs returned a confusing error",
      toolName: undefined,
      projectRef: undefined,
    });
    expect(pending()).toHaveLength(0);
  });

  postgresTest(
    "create_alert creates the alert in the gate-resolved environment",
    async ({ prisma }) => {
      const { a, env, identity, request, alert } = await seed(prisma);
      await createRuntimeEnvironment(prisma, {
        projectId: a.project.id,
        organizationId: a.organization.id,
        type: "STAGING",
        slug: "stg",
      });
      const channel = await prisma.projectAlertChannel.create({
        data: {
          friendlyId: uniqueId("chan"),
          name: "ops",
          type: "EMAIL",
          properties: {},
          alertTypes: [],
          projectId: a.project.id,
        },
      });

      const result = await tool(alertsWriteTools, "create_alert")(
        {
          projectRef: a.project.externalRef,
          environment: "prod",
          capabilityKey: "queue.depth",
          params: { scope: { type: "all" } },
          condition: { kind: "threshold", operator: ">", value: 10, windowSec: 300 },
          behavior: {},
          notifiers: [{ type: "channel", channelId: channel.id }],
        },
        identity,
        request
      );

      expect(result.isError).toBeUndefined();
      const created = await prisma.alert.findFirstOrThrow({ where: { id: { not: alert.id } } });
      expect(textOf(result)).toBe(`Monitoring alert created: queue.depth (id=${created.id})`);
      expect(created.environmentId).toBe(env.id);
    }
  );

  postgresTest(
    "replay_webhook_delivery is denied without the trigger permission in the environment",
    async ({ prisma }) => {
      const { a, identity, request } = await seed(prisma);
      denyAbility((action, resource) => action === "trigger" && resource.envType === "PRODUCTION");

      const result = await tool(webhooksWriteTools, "replay_webhook_delivery")(
        { projectRef: a.project.externalRef, environment: "prod", deliveryId: "whd_orig" },
        identity,
        request
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("needs permissions you don't have: my-task");
    }
  );

  postgresTest(
    "replay_webhook_delivery cannot replay another environment's delivery",
    async ({ prisma }) => {
      const { a, identity, request } = await seed(prisma);
      mocks.deliveryEnvId = "env_other";

      const result = await tool(webhooksWriteTools, "replay_webhook_delivery")(
        { projectRef: a.project.externalRef, environment: "prod", deliveryId: "whd_orig" },
        identity,
        request
      );

      expect(result).toMatchObject({ isError: true });
      expect(textOf(result)).toContain("Webhook delivery not found");
    }
  );

  postgresTest(
    "resolve_alert is denied when the alert's own environment is not writable",
    async ({ prisma }) => {
      const { a, identity, request } = await seed(prisma);
      const dev = await createRuntimeEnvironment(prisma, {
        projectId: a.project.id,
        organizationId: a.organization.id,
        type: "DEVELOPMENT",
        slug: "dev",
      });
      const devAlert = await prisma.alert.create({
        data: {
          id: uniqueId("alert"),
          organizationId: a.organization.id,
          projectId: a.project.id,
          environmentId: dev.id,
          capabilityKey: "queue.depth",
          params: {},
          condition: {},
          attention: "needs_attention",
          createdBy: a.user.id,
        },
      });
      denyAbility((action, resource) => action === "write" && resource.envType === "DEVELOPMENT");

      const result = await tool(alertsWriteTools, "resolve_alert")(
        { projectRef: a.project.externalRef, environment: "prod", alertId: devAlert.id },
        identity,
        request
      );

      expect(result).toMatchObject({ isError: true });
      expect(textOf(result)).toContain("Not authorized");
      const row = await prisma.alert.findUniqueOrThrow({ where: { id: devAlert.id } });
      expect(row.attention).toBe("needs_attention");
    }
  );
});
