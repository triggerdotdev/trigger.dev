import type { ClickHouse } from "@internal/clickhouse";
import type { RedisOptions } from "@internal/redis";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/server";
import { containerTest } from "@internal/testcontainers";
import { WebhookEngine, type WebhookWaitpointPorts } from "@internal/webhook-engine";
import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
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
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  process.env.SESSION_SECRET = "test-user-actor-secret";

  const state = {
    db: undefined as unknown as Record<string | symbol, unknown>,
    rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
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
vi.mock("~/v3/webhookEngine.server", () => ({
  webhookEngine: {},
  webhookVerifyTokenKey: (endpointId: string) => `webhook:verify-token:${endpointId}`,
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

import type { McpIdentity } from "~/mcp/gate/types";
import { webhooksTools } from "~/mcp/tools/webhooks.server";
import {
  pausePreview,
  removeSecretPreview,
  resumePreview,
  verifyTokenPreview,
  createWebhooksEndpointWriteTools,
} from "~/mcp/tools/webhooksEndpointWrite.server";
import {
  createWebhooksReadTools,
  WEBHOOKS_NOT_AVAILABLE,
  WEBHOOKS_NOT_ENABLED,
} from "~/mcp/tools/webhooksRead.server";
import { createWebhookWaiterWriteTools } from "~/mcp/tools/webhooksWaiterWrite.server";
import type { McpToolDefinition } from "~/mcp/registry.server";
import { mcpResource } from "~/services/oauth/metadata.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { webhookVerifyTokenKey } from "~/v3/webhookEngine.server";
import { activeSigningSecrets, StoredSigningSecret } from "~/v3/webhookSigningSecret";
import { webhookHttpResponseFor } from "~/v3/webhookIngressResponse.server";
import {
  storeWebhookSigningSecret,
  webhookSigningSecretKey,
} from "~/v3/webhookSigningSecret.server";
import { approveAll, expectPending, pending, resetConfirmations } from "./helpers/mcpConfirm";

const NO_HANDSHAKE_ARTIFACT = {
  kind: "config",
  config: {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "hex",
    signatureHeader: "stripe-signature",
    signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
    timestamp: { source: { from: "signatureField", field: "t" }, toleranceSeconds: 300 },
    signingString: { template: "{timestamp}.{body}" },
    idempotencyField: { from: "body", name: "id" },
  },
};

const VERIFIER_ARTIFACT = {
  ...NO_HANDSHAKE_ARTIFACT,
  getHandshake: { tokenParam: "hub.verify_token", challengeParam: "hub.challenge" },
};

type Scope = { organizationId: string; projectId: string; environmentId: string };

const WRITE_TOOLS = [
  "remove_webhook_secret",
  "generate_webhook_verify_token",
  "pause_webhook_endpoint",
  "resume_webhook_endpoint",
];

const VerifyToken = z.object({ token: z.string() });

function prismaWaitpoints(prisma: PrismaClient): WebhookWaitpointPorts {
  return {
    find: async ({ environmentId, idempotencyKey }) => {
      const row = await prisma.waitpoint.findFirst({
        where: { environmentId, idempotencyKey },
      });
      return row
        ? {
            id: row.friendlyId,
            status: row.status,
            timeoutAt: row.completedAfter ?? undefined,
            tags: row.tags,
          }
        : undefined;
    },
    create: async ({ environmentId, projectId, idempotencyKey, timeoutAt, tags }) => {
      const row = await prisma.waitpoint.create({
        data: {
          friendlyId: `waitpoint_${randomBytes(12).toString("hex")}`,
          type: "MANUAL",
          idempotencyKey,
          userProvidedIdempotencyKey: false,
          completedAfter: timeoutAt,
          tags,
          environmentId,
          projectId,
        },
      });
      return { id: row.friendlyId, isCached: false };
    },
    complete: async ({ waitpointIds, output }) => {
      await prisma.waitpoint.updateMany({
        where: { friendlyId: { in: waitpointIds }, status: "PENDING" },
        data: { status: "COMPLETED", completedAt: new Date(), output: JSON.stringify(output) },
      });
      return waitpointIds.map((id) => ({ id, ok: true }));
    },
    fail: async ({ waitpointId, error }) => {
      if (!(await prisma.waitpoint.findFirst({ where: { friendlyId: waitpointId } }))) {
        throw new Error("Waitpoint not found");
      }
      await prisma.waitpoint.updateMany({
        where: { friendlyId: waitpointId, status: "PENDING" },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: JSON.stringify(error),
          outputIsError: true,
        },
      });
    },
  };
}

function realEngine(prisma: PrismaClient, redisOptions: RedisOptions, disabled: boolean) {
  const secrets = getSecretStore("DATABASE", { prismaClient: prisma });
  const engine = new WebhookEngine({
    disabled,
    prisma,
    redis: redisOptions,
    worker: { concurrency: 1, disabled: true },
    triggerTask: async () => ({ success: false, error: "unused" }),
    resolveSigningSecret: async (key) => {
      const stored = await secrets.getSecret(StoredSigningSecret, key);
      const active = activeSigningSecrets(stored, new Date());
      return active.length > 0 ? active : undefined;
    },
    resolveVerifyToken: async (endpointId) =>
      (await secrets.getSecret(VerifyToken, webhookVerifyTokenKey(endpointId)))?.token,
    waiters: {
      urlSecret: "waiter-url-secret",
      waitpoints: prismaWaitpoints(prisma),
    },
    logLevel: "error",
  });
  onTestFinished(() => engine.quit());
  return engine;
}

async function createEndpoint(prisma: PrismaClient, scope: Scope, options = { handshake: true }) {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      friendlyId: `wh_${randomBytes(10).toString("hex")}`,
      opaqueId: uniqueId("opaque"),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runtimeEnvironmentId: scope.environmentId,
      environmentType: "PRODUCTION",
      source: "whatsapp",
      declaredId: "payments",
      routingTargets: [],
      verifierArtifact: options.handshake ? VERIFIER_ARTIFACT : NO_HANDSHAKE_ARTIFACT,
    },
  });
  await storeWebhookSigningSecret(endpoint, `whsec_${randomBytes(16).toString("hex")}`);
  return endpoint;
}

