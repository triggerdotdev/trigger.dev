import { containerTest, postgresTest } from "@internal/testcontainers";
import { $transaction as realTransaction } from "@trigger.dev/database";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));
/** The OAuth routes' rate limiter's Redis: the container's, for tests that call a route. */
const rateLimitRedis = vi.hoisted(() => ({
  host: "",
  port: 0,
  password: undefined as string | undefined,
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
  // The production helper, on the test's database.
  $transaction: (client: PrismaClient, _name: string, fn: Parameters<typeof realTransaction>[1]) =>
    realTransaction(client, fn, () => {}),
}));
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  const { auditRecordingEnv } = await import("./helpers/auditLogPlugin");
  return auditRecordingEnv({
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-oauth-grant-audit",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      APP_ORIGIN: "https://app.example.com",
      MCP_ORIGIN: "https://mcp.example.com",
      OAUTH_GRANT_IDLE_DAYS: 30,
      OAUTH_GRANT_ABSOLUTE_DAYS: 90,
      MCP_SERVER_ENABLED: true,
      get RATE_LIMIT_REDIS_HOST() {
        return rateLimitRedis.host;
      },
      get RATE_LIMIT_REDIS_PORT() {
        return rateLimitRedis.port;
      },
      get RATE_LIMIT_REDIS_PASSWORD() {
        return rateLimitRedis.password;
      },
      RATE_LIMIT_REDIS_TLS_DISABLED: "true",
      // The per-org recording flag's settings, at their schema defaults: a hand-built env has none.
      AUDIT_LOGS_RECORDING_FLAG_CACHE_TTL_MS: 30_000,
      AUDIT_LOGS_RECORDING_FLAG_CACHE_MAX_ENTRIES: 50_000,
      AUDIT_LOGS_RECORDING_FLAG_LOOKUP_TIMEOUT_MS: 5_000,
    }),
  });
});
// Grant tokens are created without a role, so the RBAC plugin is never called.
vi.mock("~/services/rbac.server", () => ({ rbac: {} }));

import {
  createOAuthAuthorizationCode,
  validateAuthorizationRequest,
} from "~/services/oauth/authorize.server";
import { registerClient } from "~/services/oauth/clients.server";
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revokeToken,
} from "~/services/oauth/token.server";
import { action as tokenAction } from "~/routes/oauth.token";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { revokePersonalAccessToken } from "~/services/personalAccessToken.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import {
  enableAuditRecording,
  inAuditedRequest,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://mcp.example.com/mcp";
const audit = { ip: null, userAgent: null };

const cleanups: Array<() => Promise<void>> = [];

