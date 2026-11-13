import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));
const flags = vi.hoisted(() => ({ mcpEnabled: true }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
  $transaction: (client: PrismaClient, _name: string, fn: (tx: PrismaClient) => Promise<unknown>) =>
    client.$transaction(fn as never),
}));
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-test-session-secret",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      APP_ORIGIN: "https://cloud.example.com",
      MCP_ORIGIN: "https://mcp.example.com",
      NODE_ENV: "test",
      OAUTH_GRANT_IDLE_DAYS: 30,
      OAUTH_GRANT_ABSOLUTE_DAYS: 90,
      get MCP_SERVER_ENABLED() {
        return flags.mcpEnabled;
      },
    }),
  };
});
vi.mock("~/services/rbac.server", () => ({ rbac: {} }));

import { MCP_SCOPES } from "~/services/oauth/metadata.server";
import { getCsrfToken } from "~/services/csrf.server";
import {
  createOAuthAuthorizationCode,
  oauthCodeKey,
  validateAuthorizationRequest,
} from "~/services/oauth/authorize.server";
import { exchangeAuthorizationCode } from "~/services/oauth/token.server";
import {
  consentDocumentHeaders,
  decideOAuthConsent,
  describeScopes,
  describeOAuthClientName,
  loadOAuthConsent,
} from "~/services/oauth/consent.server";
import { AUTHORIZATION_CODE_TTL_MS } from "~/services/personalAccessToken.server";