async function seed(prisma: PrismaClient, redisOptions: RedisOptions, engineDisabled = false) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: "test-user-actor-secret" }
  ) as any;
  resetConfirmations({ autoApprove: true });

  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  await prisma.organization.update({
    where: { id: a.organization.id },
    data: { featureFlags: { hasWebhooksAccess: true } },
  });
  const sameOrgProject = await prisma.project.create({
    data: {
      name: "Other",
      slug: uniqueId("proj"),
      organizationId: a.organization.id,
      externalRef: uniqueId("ext"),
    },
  });
  const env = (projectId: string, organizationId: string, slug?: string) =>
    createRuntimeEnvironment(prisma, { projectId, organizationId, type: "PRODUCTION", slug });
  const scopeOf = (e: { id: string; projectId: string; organizationId: string }): Scope => ({
    organizationId: e.organizationId,
    projectId: e.projectId,
    environmentId: e.id,
  });
  const own = scopeOf(await env(a.project.id, a.organization.id, "prod"));
  const foreign = {
    sameProject: scopeOf(await env(a.project.id, a.organization.id, "stg")),
    sameOrg: scopeOf(await env(sameOrgProject.id, a.organization.id)),
    otherOrg: scopeOf(await env(b.project.id, b.organization.id)),
  };

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

  const invoke = (
    tools: McpToolDefinition[],
    name: string,
    args: Record<string, unknown>,
    caller = { identity, request }
  ) =>
    tools
      .find((t) => t.name === name)!
      .handler(
        { projectRef: a.project.externalRef, environment: "prod", ...args },
        caller.identity,
        caller.request
      );
  const call = (name: string, args: Record<string, unknown>) =>
    invoke(
      [...createWebhooksEndpointWriteTools({ enabled: () => !engineDisabled }), ...webhooksTools],
      name,
      args
    );

  return {
    a,
    own,
    foreign,
    call,
    invoke,
    setEngineDisabled: (value: boolean) => {
      engineDisabled = value;
    },
    patId: token.id,
    engine: realEngine(prisma, redisOptions, engineDisabled),
  };
}

const textOf = (result: { content: unknown[] }) =>
  (result.content as { text: string }[]).map((c) => c.text).join("\n");

const verifyToken = (prisma: PrismaClient, endpointId: string) =>
  getSecretStore("DATABASE", { prismaClient: prisma }).getSecret(
    VerifyToken,
    webhookVerifyTokenKey(endpointId)
  );

const unsignedDelivery = (opaqueId: string) => ({
  opaqueId,
  rawBytes: new TextEncoder().encode(JSON.stringify({ id: "evt_1" })),
  headers: { "content-type": "application/json" },
  url: `https://api.example.com/webhooks/v1/ingest/${opaqueId}`,
});

