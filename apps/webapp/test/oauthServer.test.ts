import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const db = vi.hoisted(() => ({ client: null as any, rbac: null as any }));
const mockEnv = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-oauth-server",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  APP_ORIGIN: "https://app.example.com",
  MCP_ORIGIN: "https://mcp.example.com",
  OAUTH_GRANT_IDLE_DAYS: 30,
  OAUTH_GRANT_ABSOLUTE_DAYS: 90,
  MCP_SERVER_ENABLED: true,
  RATE_LIMIT_REDIS_HOST: "127.0.0.1",
  RATE_LIMIT_REDIS_PORT: 1,
  RATE_LIMIT_REDIS_PASSWORD: undefined as string | undefined,
  RATE_LIMIT_REDIS_TLS_DISABLED: "true",
}));
const session = vi.hoisted(() => ({ user: null as any }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
  $transaction: (client: any, name: string, fn: (tx: any) => Promise<unknown>) =>
    client.$transaction(fn),
}));
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return { env: withLegacyEncryptionKeyring(mockEnv) };
});
vi.mock("~/services/session.server", () => ({
  requireUser: async () => session.user,
}));
vi.mock("~/services/rbac.server", () => ({
  get rbac() {
    return db.rbac;
  },
}));

import { postgresTest, redisTest } from "@internal/testcontainers";
import plugin, {
  personalAccessTokenExpiry,
  signUserActorToken,
  verifyUserActorToken,
} from "@trigger.dev/rbac";
import { hashToken } from "~/utils/tokens.server";
import { createMcpBearerAuthenticator } from "~/mcp/auth/bearer.server";
import { withMcpToolAuth } from "~/mcp/gate/withMcpToolAuth.server";
import { createMcpProtectedResourceHandler } from "~/mcp/protectedResource.server";
import {
  authorizationServerMetadata,
  MCP_SCOPES,
  mcpResource,
} from "~/services/oauth/metadata.server";
import {
  createPersonalAccessToken,
  resolveAndRecheckUserActorClaims,
  updateLastAccessedAtIfStale,
} from "~/services/personalAccessToken.server";
import { loader as authorizeLoader } from "~/routes/oauth.authorize";
import {
  buildOAuthRedirect,
  oauthCodeKey,
  createOAuthAuthorizationCode,
  validateAuthorizationRequest,
} from "~/services/oauth/authorize.server";
import { publicOnlyLookup, type MetadataTransport } from "~/services/oauth/cimdFetch.server";
import { isPublicAddress } from "~/services/publicAddress.server";
import { registerClient, resolveClient } from "~/services/oauth/clients.server";
import { sweepOAuthClients } from "~/services/oauth/clientSweep.server";
import { action as tokenAction } from "~/routes/oauth.token";
import { action as revokeAction } from "~/routes/oauth.revoke";
import { OAUTH_IP_LIMITS, checkOAuthIpRateLimit } from "~/services/oauth/rateLimit.server";
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revokeToken,
} from "~/services/oauth/token.server";

vi.setConfig({ testTimeout: 60_000 });

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://mcp.example.com/mcp";
const audit = { ip: null, userAgent: null };
// Keep each burst in one bucket: sliding windows discount requests across minute boundaries.
const RATE_LIMIT_TEST_TIME = new Date("2026-01-01T00:00:30Z");

let userCounter = 0;