async function setup(prisma: PrismaClient) {
  db.client = prisma;
  const plugin = installAuditLogPlugin();
  cleanups.push(await enableAuditRecording());
  const user = await prisma.user.create({
    data: {
      email: `oauth-audit-${randomBytes(4).toString("hex")}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  return { plugin, user };
}

async function registerDynamicClient() {
  const result = await registerClient({ redirect_uris: [REDIRECT_URI], client_name: "Claude" });
  if (!result.ok) throw new Error(result.body.error_description);
  return result.body.client_id as string;
}

/** An approved code for `clientId`, with the verifier that exchanges it. */
async function approvedCode(clientId: string, userId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const validated = await validateAuthorizationRequest(
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "read:runs",
      resource: RESOURCE,
    })
  );
  if (!validated.ok) throw new Error(validated.error.error_description);
  const code = await createOAuthAuthorizationCode(validated.request, userId);
  await db.client.authorizationCode.update({
    where: { id: code.id },
    data: { approvedByUserId: userId },
  });
  return { code: code.code, verifier };
}

function codeParams(clientId: string, code: { code: string; verifier: string }) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: code.code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: code.verifier,
    resource: RESOURCE,
  });
}

async function grant(clientId: string, userId: string) {
  const result = await exchangeAuthorizationCode(
    codeParams(clientId, await approvedCode(clientId, userId)),
    audit
  );
  if (!result.ok) throw new Error(result.body.error_description);
  return result.body;
}

function refresh(clientId: string, refreshToken: string) {
  return exchangeRefreshToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    })
  );
}

/** The `pat.revoked` events recorded so far, with the fingerprint mark for each token. */
async function revocations(plugin: ReturnType<typeof installAuditLogPlugin>, prisma: PrismaClient) {
  await auditLogs.flush();
  const events = plugin.recorded
    .map(({ input }) => input)
    .filter((input) => input.action === "pat.revoked");
  return Promise.all(
    events.map(async (input) => {
      const token = await prisma.personalAccessToken.findFirstOrThrow({
        where: { id: input.target.id! },
      });
      return {
        input,
        oauthClientId: token.oauthClientId,
        tokenRevoked: token.revokedAt !== null,
        mark: plugin.revoked.find((mark) => mark.hash === token.hashedToken),
      };
    })
  );
}

describe("OAuth grant PAT audit events", () => {
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    uninstallAuditLogPlugin();
  });

  // Catches: a grant's token created with no event, or an event that the plugin drops because the
  // token endpoint's request has no audit context to give it an actor or a source.
  postgresTest("records the token a grant creates, as the user's", async ({ prisma }) => {
    const { plugin, user } = await setup(prisma);
    const clientId = await registerDynamicClient();

    await grant(clientId, user.id);
    await auditLogs.flush();

    const pat = await prisma.personalAccessToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(plugin.dropped).toEqual([]);
    expect(plugin.recorded.map(({ input }) => input)).toEqual([
      {
        category: "credentials",
        action: "pat.created",
        organizationId: null,
        target: { type: "pat", id: pat.id, name: "Claude (MCP)" },
        keyLast4s: [pat.obfuscatedToken.slice(-4)],
        actor: { type: "user", id: user.id },
        source: "api",
        changes: { expiresAt: pat.expiresAt!.toISOString(), oauthClientId: pat.oauthClientId },
      },
    ]);
  });

  type Case = {
    reason: string;
    revokedBy: "user" | "system";
    /** Grants the user, then revokes the first grant's token; returns that token's id. */
    revoke: (prisma: PrismaClient, userId: string) => Promise<string>;
  };

  const firstPatId = async (prisma: PrismaClient, userId: string) =>
    (
      await prisma.personalAccessToken.findFirstOrThrow({
        where: { userId },
        orderBy: { createdAt: "asc" },
      })
    ).id;

  // Catches: a revoke path that leaves no event, names the wrong reason or actor, or leaves the
  // token's fingerprint looking live.
  postgresTest.for<Case>([
    {
      reason: "replaced",
      revokedBy: "user",
      revoke: async (prisma, userId) => {
        const client = await prisma.oAuthClient.create({
          data: { kind: "PREREGISTERED", clientId: "trigger-test", redirectUris: [REDIRECT_URI] },
        });
        await grant(client.clientId, userId);
        const replaced = await firstPatId(prisma, userId);
        await grant(client.clientId, userId);
        return replaced;
      },
    },
    {
      reason: "grant_cap",
      revokedBy: "user",
      revoke: async (prisma, userId) => {
        const clientId = await registerDynamicClient();
        for (let i = 0; i < 11; i++) await grant(clientId, userId);
        return firstPatId(prisma, userId);
      },
    },
    {
      reason: "code_replay",
      revokedBy: "system",
      revoke: async (prisma, userId) => {
        const clientId = await registerDynamicClient();
        const code = await approvedCode(clientId, userId);
        expect((await exchangeAuthorizationCode(codeParams(clientId, code), audit)).ok).toBe(true);
        expect((await exchangeAuthorizationCode(codeParams(clientId, code), audit)).ok).toBe(false);
        return firstPatId(prisma, userId);
      },
    },
    {
      reason: "refresh_reuse",
      revokedBy: "system",
      revoke: async (prisma, userId) => {
        const clientId = await registerDynamicClient();
        const issued = await grant(clientId, userId);
        expect((await refresh(clientId, issued.refresh_token)).ok).toBe(true);
        expect((await refresh(clientId, issued.refresh_token)).ok).toBe(false);
        return firstPatId(prisma, userId);
      },
    },
    {
      reason: "client_revoked",
      revokedBy: "user",
      revoke: async (prisma, userId) => {
        const issued = await grant(await registerDynamicClient(), userId);
        await revokeToken(new URLSearchParams({ token: issued.access_token }));
        return firstPatId(prisma, userId);
      },
    },
  ])("records a token revoked by $reason", async ({ reason, revokedBy, revoke }, { prisma }) => {
    const { plugin, user } = await setup(prisma);

    const revokedId = await revoke(prisma, user.id);

    const revoked = await revocations(plugin, prisma);
    const actor =
      revokedBy === "system" ? { type: "system", id: null } : { type: "user", id: user.id };
    expect(plugin.dropped).toEqual([]);
    expect(revoked).toHaveLength(1);
    // The client by row id, not by the name it registered with, which any client can copy.
    expect(revoked[0]!.oauthClientId).toEqual(expect.any(String));
    expect(revoked[0]!.input.changes).toEqual({
      reason,
      oauthClientId: revoked[0]!.oauthClientId,
    });
    expect(revoked[0]).toMatchObject({
      input: {
        action: "pat.revoked",
        organizationId: null,
        target: { type: "pat", id: revokedId },
        actor,
        source: "api",
        changes: { reason },
      },
      tokenRevoked: true,
      mark: { reason: "revoked", revokedBy: actor },
    });
  });

  // Catches: a grant's token revoked from the account page losing which client it was issued to.
  postgresTest("a grant token revoked by its user names its client", async ({ prisma }) => {
    const { plugin, user } = await setup(prisma);
    await grant(await registerDynamicClient(), user.id);
    const pat = await prisma.personalAccessToken.findFirstOrThrow({ where: { userId: user.id } });

    // From the account page: the dashboard request says how it was made.
    await inAuditedRequest(() => revokePersonalAccessToken(pat.id, user.id));

    const revoked = await revocations(plugin, prisma);
    expect(revoked.map(({ input }) => input.changes)).toEqual([
      { reason: "revoked", oauthClientId: pat.oauthClientId },
    ]);
  });

  // Catches: a replayed refresh token recorded without the IP it came from, because the token
  // endpoint has no sign-in step to note the request.
  containerTest(
    "a replay through the token endpoint records the caller's IP",
    async ({ prisma, redisOptions }) => {
      rateLimitRedis.host = redisOptions.host!;
      rateLimitRedis.port = redisOptions.port!;
      rateLimitRedis.password = redisOptions.password;
      const { plugin, user } = await setup(prisma);
      const clientId = await registerDynamicClient();
      const issued = await grant(clientId, user.id);
      expect((await refresh(clientId, issued.refresh_token)).ok).toBe(true);

      const response = await runWithHttpContext(
        {
          requestId: "req_replay",
          path: "/oauth/token",
          host: "localhost",
          method: "POST",
          abortController: new AbortController(),
        },
        () =>
          tokenAction({
            request: new Request("https://app.example.com/oauth/token", {
              method: "POST",
              headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "replayer/1.0" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: issued.refresh_token,
                client_id: clientId,
              }).toString(),
            }),
            params: {},
            context: {},
          })
      );
      expect(response.status).toBe(400);
      await auditLogs.flush();

      const replay = plugin.recorded.find(({ input }) => input.action === "pat.revoked");
      expect(replay?.input.changes).toEqual({
        reason: "refresh_reuse",
        oauthClientId: expect.any(String),
      });
      expect(replay?.context).toMatchObject({
        endpoint: { ip: "203.0.113.7", userAgent: "replayer/1.0" },
        requestId: "req_replay",
      });
    }
  );

  // Catches: events for a grant whose exchange rolled back, which would name a token that never
  // existed and a replaced grant that is still live.
  postgresTest("records nothing for an exchange that rolls back", async ({ prisma }) => {
    const { plugin, user } = await setup(prisma);
    const client = await prisma.oAuthClient.create({
      data: { kind: "PREREGISTERED", clientId: "trigger-test", redirectUris: [REDIRECT_URI] },
    });
    await grant(client.clientId, user.id);
    await auditLogs.flush();
    plugin.recorded.length = 0;

    const failed = exchangeAuthorizationCode(
      codeParams(client.clientId, await approvedCode(client.clientId, user.id)),
      audit,
      async () => {
        throw new Error("signing failed");
      }
    );
    await expect(failed).rejects.toThrow("signing failed");
    await auditLogs.flush();

    expect(plugin.recorded).toEqual([]);
    expect(plugin.revoked).toEqual([]);
    expect(
      await prisma.personalAccessToken.count({ where: { userId: user.id, revokedAt: null } })
    ).toBe(1);
  });
});