describe("hosted webhook endpoint write tools", () => {
  // Catches: remove_webhook_secret running before approval, or not clearing the secret the engine verifies with.
  containerTest(
    "remove_webhook_secret waits for approval, then the engine rejects deliveries for a missing secret",
    async ({ prisma, redisOptions }) => {
      const { call, own, engine } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      resetConfirmations({ autoApprove: false });

      await expectPending(call("remove_webhook_secret", { endpointId: "payments" }));
      const beforeApproval = await engine.ingest(unsignedDelivery(endpoint.opaqueId));
      await approveAll();
      const result = await call("remove_webhook_secret", { endpointId: "payments" });
      const afterApproval = await engine.ingest(unsignedDelivery(endpoint.opaqueId));

      expect(beforeApproval.outcome).toBe("verification_failed");
      expect(result.isError).toBeUndefined();
      expect(afterApproval.outcome).toBe("secret_missing");
      expect(await prisma.webhookEndpoint.findFirst({ where: { id: endpoint.id } })).toMatchObject({
        signingSecretKey: null,
      });
    }
  );

  // Catches: the token stored under another key, returned more than once, put in the pending preview, or shown by a later read tool.
  containerTest(
    "generate_webhook_verify_token sets the token the engine verifies and returns it only once",
    async ({ prisma, redisOptions }) => {
      const { call, own, engine } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      resetConfirmations({ autoApprove: false });

      await expectPending(call("generate_webhook_verify_token", { endpointId: "payments" }));
      expect(await verifyToken(prisma, endpoint.id)).toBeUndefined();
      await approveAll();
      const result = await call("generate_webhook_verify_token", { endpointId: "payments" });
      const token = textOf(result).match(/whvt_[0-9a-f]{48}/)![0];
      const handshake = await engine.verifyGetHandshake({
        opaqueId: endpoint.opaqueId,
        query: { "hub.verify_token": token, "hub.challenge": "c-123" },
      });
      await expectPending(call("generate_webhook_verify_token", { endpointId: "payments" }));
      expect(JSON.stringify(pending())).not.toMatch(/whvt_/);
      await approveAll();
      const second = textOf(
        await call("generate_webhook_verify_token", { endpointId: "payments" })
      );
      const secondToken = second.match(/whvt_[0-9a-f]{48}/)![0];
      const handshakeWith = async (value: string) =>
        (
          await engine.verifyGetHandshake({
            opaqueId: endpoint.opaqueId,
            query: { "hub.verify_token": value, "hub.challenge": "c-123" },
          })
        ).outcome;
      const later = [
        textOf(await call("list_webhook_endpoints", {})),
        textOf(await call("get_webhook_endpoint_details", { endpointId: "payments" })),
      ];

      expect(textOf(result).split(token)).toHaveLength(2);
      expect(handshake).toMatchObject({ outcome: "handshake", body: "c-123" });
      expect(second).not.toContain(token);
      expect([await handshakeWith(token), await handshakeWith(secondToken)]).toEqual([
        "verification_failed",
        "handshake",
      ]);
      expect(later.join("\n")).not.toMatch(/whvt_/);
    }
  );

  // Catches: a confirmation asked for a source that never verifies its URL with a GET request, or a token minted for it.
  containerTest(
    "generate_webhook_verify_token refuses a source without a GET handshake before any confirmation",
    async ({ prisma, redisOptions }) => {
      const { call, own } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own, { handshake: false });
      resetConfirmations({ autoApprove: false });

      const result = await call("generate_webhook_verify_token", { endpointId: "payments" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "This endpoint's source does not verify its URL with a GET request."
      );
      expect(pending()).toEqual([]);
      expect(await verifyToken(prisma, endpoint.id)).toBeUndefined();
    }
  );

  // Catches: a no-op reaching a confirmation, or writing: a second pause rewriting manuallyDeactivatedAt, resuming an active endpoint moving updatedAt, or removing a missing secret asking to confirm.
  containerTest(
    "pause, resume and remove_webhook_secret refuse a no-op before any confirmation and write nothing",
    async ({ prisma, redisOptions }) => {
      const { call, own } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const row = () => prisma.webhookEndpoint.findFirstOrThrow({ where: { id: endpoint.id } });
      const args = { endpointId: "payments" };
      const created = await row();
      const open: number[] = [];
      resetConfirmations({ autoApprove: false });
      const resumeActive = await call("resume_webhook_endpoint", args);
      open.push(pending().length);
      const afterResumeActive = await row();
      resetConfirmations({ autoApprove: true });
      await call("pause_webhook_endpoint", args);
      const paused = await row();
      resetConfirmations({ autoApprove: false });
      const pauseAgain = await call("pause_webhook_endpoint", args);
      open.push(pending().length);
      const afterPauseAgain = await row();
      resetConfirmations({ autoApprove: true });
      const pauseAutoApproved = await call("pause_webhook_endpoint", args);
      const afterAutoApproved = await row();
      await call("remove_webhook_secret", args);
      resetConfirmations({ autoApprove: false });
      const removeAgain = await call("remove_webhook_secret", args);
      open.push(pending().length);

      expect([resumeActive, pauseAgain, removeAgain].map((r) => [r.isError, textOf(r)])).toEqual([
        [true, 'Endpoint "payments" is not paused; nothing changed.'],
        [true, 'Endpoint "payments" is already paused; nothing changed.'],
        [true, 'Endpoint "payments" has no signing secret; nothing changed.'],
      ]);
      expect(open).toEqual([0, 0, 0]);
      expect(afterResumeActive.updatedAt).toEqual(created.updatedAt);
      expect([pauseAutoApproved.isError, textOf(pauseAutoApproved)]).toEqual([
        true,
        JSON.stringify({ error: 'Endpoint "payments" is already paused; nothing changed.' }),
      ]);
      expect(afterAutoApproved.manuallyDeactivatedAt).toEqual(paused.manuallyDeactivatedAt);
      expect(afterPauseAgain.manuallyDeactivatedAt).toEqual(paused.manuallyDeactivatedAt);
      expect(afterPauseAgain.updatedAt).toEqual(paused.updatedAt);
    }
  );

  // Catches: the engine-disabled guard missing from any write tool, so it asks for a confirmation or reports a generic failure.
  containerTest(
    "every write tool says webhooks are not enabled when the engine is disabled, before any confirmation",
    async ({ prisma, redisOptions }) => {
      const { own, call, waiterCall } = await waiterTools(prisma, redisOptions, true);
      await createEndpoint(prisma, own);
      resetConfirmations({ autoApprove: false });
      const endpointId = "payments";

      const outcomes = [];
      for (const [name, args] of [
        ["remove_webhook_secret", { endpointId }],
        ["generate_webhook_verify_token", { endpointId }],
        ["pause_webhook_endpoint", { endpointId }],
        ["resume_webhook_endpoint", { endpointId }],
        ["cancel_webhook_waiter", { endpointId, waiterId: "waitpoint_abc" }],
      ] as const) {
        const result = await (name === "cancel_webhook_waiter" ? waiterCall : call)(name, args);
        outcomes.push([name, result.isError, textOf(result)]);
      }

      expect(outcomes).toEqual(
        [
          "remove_webhook_secret",
          "generate_webhook_verify_token",
          "pause_webhook_endpoint",
          "resume_webhook_endpoint",
          "cancel_webhook_waiter",
        ].map((name) => [name, true, WEBHOOKS_NOT_ENABLED])
      );
      expect(pending()).toEqual([]);
    }
  );

  // Catches: a preview claim the engine contradicts, or a no-op reported as a change.
  containerTest(
    "remove and pause previews match what the engine then does, and repeats say nothing changed",
    async ({ prisma, redisOptions }) => {
      const { call, own, engine } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      await storeWebhookSigningSecret(endpoint, `whsec_${randomBytes(16).toString("hex")}`, {
        previousSecretTtlSeconds: 3600,
      });
      const token = textOf(
        await call("generate_webhook_verify_token", { endpointId: "payments" })
      ).match(/whvt_[0-9a-f]{48}/)![0];
      const deliveries = () =>
        prisma.webhookDelivery.count({ where: { webhookEndpointId: endpoint.id } });
      const ingest = async () => {
        const result = await engine.ingest(unsignedDelivery(endpoint.opaqueId));
        return { outcome: result.outcome, status: webhookHttpResponseFor(result).status };
      };
      const handshake = async () =>
        (
          await engine.verifyGetHandshake({
            opaqueId: endpoint.opaqueId,
            query: { "hub.verify_token": token, "hub.challenge": "c" },
          })
        ).outcome;

      const removed = textOf(await call("remove_webhook_secret", { endpointId: "payments" }));
      const afterRemove = {
        stored: await getSecretStore("DATABASE", { prismaClient: prisma }).getSecret(
          StoredSigningSecret,
          webhookSigningSecretKey(endpoint.id)
        ),
        ingest: await ingest(),
        recorded: await deliveries(),
        handshake: await handshake(),
        repeat: textOf(await call("remove_webhook_secret", { endpointId: "payments" })),
      };
      await storeWebhookSigningSecret(endpoint, `whsec_${randomBytes(16).toString("hex")}`);
      const paused = textOf(await call("pause_webhook_endpoint", { endpointId: "payments" }));
      const afterPause = {
        ingest: await ingest(),
        recorded: await deliveries(),
        handshake: await handshake(),
        testSend: (await engine.simulateInject(unsignedDelivery(endpoint.opaqueId))).outcome,
        newWaiter: (
          await engine.createWaiter({
            environmentId: own.environmentId,
            projectId: own.projectId,
            endpoint: endpoint.friendlyId,
            match: { "event.id": "evt_1" },
          })
        ).outcome,
        repeat: textOf(await call("pause_webhook_endpoint", { endpointId: "payments" })),
      };

      expect(removed).toContain("Removed the signing secret");
      expect(afterRemove).toEqual({
        stored: undefined,
        ingest: { outcome: "secret_missing", status: 400 },
        recorded: 0,
        handshake: "handshake",
        repeat: JSON.stringify({
          error: 'Endpoint "payments" has no signing secret; nothing changed.',
        }),
      });
      expect(paused).toBe(`Paused ${endpoint.friendlyId}.`);
      expect(afterPause).toEqual({
        ingest: { outcome: "endpoint_inactive", status: 404 },
        recorded: 0,
        handshake: "endpoint_inactive",
        testSend: "endpoint_inactive",
        newWaiter: "endpoint_not_found",
        repeat: JSON.stringify({
          error: 'Endpoint "payments" is already paused; nothing changed.',
        }),
      });
    }
  );

  // Catches: pause or resume running before approval, or not changing the status the engine checks on ingest.
  containerTest(
    "pause_webhook_endpoint waits for approval, then ingest is refused until resume_webhook_endpoint",
    async ({ prisma, redisOptions }) => {
      const { call, own, engine } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const ingest = async () => (await engine.ingest(unsignedDelivery(endpoint.opaqueId))).outcome;
      resetConfirmations({ autoApprove: false });

      await expectPending(call("pause_webhook_endpoint", { endpointId: "payments" }));
      const beforeApproval = await ingest();
      await approveAll();
      await call("pause_webhook_endpoint", { endpointId: "payments" });
      const paused = await ingest();
      const pausedRow = await prisma.webhookEndpoint.findFirstOrThrow({
        where: { id: endpoint.id },
      });
      await expectPending(call("resume_webhook_endpoint", { endpointId: "payments" }));
      const resumeBeforeApproval = await ingest();
      await approveAll();
      await call("resume_webhook_endpoint", { endpointId: "payments" });
      const resumed = await ingest();

      expect([beforeApproval, paused, resumeBeforeApproval, resumed]).toEqual([
        "verification_failed",
        "endpoint_inactive",
        "endpoint_inactive",
        "verification_failed",
      ]);
      expect(pausedRow.manuallyDeactivatedAt).not.toBeNull();
      expect(
        await prisma.webhookEndpoint.findFirstOrThrow({ where: { id: endpoint.id } })
      ).toMatchObject({ status: "ACTIVE", manuallyDeactivatedAt: null });
    }
  );

  // Catches: an approved call acting on state that changed after approval: resuming an endpoint another call already resumed, a handshake source refused as plain text, or a run-time engine-disabled guard missing from an endpoint write or cancel.
  containerTest(
    "approved calls re-check at run time and refuse with an error",
    async ({ prisma, redisOptions }) => {
      const { own, call, waiterCall, engine, setEngineDisabled } = await waiterTools(
        prisma,
        redisOptions
      );
      const endpoint = await createEndpoint(prisma, own);
      const row = () => prisma.webhookEndpoint.findFirstOrThrow({ where: { id: endpoint.id } });
      const args = { endpointId: "payments" };
      const approved = async (run: () => Promise<unknown>) => {
        resetConfirmations({ autoApprove: false });
        await expectPending(run());
        await approveAll();
      };
      const refused = (result: { isError?: boolean; content: unknown[] }) => [
        result.isError,
        textOf(result),
      ];

      await prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { status: "INACTIVE", manuallyDeactivatedAt: new Date() },
      });
      await approved(() => call("resume_webhook_endpoint", args));
      await prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { status: "ACTIVE", manuallyDeactivatedAt: null },
      });
      const beforeResume = await row();
      const resume = await call("resume_webhook_endpoint", args);
      const afterResume = await row();

      await approved(() => call("generate_webhook_verify_token", args));
      await prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { verifierArtifact: NO_HANDSHAKE_ARTIFACT },
      });
      const handshake = await call("generate_webhook_verify_token", args);

      await approved(() => call("pause_webhook_endpoint", args));
      setEngineDisabled(true);
      const pause = await call("pause_webhook_endpoint", args);
      setEngineDisabled(false);
      const waiterId = await waiterOn(engine, endpoint, { "event.id": "evt_disabled" });
      const cancelArgs = { ...args, waiterId };
      await approved(() => waiterCall("cancel_webhook_waiter", cancelArgs));
      setEngineDisabled(true);
      const cancel = await waiterCall("cancel_webhook_waiter", cancelArgs);

      expect(refused(resume)).toEqual([
        true,
        JSON.stringify({ error: 'Endpoint "payments" is not paused; nothing changed.' }),
      ]);
      expect(afterResume.updatedAt).toEqual(beforeResume.updatedAt);
      expect(refused(handshake)).toEqual([
        true,
        JSON.stringify({
          error: "This endpoint's source does not verify its URL with a GET request.",
        }),
      ]);
      expect(await verifyToken(prisma, endpoint.id)).toBeUndefined();
      expect([refused(pause), refused(cancel)]).toEqual([
        [true, JSON.stringify({ error: WEBHOOKS_NOT_ENABLED })],
        [true, JSON.stringify({ error: WEBHOOKS_NOT_ENABLED })],
      ]);
      expect((await row()).manuallyDeactivatedAt).toBeNull();
      expect(await waitpointRow(prisma, waiterId)).toMatchObject({ status: "PENDING" });
    }
  );

  // Catches: remove_webhook_secret refusing as a no-op when a secret sits in the store without the endpoint pointing at it (an interrupted adopt), so the leftover is never cleared.
  containerTest(
    "remove_webhook_secret offers a confirmation for a stored secret the endpoint does not point at, then clears it",
    async ({ prisma, redisOptions }) => {
      const { call, own } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      await prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { signingSecretKey: null },
      });
      const stored = () =>
        getSecretStore("DATABASE", { prismaClient: prisma }).getSecret(
          StoredSigningSecret,
          webhookSigningSecretKey(endpoint.id)
        );
      resetConfirmations({ autoApprove: false });

      await expectPending(call("remove_webhook_secret", { endpointId: "payments" }));
      const before = await stored();
      await approveAll();
      const result = await call("remove_webhook_secret", { endpointId: "payments" });

      expect(before).toBeDefined();
      expect(result.isError).toBeUndefined();
      expect(await stored()).toBeUndefined();
    }
  );

  // Catches: a consequence the code has dropped from a preview, or the endpoint name printed with raw line or bidirectional control characters.
  it("previews name every consequence and escape the endpoint name", () => {
    const endpointId = "pay\u2028ments\u202e\u0085\u200b\ufeff\u007f";
    const cases: Array<[string, string, RegExp[]]> = [
      [
        "remove_webhook_secret",
        removeSecretPreview({ endpointId }),
        [
          /stored secret is deleted/,
          /replaced secret that is still accepted during a rotation/,
          /cannot be recovered/,
          /every delivery to the endpoint is rejected and not recorded/,
          /signed test sends fail/,
          /next secret the provider sends becomes the endpoint's secret/,
          /verification token is not changed/,
        ],
      ],
      [
        "generate_webhook_verify_token",
        verifyTokenPreview({ endpointId }),
        [/replaces the current token/, /succeeds only with the new token/],
      ],
      [
        "pause_webhook_endpoint",
        pausePreview({ endpointId }),
        [
          /answered 404 and not recorded/,
          /events the provider sends while it is paused are lost/,
          /URL verification and test sends fail/,
          /No new waiters can be created/,
          /runs already waiting on it are not resumed by new events/,
          /Deliveries already accepted still run, and replays still work/,
          /A deploy does not resume it/,
        ],
      ],
      [
        "resume_webhook_endpoint",
        resumePreview({ endpointId }),
        [
          /accepts deliveries again/,
          /Events sent while it was paused are not recovered/,
          /reactivates an endpoint that is inactive because the current version no longer declares it/,
          /deliveries then go to the subscribers of the version that last declared it/,
          /next deploy that still leaves it out makes it inactive again/,
        ],
      ],
    ];

    const missing = cases.flatMap(([name, preview, effects]) => [
      ...effects.filter((effect) => !effect.test(preview)).map((effect) => `${name}: ${effect}`),
      ...(preview.includes('"pay\\u2028ments\\u202e\\u0085\\u200b\\ufeff\\u007f"')
        ? []
        : [`${name}: escaped name`]),
      ...(/[\u2028\u202e\u0085\u200b\ufeff\u007f]/.test(preview)
        ? [`${name}: raw control character`]
        : []),
    ]);

    expect(missing).toEqual([]);
  });

  // Catches: dropping the environment condition so an endpoint from another environment, project or organization is changed.
  containerTest(
    "every tool treats another environment's, project's or organization's endpoint as not found",
    async ({ prisma, redisOptions }) => {
      const { call, foreign } = await seed(prisma, redisOptions);
      const tools = WRITE_TOOLS;

      const outcomes: Record<string, string> = {};
      for (const [where, scope] of Object.entries(foreign)) {
        const endpoint = await createEndpoint(prisma, scope);
        for (const name of tools) {
          outcomes[`${name} ${where}`] = textOf(
            await call(name, { endpointId: endpoint.friendlyId })
          );
        }
        const after = await prisma.webhookEndpoint.findFirstOrThrow({ where: { id: endpoint.id } });
        outcomes[`${where} unchanged`] = String(
          after.signingSecretKey !== null &&
            after.status === "ACTIVE" &&
            !(await verifyToken(prisma, endpoint.id))
        );
      }

      const notFound = JSON.stringify({ error: "Webhook endpoint not found" });
      expect(outcomes).toEqual(
        Object.fromEntries(
          Object.keys(foreign).flatMap((where) => [
            ...tools.map((name) => [`${name} ${where}`, notFound]),
            [`${where} unchanged`, "true"],
          ])
        )
      );
    }
  );

  // Catches: the organization webhooks access check removed from a tool.
  containerTest(
    "every tool says webhooks are not available without the feature and changes nothing",
    async ({ prisma, redisOptions }) => {
      const { a, call, own } = await seed(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      await prisma.organization.update({
        where: { id: a.organization.id },
        data: { featureFlags: {} },
      });
      const tools = WRITE_TOOLS;

      const outcomes: Record<string, string> = {};
      for (const name of tools) {
        outcomes[name] = textOf(await call(name, { endpointId: "payments" }));
      }
      const after = await prisma.webhookEndpoint.findFirstOrThrow({ where: { id: endpoint.id } });

      expect(outcomes).toEqual(
        Object.fromEntries(
          tools.map((name) => [name, JSON.stringify({ error: WEBHOOKS_NOT_AVAILABLE })])
        )
      );
      expect(after).toMatchObject({ status: "ACTIVE", manuallyDeactivatedAt: null });
      expect(after.signingSecretKey).not.toBeNull();
      expect(await verifyToken(prisma, endpoint.id)).toBeUndefined();
    }
  );

  // Catches: a preview offered for approval although the organization has no webhooks, so the human approves a change the run then refuses.
  containerTest(
    "every tool refuses before a confirmation exists when the organization has no webhooks",
    async ({ prisma, redisOptions }) => {
      const { a, call, own } = await seed(prisma, redisOptions);
      await createEndpoint(prisma, own);
      await prisma.organization.update({
        where: { id: a.organization.id },
        data: { featureFlags: {} },
      });
      resetConfirmations({ autoApprove: false });

      const outcomes: Record<string, string> = {};
      for (const name of WRITE_TOOLS) {
        outcomes[name] = textOf(await call(name, { endpointId: "payments" }));
      }

      expect(outcomes).toEqual(
        Object.fromEntries(WRITE_TOOLS.map((name) => [name, WEBHOOKS_NOT_AVAILABLE]))
      );
      expect(pending()).toEqual([]);
    }
  );

  // Catches: the endpoint id length bound removed, letting a preview outgrow the confirmation store.
  containerTest(
    "an oversized endpoint id is refused before a confirmation is created",
    async ({ prisma, redisOptions }) => {
      const { call } = await seed(prisma, redisOptions);
      resetConfirmations({ autoApprove: false });

      const result = await call("remove_webhook_secret", { endpointId: "x".repeat(201) });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid arguments");
      expect(pending()).toEqual([]);
    }
  );
});