const REDIRECT_URI = "https://app.example.com/callback";
const PAGE = "https://cloud.example.com/account/authorization-code/x";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seedUser(prisma: PrismaClient) {
  db.client = prisma;
  return prisma.user.create({
    data: { email: `u-${suffix()}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
}

type CodeOverrides = Partial<{
  createdAt: Date;
  approvedByUserId: string;
  requestedByUserId: string | null;
}>;

async function seedCode(
  prisma: PrismaClient,
  user: { id: string },
  client: Parameters<PrismaClient["oAuthClient"]["create"]>[0]["data"],
  overrides: CodeOverrides = {}
) {
  db.client = prisma;
  const oauthClient = await prisma.oAuthClient.create({ data: client });
  const plaintext = `code_${suffix()}${suffix()}`;
  const row = await prisma.authorizationCode.create({
    data: {
      code: oauthCodeKey(plaintext),
      oauthClientId: oauthClient.id,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
      resource: "https://mcp.example.com/mcp",
      scope: ["read:runs", "read:query"],
      requestedByUserId: user.id,
      ...overrides,
    },
  });
  return { ...row, code: plaintext };
}

const preregistered = () => ({
  kind: "PREREGISTERED" as const,
  clientId: `client_${suffix()}`,
  displayName: "Trusted Client",
  redirectUris: [REDIRECT_URI],
});

async function csrfSession() {
  const { token, setCookie } = await getCsrfToken(new Request(PAGE));
  const cookie = setCookie!.split(";")[0];
  const post = (fields: Record<string, string>) => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    return {
      request: new Request(PAGE, { method: "POST", headers: { Cookie: cookie } }),
      formData,
    };
  };
  return { token, post };
}

async function decide(
  code: { code: string },
  userId: string,
  decision: "approve" | "deny",
  state?: string
) {
  const { token, post } = await csrfSession();
  const { request, formData } = post({ csrfToken: token, decision });
  return decideOAuthConsent(request, { code: code.code, userId, formData, state });
}

describe("OAuth consent", () => {
  it("labels every MCP scope readably, not as a raw id", () => {
    const labels = describeScopes([...MCP_SCOPES]);
    expect(labels.filter((label, i) => label === MCP_SCOPES[i])).toEqual([]);
  });

  postgresTest(
    "identity comes from the OAuthClient row, never from the URL",
    async ({ prisma }) => {
      const user = await seedUser(prisma);
      const code = await seedCode(prisma, user, preregistered());
      const request = new Request(`${PAGE}?clientName=Evil&source=mcp`);

      const view = await loadOAuthConsent(request, code.code, user.id);

      expect(view).toMatchObject({
        status: "consent",
        client: { primary: "Trusted Client", unverified: false },
        scopes: ["Read runs", "Run read-only queries"],
      });
      expect(JSON.stringify(view)).not.toContain("Evil");
    }
  );

  postgresTest("CIMD and DCR identities follow the client kind", async ({ prisma }) => {
    const user = await seedUser(prisma);
    const cimd = await seedCode(prisma, user, {
      kind: "CIMD",
      clientId: "https://client.example.org/meta.json",
      selfReportedName: "Cimd App",
      redirectUris: [REDIRECT_URI],
    });
    const dcr = await seedCode(prisma, user, {
      kind: "DCR",
      clientId: `client_${suffix()}`,
      selfReportedName: "Totally Trusted",
      redirectUris: [REDIRECT_URI],
    });

    const [cimdView, dcrView] = await Promise.all(
      [cimd, dcr].map((c) => loadOAuthConsent(new Request(PAGE), c.code, user.id))
    );

    expect(cimdView).toMatchObject({
      client: { primary: "client.example.org", unverified: false, selfReported: "Cimd App" },
    });
    expect(dcrView).toMatchObject({
      client: {
        primary: "Unverified application (https://app.example.com)",
        unverified: true,
        selfReported: "Totally Trusted",
      },
    });
  });

  // Catches: the confirm page showing a registered redirect origin the user never authorized.
  postgresTest(
    "the confirm page client string marks DCR unverified without an origin",
    async ({ prisma }) => {
      const user = await seedUser(prisma);
      const clientId = `client_${suffix()}`;
      await seedCode(prisma, user, {
        kind: "DCR",
        clientId,
        selfReportedName: "Totally Trusted",
        redirectUris: [REDIRECT_URI],
      });
      const name = await describeOAuthClientName(clientId);
      expect(name).toBe('"Totally Trusted" (unverified)');
    }
  );

  postgresTest("switch account link rebuilds the authorize request", async ({ prisma }) => {
    const user = await seedUser(prisma);
    const client = preregistered();
    const code = await seedCode(prisma, user, client);

    const view = await loadOAuthConsent(new Request(`${PAGE}?state=st%201`), code.code, user.id);

    const path = (view as { reauthorizePath: string }).reauthorizePath;
    expect(path.startsWith("/oauth/authorize?")).toBe(true);
    expect(Object.fromEntries(new URL(path, "https://x").searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "read:runs read:query",
      resource: "https://mcp.example.com/mcp",
      state: "st 1",
    });
  });

  postgresTest(
    "approve records the approving user and redirects with code, state, iss",
    async ({ prisma }) => {
      const user = await seedUser(prisma);
      const code = await seedCode(prisma, user, preregistered());

      const result = await decide(code, user.id, "approve", "s1");

      expect(result.status).toBe("redirect");
      const url = new URL((result as { url: string }).url);
      expect(url.origin + url.pathname).toBe(REDIRECT_URI);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        code: code.code,
        state: "s1",
        iss: "https://cloud.example.com",
      });
      const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: code.id } });
      expect(row.approvedByUserId).toBe(user.id);
    }
  );

  postgresTest("approve without a valid CSRF token is rejected", async ({ prisma }) => {
    const user = await seedUser(prisma);
    const code = await seedCode(prisma, user, preregistered());
    const { post } = await csrfSession();

    const attempts: Record<string, string>[] = [
      { decision: "approve" },
      { csrfToken: "wrong", decision: "approve" },
    ];
    for (const fields of attempts) {
      const { request, formData } = post(fields);
      const result = await decideOAuthConsent(request, {
        code: code.code,
        userId: user.id,
        formData,
      });
      expect(result.status).toBe("csrf");
    }
    const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.approvedByUserId).toBeNull();
  });

  postgresTest("deny redirects with access_denied and drops the code", async ({ prisma }) => {
    const user = await seedUser(prisma);
    const code = await seedCode(prisma, user, preregistered());

    const result = await decide(code, user.id, "deny", "s2");

    const url = new URL((result as { url: string }).url);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("s2");
    expect(await prisma.authorizationCode.count({ where: { id: code.id } })).toBe(0);
  });

  postgresTest(
    "expired, approved, foreign and unowned codes are invalid and unchanged",
    async ({ prisma }) => {
      const user = await seedUser(prisma);
      const other = await seedUser(prisma);
      const cases = {
        expired: await seedCode(prisma, user, preregistered(), {
          createdAt: new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS - 1_000),
        }),
        approved: await seedCode(prisma, user, preregistered(), { approvedByUserId: other.id }),
        foreign: await seedCode(prisma, other, preregistered()),
        unowned: await seedCode(prisma, user, preregistered(), { requestedByUserId: null }),
      };

      for (const [name, code] of Object.entries(cases)) {
        expect(await loadOAuthConsent(new Request(PAGE), code.code, user.id), name).toEqual({
          status: "invalid",
        });
        for (const decision of ["approve", "deny"] as const) {
          expect((await decide(code, user.id, decision)).status, `${name} ${decision}`).toBe(
            "invalid"
          );
        }
        const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: code.id } });
        expect(row.approvedByUserId, name).toBe(name === "approved" ? other.id : null);
      }
    }
  );

  postgresTest("a missing or unknown decision changes nothing", async ({ prisma }) => {
    const user = await seedUser(prisma);
    const code = await seedCode(prisma, user, preregistered());
    const { token, post } = await csrfSession();

    const attempts: Record<string, string>[] = [
      { csrfToken: token },
      { csrfToken: token, decision: "yes" },
    ];
    for (const fields of attempts) {
      const { request, formData } = post(fields);
      const result = await decideOAuthConsent(request, {
        code: code.code,
        userId: user.id,
        formData,
      });
      expect(result.status).toBe("bad_request");
    }
    const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.approvedByUserId).toBeNull();
  });

  postgresTest("OAuth codes are invalid while the MCP server is disabled", async ({ prisma }) => {
    const user = await seedUser(prisma);
    const code = await seedCode(prisma, user, preregistered());
    const cli = await prisma.authorizationCode.create({ data: { code: `cli_${suffix()}` } });
    flags.mcpEnabled = false;
    try {
      expect(await loadOAuthConsent(new Request(PAGE), code.code, user.id)).toEqual({
        status: "invalid",
      });
      expect((await decide(code, user.id, "approve")).status).toBe("invalid");
      expect(await loadOAuthConsent(new Request(PAGE), cli.code, user.id)).toEqual({
        status: "not_oauth",
      });
    } finally {
      flags.mcpEnabled = true;
    }
    const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.approvedByUserId).toBeNull();
  });

  postgresTest("an impersonating session cannot view or approve", async ({ prisma }) => {
    const user = await seedUser(prisma);
    const code = await seedCode(prisma, user, preregistered());
    const { token, post } = await csrfSession();
    const { request, formData } = post({ csrfToken: token, decision: "approve" });

    expect(await loadOAuthConsent(new Request(PAGE), code.code, user.id, true)).toEqual({
      status: "impersonating",
    });
    const result = await decideOAuthConsent(request, {
      code: code.code,
      userId: user.id,
      formData,
      isImpersonating: true,
    });

    expect(result.status).toBe("impersonating");
    const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.approvedByUserId).toBeNull();
  });

  // Catches: dropping the requester binding so any signed-in user can approve another's code.
  postgresTest("a different signed-in user is refused, not re-confirmed", async ({ prisma }) => {
    const a = await seedUser(prisma);
    const b = await seedUser(prisma);
    const code = await seedCode(prisma, a, preregistered());

    expect(await loadOAuthConsent(new Request(PAGE), code.code, b.id)).toEqual({
      status: "invalid",
    });
    expect((await decide(code, b.id, "approve")).status).toBe("invalid");

    const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.approvedByUserId).toBeNull();
  });

  // Catches: the switch-account path not starting a fresh flow bound to the new user.
  postgresTest("switch account starts a new flow the new user can approve", async ({ prisma }) => {
    const a = await seedUser(prisma);
    const b = await seedUser(prisma);
    const first = await seedCode(prisma, a, preregistered());

    const view = await loadOAuthConsent(new Request(PAGE), first.code, a.id);
    const path = (view as { reauthorizePath: string }).reauthorizePath;
    const validated = await validateAuthorizationRequest(new URL(path, "https://x").searchParams);
    if (!validated.ok) throw new Error("reauthorize request rejected");
    const fresh = await createOAuthAuthorizationCode(validated.request, b.id);

    expect(fresh.code).not.toBe(first.code);
    expect((await decide(first, b.id, "approve")).status).toBe("invalid");
    expect((await decide(fresh, b.id, "approve")).status).toBe("redirect");
    const row = await prisma.authorizationCode.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.approvedByUserId).toBeNull();
  });

  // Catches: a pre-registered client's earlier grant surviving re-authorization.
  postgresTest(
    "re-authorizing a pre-registered client replaces the earlier grant",
    async ({ prisma }) => {
      const user = await seedUser(prisma);
      const client = preregistered();
      await prisma.oAuthClient.create({ data: client });

      async function authorizeAndExchange() {
        const verifier = randomBytes(32).toString("base64url");
        const params = new URLSearchParams({
          response_type: "code",
          client_id: client.clientId,
          redirect_uri: REDIRECT_URI,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          scope: "read:runs",
          resource: "https://mcp.example.com/mcp",
        });
        const validated = await validateAuthorizationRequest(params);
        if (!validated.ok) throw new Error("authorize request rejected");
        const code = await createOAuthAuthorizationCode(validated.request, user.id);
        expect((await loadOAuthConsent(new Request(PAGE), code.code, user.id)).status).toBe(
          "consent"
        );
        expect((await decide(code, user.id, "approve")).status).toBe("redirect");
        const result = await exchangeAuthorizationCode(
          new URLSearchParams({
            grant_type: "authorization_code",
            code: code.code,
            client_id: client.clientId,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
          }),
          { ip: null, userAgent: null },
          async () => "access-token"
        );
        expect(result.ok).toBe(true);
      }

      await authorizeAndExchange();
      await authorizeAndExchange();

      const pats = await prisma.personalAccessToken.findMany({ where: { userId: user.id } });
      expect(pats.map((pat) => pat.revokedAt === null).sort()).toEqual([false, true]);
    }
  );

  postgresTest("a CLI code is not treated as an OAuth code", async ({ prisma }) => {
    db.client = prisma;
    const cli = await prisma.authorizationCode.create({ data: { code: `cli_${suffix()}` } });

    expect(await loadOAuthConsent(new Request(PAGE), cli.code, "user_1")).toEqual({
      status: "not_oauth",
    });
  });
});

describe("consent document headers", () => {
  it("deny framing, caching, and keep the loader cookie", async () => {
    const headers = consentDocumentHeaders(new Headers({ "Set-Cookie": "a=b" }));

    expect(Object.fromEntries(headers)).toEqual({
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "set-cookie": "a=b",
    });
  });
});