function createUser(prisma: any) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `oauth-server-${userCounter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register() {
  const result = await registerClient({ redirect_uris: [REDIRECT_URI], client_name: "Claude" });
  if (!result.ok) throw new Error(result.body.error_description);
  return result.body.client_id as string;
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "read:runs read:query",
    resource: RESOURCE,
    state: "xyz",
    ...extra,
  });
}

/** Starts an authorization as `requesterId`; `approverId` approves it on the consent page. */
async function authorize(
  clientId: string,
  challenge: string,
  requesterId: string,
  approverId: string | null = requesterId
) {
  const result = await validateAuthorizationRequest(authorizeParams(clientId, challenge));
  if (!result.ok) throw new Error(result.error.error_description);
  const code = await createOAuthAuthorizationCode(result.request, requesterId);
  if (approverId) {
    await db.client.authorizationCode.update({
      where: { id: code.id },
      data: { approvedByUserId: approverId },
    });
  }
  return code.code;
}

function tokenParams(clientId: string, code: string, verifier: string, extra = {}) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: RESOURCE,
    ...extra,
  });
}

function refreshParams(clientId: string, refreshToken: string) {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

async function grant(clientId: string, userId: string) {
  const { verifier, challenge } = pkce();
  const code = await authorize(clientId, challenge, userId);
  const result = await exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit);
  if (!result.ok) throw new Error(result.body.error_description);
  return result.body;
}

function livePats(userId: string) {
  return db.client.personalAccessToken.count({ where: { userId, revokedAt: null } });
}

const V15_SCOPES = [
  "read:errors",
  "write:errors",
  "read:queues",
  "read:tasks",
  "write:tasks",
  "read:batch",
  "write:batch",
  "read:waitpoints",
  "write:waitpoints",
  "read:environments",
  "write:deployments",
  "write:branches",
  "read:envvars",
  "manage:project",
];

function documentTransport(status: number, body: string): MetadataTransport {
  return async () => ({ status, body: [new TextEncoder().encode(body)] });
}

describe("OAuth authorization server", () => {
  beforeEach(() => {
    db.client = null;
    db.rbac = null;
    (globalThis as any).__trigger_singletons = {};
    mockEnv.RATE_LIMIT_REDIS_HOST = "127.0.0.1";
    mockEnv.RATE_LIMIT_REDIS_PORT = 1;
    mockEnv.RATE_LIMIT_REDIS_PASSWORD = undefined;
  });

  postgresTest(
    "issues a capped UAT bound to the grant PAT, rotates refresh, and revokes on replay",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const clientId = await register();
      expect(await register()).toBe(clientId);

      const { verifier, challenge } = pkce();
      const code = await authorize(clientId, challenge, user.id);

      const issued = await exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit);
      if (!issued.ok) throw new Error(issued.body.error_description);
      expect(issued.body.scope).toBe("read:runs read:query");

      const pat = await prisma.personalAccessToken.findFirstOrThrow({
        where: { userId: user.id, oauthClient: { clientId } },
      });
      expect(pat.name).toBe("Claude (MCP)");
      const claims = await verifyUserActorToken(mockEnv.SESSION_SECRET, issued.body.access_token, {
        audience: RESOURCE,
      });
      expect(claims).toMatchObject({
        userId: user.id,
        pat: pat.id,
        cap: ["read:runs", "read:query"],
      });

      const rotated = await exchangeRefreshToken(
        refreshParams(clientId, issued.body.refresh_token)
      );
      if (!rotated.ok) throw new Error(rotated.body.error_description);
      expect(rotated.body.refresh_token).not.toBe(issued.body.refresh_token);
      const rotatedClaims = await verifyUserActorToken(
        mockEnv.SESSION_SECRET,
        rotated.body.access_token,
        { audience: RESOURCE }
      );
      expect(rotatedClaims?.pat).toBe(pat.id);

      const replay = await exchangeRefreshToken(refreshParams(clientId, issued.body.refresh_token));
      expect(replay).toMatchObject({ ok: false, body: { error: "invalid_grant" } });
      expect(await livePats(user.id)).toBe(0);
      const afterReplay = await exchangeRefreshToken(
        refreshParams(clientId, rotated.body.refresh_token)
      );
      expect(afterReplay.ok).toBe(false);
    }
  );

  // Catches: an authorization code that can be exchanged twice, sequentially or concurrently.
  postgresTest("authorization code is single-use", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await authorize(clientId, challenge, user.id);
    const sign = async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`;
        if (waiting > 0) return "access-token";
        if (Date.now() > deadline) throw new Error("second exchange never overlapped");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const exchange = () =>
      exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit, sign);

    const [first, second] = await Promise.all([exchange(), exchange()]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      ok: false,
      body: { error: "invalid_grant" },
    });

    expect(await livePats(user.id)).toBe(0);
    expect(await exchange()).toMatchObject({ ok: false, body: { error: "invalid_grant" } });
  });

  // Catches: revoking on replay before PKCE is verified, letting a code holder kill the grant.
  postgresTest("a replay with a wrong verifier does not revoke the grant", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await authorize(clientId, challenge, user.id);
    await exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit);

    const bogus = await exchangeAuthorizationCode(
      tokenParams(clientId, code, pkce().verifier),
      audit
    );
    expect(bogus).toMatchObject({ ok: false, body: { error: "invalid_grant" } });
    expect(await livePats(user.id)).toBe(1);
  });

  // Catches: the UAT bearer path writing lastAccessedAt on every call instead of only when stale.
  postgresTest("UAT bearer calls touch the grant PAT only when stale", async ({ prisma }) => {
    db.client = prisma;
    db.rbac = plugin.create(
      { primary: prisma, replica: prisma },
      { forceFallback: true, userActorSecret: mockEnv.SESSION_SECRET }
    );
    const user = await createUser(prisma);
    const issued = await grant(await register(), user.id);
    const authenticate = createMcpBearerAuthenticator({
      rbac: db.rbac,
      failureBody: (failure) => failure,
      recheckUserActorClaims: resolveAndRecheckUserActorClaims,
      touchPat: updateLastAccessedAtIfStale,
      resourceMetadataUrl: `${RESOURCE}/prm`,
      audience: mcpResource(),
    });
    const call = () =>
      authenticate(
        new Request(RESOURCE, { headers: { Authorization: `Bearer ${issued.access_token}` } })
      );

    const updateMany = vi.spyOn(prisma.personalAccessToken, "updateMany");
    expect((await call()).ok).toBe(true);
    expect((await call()).ok).toBe(true);

    expect(updateMany).toHaveBeenCalledTimes(1);
    updateMany.mockRestore();
    const pat = await prisma.personalAccessToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(pat.lastAccessedAt).not.toBeNull();
  });

  // Catches: refresh not counting use toward the grant PAT's idle expiry, or not checking it.
  postgresTest("grant PAT idle expiry follows use", async ({ prisma }) => {
    db.client = prisma;
    const day = 24 * 60 * 60 * 1000;
    const real = Date.now();
    const patExpired = async (patId: string) => {
      const row = await prisma.personalAccessToken.findFirstOrThrow({ where: { id: patId } });
      return personalAccessTokenExpiry(row) !== undefined;
    };
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      const user = await createUser(prisma);
      const clientId = await register();
      const used = await grant(clientId, user.id);
      const idle = await grant(clientId, user.id);

      vi.setSystemTime(real + 29 * day);
      const refreshed = await exchangeRefreshToken(refreshParams(clientId, used.refresh_token));
      if (!refreshed.ok) throw new Error(refreshed.body.error_description);

      const claims = await verifyUserActorToken(
        mockEnv.SESSION_SECRET,
        refreshed.body.access_token,
        {
          audience: RESOURCE,
        }
      );
      vi.setSystemTime(real + 31 * day);
      expect(await patExpired(claims!.pat)).toBe(false);

      await prisma.oAuthRefreshToken.updateMany({
        where: { hashedToken: hashToken(idle.refresh_token) },
        data: { idleExpiresAt: new Date(real + 90 * day) },
      });
      const stale = await exchangeRefreshToken(refreshParams(clientId, idle.refresh_token));
      expect(stale).toMatchObject({ ok: false, body: { error: "invalid_grant" } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Catches: dropping the revoke on code replay, or minting the grant PAT without idle expiry.
  postgresTest(
    "a replayed code revokes the grant it minted, and the grant PAT idle-expires",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const clientId = await register();
      const { verifier, challenge } = pkce();
      const code = await authorize(clientId, challenge, user.id);

      const issued = await exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit);
      if (!issued.ok) throw new Error(issued.body.error_description);
      const claims = await verifyUserActorToken(mockEnv.SESSION_SECRET, issued.body.access_token, {
        audience: RESOURCE,
      });
      const live = await prisma.personalAccessToken.findFirstOrThrow({
        where: { id: claims!.pat },
      });
      expect(live.revokedAt).toBeNull();
      expect(live.idleTimeoutSeconds).toBe(mockEnv.OAUTH_GRANT_IDLE_DAYS * 24 * 60 * 60);

      const replay = await exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit);
      expect(replay).toMatchObject({ ok: false, body: { error: "invalid_grant" } });

      const revoked = await prisma.personalAccessToken.findFirstOrThrow({
        where: { id: claims!.pat },
      });
      expect(revoked.revokedAt).not.toBeNull();
      const refreshed = await exchangeRefreshToken(
        refreshParams(clientId, issued.body.refresh_token)
      );
      expect(refreshed.ok).toBe(false);
    }
  );

  // Catches: a dedupe hit on /register not refreshing the client, so the sweep deletes it.
  postgresTest("re-registering an old client keeps it past the sweep", async ({ prisma }) => {
    db.client = prisma;
    const clientId = await register();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await prisma.oAuthClient.update({
      where: { clientId },
      data: { createdAt: old, updatedAt: old },
    });

    expect(await register()).toBe(clientId);
    expect(await sweepOAuthClients(prisma)).toEqual({ deleted: 0, failedChunks: 0 });
    expect(await prisma.oAuthClient.count({ where: { clientId } })).toBe(1);
  });

  // Catches: authorize or token refusing, dropping or reordering a requested write or V1.5 scope.
  postgresTest("granted write and V1.5 scopes cap the access token", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const requested = ["read:runs", "write:runs", ...V15_SCOPES];
    const authorized = await validateAuthorizationRequest(
      authorizeParams(clientId, challenge, { scope: requested.join(" ") })
    );
    if (!authorized.ok) throw new Error(authorized.error.error_description);
    const code = await createOAuthAuthorizationCode(authorized.request, user.id);
    await prisma.authorizationCode.update({
      where: { id: code.id },
      data: { approvedByUserId: user.id },
    });

    const issued = await exchangeAuthorizationCode(
      tokenParams(clientId, code.code, verifier),
      audit
    );
    if (!issued.ok) throw new Error(issued.body.error_description);
    const claims = await verifyUserActorToken(mockEnv.SESSION_SECRET, issued.body.access_token, {
      audience: RESOURCE,
    });
    expect(claims?.cap).toEqual(requested);
  });

  // Catches: a refresh widening a grant to the default or a new scope, ignoring a narrowing, or undoing it later.
  postgresTest(
    "a refresh keeps or narrows the grant's scopes, never widens",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const clientId = await register();
      const issued = await grant(clientId, user.id);

      const rotated = await exchangeRefreshToken(refreshParams(clientId, issued.refresh_token));
      if (!rotated.ok) throw new Error(rotated.body.error_description);
      expect(rotated.body.scope).toBe("read:runs read:query");
      const claims = await verifyUserActorToken(mockEnv.SESSION_SECRET, rotated.body.access_token, {
        audience: RESOURCE,
      });
      expect(claims?.cap).toEqual(["read:runs", "read:query"]);

      const refreshWith = (refreshToken: string, scope: string) =>
        exchangeRefreshToken(
          new URLSearchParams({
            ...Object.fromEntries(refreshParams(clientId, refreshToken)),
            scope,
          })
        );
      const widened = await refreshWith(rotated.body.refresh_token, "read:runs read:errors");
      expect(widened).toMatchObject({ ok: false, body: { error: "invalid_scope" } });

      const narrowed = await refreshWith(rotated.body.refresh_token, "read:runs");
      if (!narrowed.ok) throw new Error(narrowed.body.error_description);
      expect(narrowed.body.scope).toBe("read:runs");
      expect(await refreshWith(narrowed.body.refresh_token, "read:runs read:query")).toMatchObject({
        ok: false,
        body: { error: "invalid_scope" },
      });
      const kept = await exchangeRefreshToken(refreshParams(clientId, narrowed.body.refresh_token));
      if (!kept.ok) throw new Error(kept.body.error_description);
      expect(kept.body.scope).toBe("read:runs");
    }
  );

  // Catches: either metadata document dropping scopes_supported, a V1.5 scope, or the MCP resource origin.
  it("both metadata documents advertise every MCP scope", () => {
    let body: { scopes_supported?: string[]; resource?: string } = {};
    createMcpProtectedResourceHandler({
      origin: "https://mcp.test",
      authorizationServers: [],
      scopes: MCP_SCOPES,
    })({} as never, { json: (b: typeof body) => (body = b) } as never, () => {});
    expect(body.scopes_supported).toEqual([...MCP_SCOPES]);
    expect(body.scopes_supported).toEqual(expect.arrayContaining(["write:runs", ...V15_SCOPES]));
    expect(authorizationServerMetadata().scopes_supported).toEqual(body.scopes_supported);
    expect(body.resource).toBe("https://mcp.test/mcp");
  });

  postgresTest("the requested scopes are granted exactly", async ({ prisma }) => {
    db.client = prisma;
    const result = await validateAuthorizationRequest(
      authorizeParams(await register(), pkce().challenge, { scope: "read:runs write:projects" })
    );
    if (!result.ok) throw new Error(result.error.error_description);
    expect(result.request.scope).toEqual(["read:runs", "write:projects"]);
  });

  // Catches: read:envvars, a write or a manage scope in the default grant, or a read scope missing from it.
  postgresTest("an absent scope grants every read scope but read:envvars", async ({ prisma }) => {
    db.client = prisma;
    const result = await validateAuthorizationRequest(
      authorizeParams(await register(), pkce().challenge, { scope: "" })
    );
    if (!result.ok) throw new Error(result.error.error_description);
    expect([...result.request.scope].sort()).toEqual([
      "read:alerts",
      "read:batch",
      "read:branches",
      "read:deployments",
      "read:environments",
      "read:errors",
      "read:organizations",
      "read:projects",
      "read:prompts",
      "read:query",
      "read:queues",
      "read:runs",
      "read:sessions",
      "read:tasks",
      "read:waitpoints",
      "read:webhooks",
    ]);
  });

  postgresTest("the access token is only valid for the MCP audience", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const token = (await grant(await register(), user.id)).access_token;

    expect(await verifyUserActorToken(mockEnv.SESSION_SECRET, token)).toBeUndefined();
    expect(
      await verifyUserActorToken(mockEnv.SESSION_SECRET, token, { audience: RESOURCE })
    ).toBeDefined();
  });

  postgresTest(
    "the MCP endpoint and tool gate accept an issued token and refuse an API-audience one",
    async ({ prisma }) => {
      db.client = prisma;
      db.rbac = plugin.create(
        { primary: prisma, replica: prisma },
        { forceFallback: true, userActorSecret: mockEnv.SESSION_SECRET }
      );
      const user = await createUser(prisma);
      const issued = await grant(await register(), user.id);
      const pat = await prisma.personalAccessToken.findFirstOrThrow({ where: { userId: user.id } });
      const apiToken = await signUserActorToken(mockEnv.SESSION_SECRET, {
        userId: user.id,
        client: "test",
        pat: pat.id,
        cap: ["read:runs"],
      });

      const authenticate = createMcpBearerAuthenticator({
        rbac: db.rbac,
        failureBody: (failure) => failure,
        recheckUserActorClaims: resolveAndRecheckUserActorClaims,
        touchPat: async () => {},
        resourceMetadataUrl: `${RESOURCE}/prm`,
        audience: mcpResource(),
      });
      const tool = withMcpToolAuth(
        { user: true, action: "read", subject: "runs" },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        "test_tool"
      );
      const call = async (token: string) => {
        const request = new Request(RESOURCE, { headers: { Authorization: `Bearer ${token}` } });
        const auth = await authenticate(request);
        const identity = {
          kind: "uat" as const,
          userId: user.id,
          sourceTokenId: pat.id,
          clientId: "test",
          cap: ["read:runs"],
        };
        const result = await tool({}, auth.ok ? auth.identity : identity, request);
        return { authenticated: auth.ok, allowed: !result.isError };
      };

      expect(await call(issued.access_token)).toEqual({ authenticated: true, allowed: true });
      expect(await call(apiToken)).toEqual({ authenticated: false, allowed: false });
    }
  );

  postgresTest.for([
    { name: "a wrong PKCE verifier", wrongVerifier: true },
    { name: "a wrong redirect_uri", extra: { redirect_uri: "https://claude.ai/other" } },
    { name: "an expired code", ageMs: 11 * 60 * 1000 },
    { name: "an unapproved code", approver: "none" },
    { name: "a code approved by another user", approver: "other" },
  ] as Array<{
    name: string;
    wrongVerifier?: boolean;
    extra?: Record<string, string>;
    ageMs?: number;
    approver?: "none" | "other";
  }>)("token refuses $name and mints no PAT", async (row, { prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const other = await createUser(prisma);
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const approverId =
      row.approver === "none" ? null : row.approver === "other" ? other.id : user.id;
    const code = await authorize(clientId, challenge, user.id, approverId);
    if (row.ageMs) {
      await prisma.authorizationCode.update({
        where: { code: oauthCodeKey(code) },
        data: { createdAt: new Date(Date.now() - row.ageMs) },
      });
    }

    const result = await exchangeAuthorizationCode(
      tokenParams(clientId, code, row.wrongVerifier ? pkce().verifier : verifier, row.extra),
      audit
    );
    expect(result).toMatchObject({ ok: false, body: { error: "invalid_grant" } });
    expect(await prisma.personalAccessToken.count()).toBe(0);
  });

  postgresTest("re-consent keeps at most 10 live grants per client", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();

    const first = await grant(clientId, user.id);
    for (let i = 0; i < 10; i++) await grant(clientId, user.id);

    expect(await livePats(user.id)).toBe(10);
    const oldest = await exchangeRefreshToken(refreshParams(clientId, first.refresh_token));
    expect(oldest.ok).toBe(false);
  });

  postgresTest("re-consent replaces the grant of a pre-registered client", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const client = await prisma.oAuthClient.create({
      data: { kind: "PREREGISTERED", clientId: "trigger-test", redirectUris: [REDIRECT_URI] },
    });

    await grant(client.clientId, user.id);
    await grant(client.clientId, user.id);
    expect(await livePats(user.id)).toBe(1);
  });

  postgresTest.for([
    { kind: "DYNAMIC" as const, existing: 10, expected: 10 },
    { kind: "PREREGISTERED" as const, existing: 0, expected: 1 },
  ])(
    "concurrent $kind exchanges keep the grant cap",
    async ({ kind, existing, expected }, { prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const clientId =
        kind === "DYNAMIC"
          ? await register()
          : (
              await prisma.oAuthClient.create({
                data: { kind, clientId: "trigger-test", redirectUris: [REDIRECT_URI] },
              })
            ).clientId;
      for (let i = 0; i < existing; i++) await grant(clientId, user.id);

      const pending = [];
      for (let i = 0; i < 2; i++) {
        const { verifier, challenge } = pkce();
        pending.push({ verifier, code: await authorize(clientId, challenge, user.id) });
      }

      let first = true;
      let secondSigned = false;
      const blocked = async () => {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`;
        return waiting > 0;
      };
      const sign = async () => {
        if (!first) {
          secondSigned = true;
          return "access-token";
        }
        first = false;
        const deadline = Date.now() + 10_000;
        while (!secondSigned && !(await blocked())) {
          if (Date.now() > deadline) throw new Error("second exchange never overlapped");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return "access-token";
      };
      const results = await Promise.all(
        pending.map(({ verifier, code }) =>
          exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit, sign)
        )
      );

      expect(results.every((r) => r.ok)).toBe(true);
      expect(await livePats(user.id)).toBe(expected);
    }
  );

  postgresTest(
    "concurrent refreshes with one handle: one wins, the loser is a replay and revokes the grant (RFC 6819)",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const clientId = await register();
      const issued = await grant(clientId, user.id);

      const results = await Promise.all([
        exchangeRefreshToken(refreshParams(clientId, issued.refresh_token)),
        exchangeRefreshToken(refreshParams(clientId, issued.refresh_token)),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await livePats(user.id)).toBe(0);
    }
  );

  const failingSign = async (): Promise<string> => {
    throw new Error("signing failed");
  };

  postgresTest("a failed code exchange consumes nothing and mints no PAT", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await authorize(clientId, challenge, user.id);

    await expect(
      exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit, failingSign)
    ).rejects.toThrow("signing failed");
    expect(await prisma.personalAccessToken.count()).toBe(0);

    const retried = await exchangeAuthorizationCode(tokenParams(clientId, code, verifier), audit);
    expect(retried.ok).toBe(true);
  });

  postgresTest("a failed rotation leaves the old refresh handle usable", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();
    const issued = await grant(clientId, user.id);

    await expect(
      exchangeRefreshToken(refreshParams(clientId, issued.refresh_token), failingSign)
    ).rejects.toThrow("signing failed");

    const retried = await exchangeRefreshToken(refreshParams(clientId, issued.refresh_token));
    expect(retried.ok).toBe(true);
    expect(await livePats(user.id)).toBe(1);
  });

  it("rate-limits a request without X-Forwarded-For", async () => {
    const limit = vi.fn(async () => ({ success: false, reset: Date.now() + 30_000 }));
    const retryAfter = await checkOAuthIpRateLimit(
      "register",
      new Request("https://app.example.com/oauth/register", { method: "POST" }),
      limit
    );
    expect(limit).toHaveBeenCalledWith("unknown");
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("allows the request when the rate limiter is unavailable", async () => {
    const retryAfter = await checkOAuthIpRateLimit(
      "token",
      new Request("https://app.example.com/oauth/token", { method: "POST" }),
      async () => {
        throw new Error("redis unavailable");
      }
    );
    expect(retryAfter).toBeNull();
  });

  redisTest.for([
    ["token", "/oauth/token", tokenAction],
    ["revoke", "/oauth/revoke", revokeAction],
  ] as const)(
    "%s returns 429 once an IP exceeds its limit",
    async ([name, path, action], { redisOptions }) => {
      mockEnv.RATE_LIMIT_REDIS_HOST = redisOptions.host!;
      mockEnv.RATE_LIMIT_REDIS_PORT = redisOptions.port!;
      mockEnv.RATE_LIMIT_REDIS_PASSWORD = redisOptions.password;
      onTestFinished(() => vi.useRealTimers());
      vi.useFakeTimers({ toFake: ["Date"], now: RATE_LIMIT_TEST_TIME });
      const send = () =>
        action({
          request: new Request(`https://app.example.com${path}`, {
            method: "POST",
            headers: { "x-forwarded-for": "203.0.113.7" },
          }),
          params: {},
          context: {},
        });
      for (let i = 0; i < OAUTH_IP_LIMITS[name]; i++) {
        expect((await send()).status).not.toBe(429);
      }
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).not.toBeNull();
    }
  );

  postgresTest("an idle refresh handle is refused", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();
    const issued = await grant(clientId, user.id);
    await prisma.oAuthRefreshToken.updateMany({
      data: { idleExpiresAt: new Date(Date.now() - 1) },
    });

    const result = await exchangeRefreshToken(refreshParams(clientId, issued.refresh_token));
    expect(result).toMatchObject({ ok: false, body: { error: "invalid_grant" } });
  });

  postgresTest("revoking an access token revokes its grant", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const clientId = await register();
    const issued = await grant(clientId, user.id);

    await revokeToken(new URLSearchParams({ token: issued.access_token }));
    expect(await livePats(user.id)).toBe(0);
    const refreshed = await exchangeRefreshToken(refreshParams(clientId, issued.refresh_token));
    expect(refreshed.ok).toBe(false);
  });

  postgresTest.for([
    { name: "an API-audience token", audience: undefined, cliPat: false },
    { name: "a token minted from a CLI PAT", audience: RESOURCE, cliPat: true },
  ] as Array<{ name: string; audience?: string; cliPat: boolean }>)(
    "revoking $name leaves its PAT live",
    async (row, { prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      if (!row.cliPat) await grant(await register(), user.id);
      const pat = row.cliPat
        ? await createPersonalAccessToken({ name: "cli", userId: user.id })
        : await prisma.personalAccessToken.findFirstOrThrow({ where: { userId: user.id } });
      const token = await signUserActorToken(mockEnv.SESSION_SECRET, {
        userId: user.id,
        client: "test",
        pat: pat.id,
        audience: row.audience,
      });

      await revokeToken(new URLSearchParams({ token }));
      expect(await livePats(user.id)).toBe(1);
    }
  );

  postgresTest("concurrent identical registrations share one client", async ({ prisma }) => {
    db.client = prisma;
    const body = { redirect_uris: [REDIRECT_URI], client_name: "Racer" };
    const results = await Promise.all([registerClient(body), registerClient(body)]);

    const ids = results.map((r) => (r.ok ? r.body.client_id : null));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
  });

  postgresTest("authorize refuses an impersonating session", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    session.user = { id: user.id, isImpersonating: true };
    const url = `https://app.example.com/oauth/authorize?${authorizeParams(await register(), pkce().challenge)}`;

    const response = await authorizeLoader({
      request: new Request(url),
      params: {},
      context: {},
    } as any).catch((thrown: unknown) => thrown);
    expect((response as Response).status).toBe(403);
    expect(await prisma.authorizationCode.count()).toBe(0);
  });

  postgresTest("revoking a refresh handle revokes the grant PAT", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const issued = await grant(await register(), user.id);

    await revokeToken(new URLSearchParams({ token: issued.refresh_token }));
    expect(await livePats(user.id)).toBe(0);
  });

  postgresTest("the consent redirect carries code, state and iss", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const code = await authorize(await register(), pkce().challenge, user.id);

    const url = new URL((await buildOAuthRedirect(code, "xyz"))!);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code,
      state: "xyz",
      iss: mockEnv.APP_ORIGIN,
    });
  });

  postgresTest.for([
    { name: "admin scope", extra: { scope: "admin" }, error: "invalid_scope" },
    {
      name: "an unknown scope",
      extra: { scope: "read:runs manage:everything" },
      error: "invalid_scope",
    },
    {
      name: "unknown resource",
      extra: { resource: "https://evil.example.com/mcp" },
      error: "invalid_target",
    },
    { name: "missing resource", extra: { resource: "" }, error: "invalid_target" },
    { name: "plain PKCE", extra: { code_challenge_method: "plain" }, error: "invalid_request" },
  ] as Array<{ name: string; extra: Record<string, string>; error: string }>)(
    "authorize rejects $name",
    async ({ extra, error }, { prisma }) => {
      db.client = prisma;
      const clientId = await register();
      const result = await validateAuthorizationRequest(
        authorizeParams(clientId, pkce().challenge, extra)
      );
      expect(result).toMatchObject({ ok: false, redirect: false, error: { error } });
    }
  );

  postgresTest(
    "a bad parameter redirects to a preregistered client but not a dynamic or metadata one",
    async ({ prisma }) => {
      db.client = prisma;
      session.user = { id: (await createUser(prisma)).id, isImpersonating: false };
      await prisma.oAuthClient.create({
        data: { kind: "PREREGISTERED", clientId: "trigger-test", redirectUris: [REDIRECT_URI] },
      });
      const call = (clientId: string) =>
        authorizeLoader({
          request: new Request(
            `https://app.example.com/oauth/authorize?${authorizeParams(clientId, pkce().challenge, {
              response_type: "token",
            })}`
          ),
          params: {},
          context: {},
        } as any);

      const preregistered = await call("trigger-test");
      expect(preregistered.status).toBe(302);
      expect(new URL(preregistered.headers.get("Location")!).searchParams.get("error")).toBe(
        "unsupported_response_type"
      );

      const cimdId = "https://client.example.com/metadata.json";
      await prisma.oAuthClient.create({
        data: {
          kind: "CIMD",
          clientId: cimdId,
          metadataUrl: cimdId,
          redirectUris: [REDIRECT_URI],
          metadataExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      for (const clientId of [await register(), cimdId]) {
        const response = await call(clientId);
        expect(response.status).toBe(400);
        expect(response.headers.get("Location")).toBeNull();
      }
    }
  );

  redisTest(
    "authorize returns 429 once an IP exceeds its limit, for any client_id",
    async ({ redisOptions }) => {
      mockEnv.RATE_LIMIT_REDIS_HOST = redisOptions.host!;
      mockEnv.RATE_LIMIT_REDIS_PORT = redisOptions.port!;
      mockEnv.RATE_LIMIT_REDIS_PASSWORD = redisOptions.password;
      session.user = { id: "u", isImpersonating: false };
      onTestFinished(() => vi.useRealTimers());
      vi.useFakeTimers({ toFake: ["Date"], now: RATE_LIMIT_TEST_TIME });
      const send = () =>
        authorizeLoader({
          request: new Request("https://app.example.com/oauth/authorize?client_id=plain", {
            headers: { "x-forwarded-for": "203.0.113.9" },
          }),
          params: {},
          context: {},
        } as any);
      for (let i = 0; i < OAUTH_IP_LIMITS.cimd; i++) {
        expect((await send()).status).not.toBe(429);
      }
      expect((await send()).status).toBe(429);
    }
  );

  postgresTest.for([
    ["http://localhost:51234/callback", true],
    ["http://localhost:51234/other", false],
    ["http://127.0.0.1:51234/callback", false],
    ["http://localhost:5/callback?x=1", false],
    ["http://localhost.evil.com:5/callback", false],
    ["http://localhost:5/callback#", false],
    ["https://claude.ai/other", false],
    ["https://claude.ai:8443/api/mcp/auth_callback", false],
  ] as Array<[string, boolean]>)(
    "authorize matches redirect_uri %s: %s",
    async ([redirectUri, accepted], { prisma }) => {
      db.client = prisma;
      const result = await registerClient({
        redirect_uris: ["http://localhost:3000/callback", REDIRECT_URI],
      });
      if (!result.ok) throw new Error(result.body.error_description);
      const outcome = await validateAuthorizationRequest(
        authorizeParams(result.body.client_id as string, pkce().challenge, {
          redirect_uri: redirectUri,
        })
      );
      expect(outcome).toMatchObject(
        accepted ? { ok: true, request: { redirectUri } } : { ok: false, redirect: false }
      );
    }
  );

  postgresTest(
    "authorize accepts Claude Code's metadata document client on an ephemeral port",
    async ({ prisma }) => {
      db.client = prisma;
      const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
      const transport = documentTransport(
        200,
        JSON.stringify({
          client_id: clientId,
          client_name: "Claude Code",
          redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
        })
      );
      const redirectUri = "http://localhost:57688/callback";
      const outcome = await validateAuthorizationRequest(
        authorizeParams(clientId, pkce().challenge, { redirect_uri: redirectUri }),
        transport
      );
      expect(outcome).toMatchObject({ ok: true, request: { redirectUri } });
    }
  );

  postgresTest.for([
    "https://claude.ai.evil.com/callback",
    "https://evil.com/callback",
    "http://claude.ai/callback",
    "https://claude.ai:8443/callback",
    "http://localhost.evil.com:3000/callback",
  ])("register rejects redirect URI %s", async (uri, { prisma }) => {
    db.client = prisma;
    const result = await registerClient({ redirect_uris: [uri] });
    expect(result).toMatchObject({ ok: false, body: { error: "invalid_redirect_uri" } });
    expect(await prisma.oAuthClient.count()).toBe(0);
  });

  postgresTest("a metadata document client is fetched once and cached", async ({ prisma }) => {
    db.client = prisma;
    const clientId = "https://claude.ai/oauth/mcp-client.json";
    const transport = vi.fn(
      documentTransport(
        200,
        JSON.stringify({
          client_id: clientId,
          redirect_uris: [REDIRECT_URI],
          client_name: "Claude",
        })
      )
    );

    const client = await resolveClient(clientId, transport);
    expect(client).toMatchObject({ kind: "CIMD", redirectUris: [REDIRECT_URI] });
    await resolveClient(clientId, transport);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  postgresTest.for([
    { name: "an IPv6 loopback literal", clientId: "https://[::1]/client.json" },
    { name: "a trailing-dot localhost", clientId: "https://localhost./client.json" },
    { name: "a redirect", status: 302 },
    { name: "an oversized body", size: 64 * 1024 + 1 },
  ] as Array<{ name: string; clientId?: string; status?: number; size?: number }>)(
    "a metadata document client is refused for $name",
    async (row, { prisma }) => {
      db.client = prisma;
      const clientId = row.clientId ?? "https://claude.ai/oauth/mcp-client.json";
      const document = JSON.stringify({
        client_id: clientId,
        redirect_uris: [REDIRECT_URI],
        padding: "x".repeat(row.size ?? 0),
      });
      const transport = vi.fn(documentTransport(row.status ?? 200, document));

      expect(await resolveClient(clientId, transport)).toBeNull();
      expect(await prisma.oAuthClient.count()).toBe(0);
    }
  );

  it.for([
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["::ffff:127.0.0.1", false],
    ["169.254.169.254", false],
    ["fd00::1", false],
    ["fe80::1", false],
    // Catches: the metadata fetch disagreeing with the shared address rule on NAT64 and 6to4.
    ["64:ff9b::808:808", true],
    ["64:ff9b::a9fe:a9fe", false],
    ["2002:a9fe:a9fe::1", false],
    ["::a9fe:a9fe", false],
  ] as const)("isPublicAddress(%s) is %s", ([address, expected]) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it("the metadata fetch refuses to connect to a loopback address", async () => {
    const error = await new Promise((resolve) => publicOnlyLookup("localhost", {}, resolve));
    expect(error).toBeInstanceOf(Error);
  });
});