const DELIVERY_SECRET = "whsec_waiter_test_secret";

function liveWaiterEngine(prisma: PrismaClient, redisOptions: RedisOptions, disabled: boolean) {
  const engine = new WebhookEngine({
    disabled,
    prisma,
    redis: redisOptions,
    worker: { concurrency: 1, pollIntervalMs: 50, retryBaseDelayMs: 20 },
    triggerTask: async () => ({ success: false, error: "unused" }),
    resolveSigningSecret: async () => DELIVERY_SECRET,
    waiters: {
      urlSecret: "waiter-url-secret",
      waitpoints: prismaWaitpoints(prisma),
    },
    logLevel: "error",
  });
  onTestFinished(() => engine.quit());
  return engine;
}

async function waiterOn(
  engine: WebhookEngine,
  endpoint: { friendlyId: string; runtimeEnvironmentId: string; projectId: string },
  match: Record<string, string>
) {
  const result = await engine.createWaiter({
    environmentId: endpoint.runtimeEnvironmentId,
    projectId: endpoint.projectId,
    endpoint: endpoint.friendlyId,
    match,
  });
  if (result.outcome !== "created") throw new Error(`createWaiter ${JSON.stringify(result)}`);
  return result.id;
}

function signedDelivery(opaqueId: string, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", DELIVERY_SECRET).update(`${t}.${body}`).digest("hex");
  return {
    opaqueId,
    rawBytes: new TextEncoder().encode(body),
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    url: `https://api.example.com/webhooks/v1/ingest/${opaqueId}`,
  };
}

async function waiterTools(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  engineDisabled = false
) {
  const seeded = await seed(prisma, redisOptions, engineDisabled);
  const engine = liveWaiterEngine(prisma, redisOptions, engineDisabled);
  const tools = [
    ...createWebhookWaiterWriteTools(engine, () => !engineDisabled),
    ...createWebhooksReadTools({
      clickhouse: async () => ({}) as ClickHouse,
      listWaiters: (input) => engine.listWaiters(input),
      enabled: () => !engineDisabled,
    }),
  ];
  const uat = async (cap: string[]) => {
    const token = await signUserActorToken("test-user-actor-secret", {
      userId: seeded.a.user.id,
      client: "mcp",
      pat: seeded.patId,
      audience: mcpResource(),
      cap,
    });
    return {
      identity: {
        kind: "uat",
        userId: seeded.a.user.id,
        sourceTokenId: seeded.patId,
        cap,
      } as McpIdentity,
      request: new Request("https://api.trigger.dev/mcp", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    };
  };
  return {
    ...seeded,
    setEngineDisabled: (value: boolean) => {
      engineDisabled = value;
      seeded.setEngineDisabled(value);
    },
    engine,
    uat,
    waiterCall: (
      name: string,
      args: Record<string, unknown>,
      caller?: Awaited<ReturnType<typeof uat>>
    ) => seeded.invoke(tools, name, args, caller),
  };
}

const waitpointRow = (prisma: PrismaClient, friendlyId: string) =>
  prisma.waitpoint.findFirstOrThrow({
    where: { friendlyId },
    select: { status: true, outputIsError: true, output: true },
  });

async function pendingMessage(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(UrlElicitationRequiredError);
  return (error as Error).message;
}

describe("cancel_webhook_waiter", () => {
  // Catches: cancelling before approval, a preview that differs from what cancelling does, a header value from the match shown anywhere, or the waitpoint not failed.
  containerTest(
    "shows the exact preview, changes nothing before approval, then fails the waiter's waitpoint",
    async ({ prisma, redisOptions }) => {
      const { own, engine, waiterCall } = await waiterTools(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const waiterId = await waiterOn(engine, endpoint, {
        "event.data.orderId": "BODY_1",
        "header.x-kind": "HEADER_MARK",
      });
      const args = { endpointId: "payments", waiterId };
      resetConfirmations({ autoApprove: false });

      const message = await pendingMessage(waiterCall("cancel_webhook_waiter", args));
      const [record] = pending();
      const before = await waitpointRow(prisma, waiterId);
      await approveAll();
      const result = await waiterCall("cancel_webhook_waiter", args);
      const listed = textOf(await waiterCall("list_webhook_waiters", { endpointId: "payments" }));
      const after = await waitpointRow(prisma, waiterId);

      expect(record!.preview).toBe(
        [
          `Cancel webhook waiter ${waiterId} on endpoint ${endpoint.friendlyId}. Match: "event.data.orderId = \\"BODY_1\\", header.x-kind = (value hidden)". Filter: none. Header values in conditions are hidden.`,
          "1. The waiter is removed, so no delivery can match it any more, and its slot is freed.",
          '2. Its waitpoint is completed with an error: WebhookWaiterCancelledError, "The webhook waiter was cancelled".',
          "3. Every run waiting on that waitpoint resumes with that error: webhooks.waiter.wait returns { ok: false } and .unwrap() throws it. The runs are not cancelled; what they do next is up to the task code.",
          "4. No event is delivered to the task.",
          "5. It cannot be undone: to wait again, the task has to create a new waiter.",
          "If a delivery claims the waiter first, nothing is cancelled: the waiter stays with that delivery, which resumes its runs with its event unless completing them fails.",
        ].join("\n")
      );
      expect(before).toMatchObject({ status: "PENDING" });
      expect(textOf(result)).toBe(
        `Cancelled waiter ${waiterId}. Its waitpoint was completed with WebhookWaiterCancelledError, so the runs waiting on it resume with that error.`
      );
      expect(listed).not.toContain(waiterId);
      expect(after).toMatchObject({ status: "COMPLETED", outputIsError: true });
      expect(after.output).toContain("WebhookWaiterCancelledError");
      expect(
        [message, record!.preview, textOf(result)].filter((t) => t.includes("HEADER_MARK"))
      ).toEqual([]);
    }
  );

  // Catches: dropping the environment condition so a waiter on another environment's, project's or organization's endpoint is cancelled.
  containerTest(
    "treats another environment's, project's or organization's waiter as not found",
    async ({ prisma, redisOptions }) => {
      const { own, foreign, engine, waiterCall } = await waiterTools(prisma, redisOptions);
      const ownEndpoint = await createEndpoint(prisma, own);
      const outcomes: Record<string, string> = {};
      const waiters: string[] = [];
      for (const [where, scope] of Object.entries(foreign)) {
        const endpoint = await createEndpoint(prisma, scope);
        const waiterId = await waiterOn(engine, endpoint, { "event.id": where });
        waiters.push(waiterId);
        outcomes[`${where} by wh_ id`] = textOf(
          await waiterCall("cancel_webhook_waiter", { endpointId: endpoint.friendlyId, waiterId })
        );
        outcomes[`${where} on own endpoint`] = textOf(
          await waiterCall("cancel_webhook_waiter", {
            endpointId: ownEndpoint.friendlyId,
            waiterId,
          })
        );
      }
      const rows = await Promise.all(waiters.map((id) => waitpointRow(prisma, id)));

      expect(outcomes).toEqual(
        Object.fromEntries(
          Object.keys(foreign).flatMap((where, i) => [
            [`${where} by wh_ id`, JSON.stringify({ error: "Webhook endpoint not found" })],
            [
              `${where} on own endpoint`,
              `Waiter ${waiters[i]} is no longer waiting on this endpoint: a delivery matched it, it timed out or it was cancelled earlier. Nothing was cancelled.`,
            ],
          ])
        )
      );
      expect(rows.map((row) => row.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    }
  );

  // Catches: the tool gated on write:webhooks or a read scope instead of write:waitpoints.
  containerTest(
    "denies a caller without write:waitpoints, even with write:webhooks",
    async ({ prisma, redisOptions }) => {
      const { own, engine, waiterCall, uat } = await waiterTools(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const waiterId = await waiterOn(engine, endpoint, { "event.id": "evt_1" });
      const args = { endpointId: "payments", waiterId };

      const outcomes = [];
      for (const cap of [["read:webhooks"], ["write:webhooks", "read:webhooks"]]) {
        outcomes.push(textOf(await waiterCall("cancel_webhook_waiter", args, await uat(cap))));
      }

      expect(outcomes).toEqual([
        "Insufficient scope: this tool requires write:waitpoints",
        "Insufficient scope: this tool requires write:waitpoints",
      ]);
      expect(await waitpointRow(prisma, waiterId)).toMatchObject({ status: "PENDING" });
    }
  );

  // Catches: an approved cancel that skips the precondition and acts on (or reports as failed) a waiter a delivery already matched.
  containerTest(
    "says the waiter is no longer waiting when a delivery matched it after approval",
    async ({ prisma, redisOptions }) => {
      const { own, engine, waiterCall } = await waiterTools(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      await storeWebhookSigningSecret(endpoint, DELIVERY_SECRET);
      const waiterId = await waiterOn(engine, endpoint, { "event.data.orderId": "o1" });
      const args = { endpointId: "payments", waiterId };
      resetConfirmations({ autoApprove: false });

      await expectPending(waiterCall("cancel_webhook_waiter", args));
      await approveAll();
      const ingested = await engine.ingest(
        signedDelivery(endpoint.opaqueId, { id: "evt_match", data: { orderId: "o1" } })
      );
      const deadline = performance.now() + 15_000;
      while (
        (await waitpointRow(prisma, waiterId)).status !== "COMPLETED" &&
        performance.now() < deadline
      ) {
        await setTimeout(50);
      }
      const matched = await waitpointRow(prisma, waiterId);
      const result = await waiterCall("cancel_webhook_waiter", args);

      expect(ingested.outcome).toBe("accepted");
      expect(matched, "the delivery never completed the waiter").toMatchObject({
        status: "COMPLETED",
        outputIsError: false,
      });
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: `Waiter ${waiterId} is no longer waiting on this endpoint: a delivery matched it, it timed out or it was cancelled earlier. Nothing was cancelled.`,
          },
        ],
      });
      expect(await waitpointRow(prisma, waiterId)).toMatchObject({ outputIsError: false });
    }
  );

  // Catches: either webhooks access check (preview or run) removed from cancel_webhook_waiter.
  containerTest(
    "says webhooks are not available without the feature, before and after approval",
    async ({ prisma, redisOptions }) => {
      const { a, own, engine, waiterCall } = await waiterTools(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const waiterId = await waiterOn(engine, endpoint, { "event.id": "evt_flag" });
      await prisma.organization.update({
        where: { id: a.organization.id },
        data: { featureFlags: {} },
      });
      const args = { endpointId: "payments", waiterId };

      resetConfirmations({ autoApprove: false });
      const beforeApproval = await waiterCall("cancel_webhook_waiter", args);
      resetConfirmations({ autoApprove: true });
      const approved = await waiterCall("cancel_webhook_waiter", args);

      expect([textOf(beforeApproval), textOf(approved)]).toEqual([
        WEBHOOKS_NOT_AVAILABLE,
        JSON.stringify({ error: WEBHOOKS_NOT_AVAILABLE }),
      ]);
      expect(pending()).toEqual([]);
      expect(await waitpointRow(prisma, waiterId)).toMatchObject({ status: "PENDING" });
    }
  );

  // Catches: a waiter missed because a reservation entry shares its endpoint's live set (the old scan stopped early).
  containerTest(
    "finds and cancels a waiter while a reservation is in flight on its endpoint",
    async ({ prisma, redisOptions }) => {
      const { own, engine, waiterCall } = await waiterTools(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const waiterId = await waiterOn(engine, endpoint, { "event.id": "evt_reserved" });
      await storeOf(engine).reserve(endpoint.id, "shape", "values", "token-in-flight");

      const result = await confirmed(() =>
        waiterCall("cancel_webhook_waiter", { endpointId: "payments", waiterId })
      );

      expect(textOf(result)).toContain(`Cancelled waiter ${waiterId}.`);
      expect(await waitpointRow(prisma, waiterId)).toMatchObject({
        status: "COMPLETED",
        outputIsError: true,
      });
    }
  );

  // Catches: an engine failure after the waiter was removed reported as "nothing was cancelled", or a second call that cannot finish the cancel.
  containerTest(
    "when completing the waitpoint fails after the cancel, a second call completes it",
    async ({ prisma, redisOptions }) => {
      const { own, engine, waiterCall } = await waiterTools(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const waiterId = await waiterOn(engine, endpoint, { "event.id": "evt_retry" });
      const saved = await prisma.waitpoint.findFirstOrThrow({ where: { friendlyId: waiterId } });
      await prisma.waitpoint.delete({ where: { id: saved.id } });
      const args = { endpointId: "payments", waiterId };

      const first = await confirmed(() => waiterCall("cancel_webhook_waiter", args));
      await prisma.waitpoint.create({ data: saved });
      resetConfirmations({ autoApprove: false });
      await expectPending(waiterCall("cancel_webhook_waiter", args));
      const [record] = pending();
      await approveAll();
      const second = await waiterCall("cancel_webhook_waiter", args);

      expect(first).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Cancelling waiter ${waiterId} did not finish: the waiter may have been removed while its runs are still waiting. Call this tool again within an hour to complete it; after that its runs stay waiting until the waiter times out.`,
            }),
          },
        ],
        isError: true,
      });
      expect(record!.preview).toBe(
        [
          `Finish cancelling webhook waiter ${waiterId} on endpoint ${endpoint.friendlyId}. Match: "event.id = \\"evt_retry\\"". Filter: none. Header values in conditions are hidden.`,
          "1. The waiter was already removed by an earlier cancel.",
          '2. If its waitpoint has not been completed yet, it is completed with an error: WebhookWaiterCancelledError, "The webhook waiter was cancelled", and every run still waiting on it resumes with that error: webhooks.waiter.wait returns { ok: false } and .unwrap() throws it. The runs are not cancelled; what they do next is up to the task code.',
          "3. If its waitpoint was already completed, this changes nothing.",
          "4. No event is delivered to the task.",
          "5. It cannot be undone: to wait again, the task has to create a new waiter.",
        ].join("\n")
      );
      expect(textOf(second)).toBe(
        `Waiter ${waiterId} had already been cancelled. Its waitpoint is now completed with WebhookWaiterCancelledError if it was not already, so any runs still waiting on it resume with that error.`
      );
      expect(await waitpointRow(prisma, waiterId)).toMatchObject({
        status: "COMPLETED",
        outputIsError: true,
      });
    }
  );

  // Catches: a waiter a delivery has claimed (still in the live set until acknowledged) offered for cancelling.
  containerTest(
    "says a claimed waiter is no longer waiting, before any confirmation",
    async ({ prisma, redisOptions }) => {
      const { own, engine, waiterCall } = await waiterTools(prisma, redisOptions);
      const endpoint = await createEndpoint(prisma, own);
      const waiterId = await waiterOn(engine, endpoint, { "event.id": "evt_claimed" });
      const store = storeOf(engine);
      const index = await store.readIndex(waiterId);
      await store.claim(endpoint.id, "delivery_claim", [
        { shape: index!.shape, values: index!.values, ids: [waiterId] },
      ]);
      resetConfirmations({ autoApprove: false });

      const result = await waiterCall("cancel_webhook_waiter", {
        endpointId: "payments",
        waiterId,
      });

      expect(textOf(result)).toBe(
        `Waiter ${waiterId} is no longer waiting on this endpoint: a delivery matched it, it timed out or it was cancelled earlier. Nothing was cancelled.`
      );
      expect(pending()).toEqual([]);
      expect(await waitpointRow(prisma, waiterId)).toMatchObject({ status: "PENDING" });
    }
  );

  // Catches: a long condition cut short in the preview, so the user approves a condition they cannot read in full.
  containerTest("shows a long filter in full in the preview", async ({ prisma, redisOptions }) => {
    const { own, engine, waiterCall } = await waiterTools(prisma, redisOptions);
    const endpoint = await createEndpoint(prisma, own);
    const note = `${"x".repeat(1_500)}BODY_TAIL`;
    const created = await engine.createWaiter({
      environmentId: endpoint.runtimeEnvironmentId,
      projectId: endpoint.projectId,
      endpoint: endpoint.friendlyId,
      match: { "event.id": "evt_long" },
      filter: `event.note == '${note}'`,
    });
    if (created.outcome !== "created") throw new Error(`createWaiter ${JSON.stringify(created)}`);
    resetConfirmations({ autoApprove: false });

    await expectPending(
      waiterCall("cancel_webhook_waiter", { endpointId: "payments", waiterId: created.id })
    );

    expect(pending()[0]!.preview).toContain(`Filter: "event.note == \\"${note}\\""`);
  });
});

async function confirmed<T>(call: () => Promise<T>): Promise<T> {
  resetConfirmations({ autoApprove: false });
  await expectPending(call());
  await approveAll();
  return call();
}

const storeOf = (engine: WebhookEngine) =>
  (
    engine as unknown as {
      waiterStore: {
        reserve(endpointId: string, shape: string, values: string, token: string): Promise<unknown>;
        readIndex(waiterId: string): Promise<{ shape: string; values: string } | undefined>;
        claim(
          endpointId: string,
          deliveryId: string,
          groups: Array<{ shape: string; values: string; ids: string[] }>
        ): Promise<unknown>;
      };
    }
  ).waiterStore;
