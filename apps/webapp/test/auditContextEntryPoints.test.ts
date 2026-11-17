import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { signUserActorToken } from "@trigger.dev/rbac";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as Database from "~/db.server";
import type * as Admin from "~/models/admin.server";
import type * as ApiAuth from "~/services/apiAuth.server";
import type * as AuditContext from "~/services/auditLogs/auditContext.server";
import type * as HttpAsyncStorage from "~/services/httpAsyncStorage.server";
import type * as PersonalAccessTokens from "~/services/personalAccessToken.server";
import type * as ApiBuilder from "~/services/routeBuilders/apiBuilder.server";
import type * as Session from "~/services/session.server";
import type * as SessionStorage from "~/services/sessionStorage.server";
import type * as UatRoutePreamble from "~/services/uatRoutePreamble.server";
import type * as Tokens from "~/utils/tokens.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

// Auth functions that read the app's own database client, run end to end so the audit context
// is checked against what they really resolve.

vi.setConfig({ testTimeout: 30_000 });

const SESSION_SECRET = "test-session-secret-for-audit-entry-points";

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let admin: typeof Admin;
let apiAuth: typeof ApiAuth;
let apiBuilder: typeof ApiBuilder;
let personalAccessTokens: typeof PersonalAccessTokens;
let tokens: typeof Tokens;
let auditContext: typeof AuditContext;
let httpAsyncStorage: typeof HttpAsyncStorage;
let session: typeof Session;
let sessionStorage: typeof SessionStorage;
let uatRoutePreamble: typeof UatRoutePreamble;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);

  database = await import("~/db.server");
  admin = await import("~/models/admin.server");
  apiAuth = await import("~/services/apiAuth.server");
  apiBuilder = await import("~/services/routeBuilders/apiBuilder.server");
  personalAccessTokens = await import("~/services/personalAccessToken.server");
  tokens = await import("~/utils/tokens.server");
  auditContext = await import("~/services/auditLogs/auditContext.server");
  httpAsyncStorage = await import("~/services/httpAsyncStorage.server");
  session = await import("~/services/session.server");
  sessionStorage = await import("~/services/sessionStorage.server");
  uatRoutePreamble = await import("~/services/uatRoutePreamble.server");
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** Runs `fn` the way server.ts runs a request, then returns the audit context it left behind. */
async function inRequest(fn: () => Promise<unknown>) {
  return httpAsyncStorage.runWithHttpContext(
    {
      requestId: "req_test",
      path: "/test",
      host: "localhost",
      method: "GET",
      abortController: new AbortController(),
    },
    async () => {
      await fn();
      return auditContext.getRequestAuditContext(new Date());
    }
  );
}

function createUser(options: { admin?: boolean } = {}) {
  return database.prisma.user.create({
    data: {
      email: `user-${suffix()}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      admin: options.admin ?? false,
    },
  });
}

async function loginCookie(userId: string) {
  const auth = await sessionStorage.getSession();
  auth.set("user", { userId });
  return (await sessionStorage.commitSession(auth)).split(";")[0];
}

describe("request audit context from dashboard sessions", () => {
  /**
   * Catches: getUserId recording an impersonating staff member as the actor, or dropping them,
   * instead of acting as the customer on the staff member's behalf.
   */
  it("records the impersonated customer as actor, on behalf of the staff member", async () => {
    const staff = await createUser({ admin: true });
    const customer = await createUser();
    const organization = await database.prisma.organization.create({
      data: {
        title: "Acme",
        slug: `acme-${suffix()}`,
        members: { create: [{ userId: customer.id }] },
      },
    });

    const started = await admin.redirectWithImpersonation(
      new Request("http://localhost:3030/admin", { method: "POST" }),
      {
        userId: customer.id,
        organizationSlug: organization.slug,
        path: `/orgs/${organization.slug}`,
      },
      { id: staff.id, admin: true },
      database.prisma
    );
    const impersonation = (started.headers.get("set-cookie") ?? "").split(";")[0];
    const cookie = `${await loginCookie(staff.id)}; ${impersonation}`;

    let userId: string | undefined;
    const context = await inRequest(async () => {
      userId = await session.getUserId(
        new Request(`http://localhost:3030/orgs/${organization.slug}`, {
          headers: { Cookie: cookie },
        })
      );
    });

    expect(context.actor).toEqual({ type: "user", id: customer.id });
    expect(context.onBehalfOf).toEqual({ userId: staff.id });
    expect(context.source).toBe("staff");
    expect(context.credential).toBeNull();
    expect(userId).toBe(customer.id);
  });

  /** Catches: getUserId leaving a plain session unattributed, or marking it as staff. */
  it("records a plain session as its user", async () => {
    const user = await createUser();
    const cookie = await loginCookie(user.id);

    const context = await inRequest(() =>
      session.getUserId(new Request("http://localhost:3030/", { headers: { Cookie: cookie } }))
    );

    expect(context.actor).toEqual({ type: "user", id: user.id });
    expect(context.onBehalfOf).toBeNull();
    expect(context.source).toBe("dashboard");
  });
});

describe("request audit context from user-actor tokens", () => {
  function uatRequest(token: string) {
    return new Request("https://api.trigger.dev/api/v1/dashboard-agent/alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "user-agent": "dashboard-agent" },
    });
  }

  /** Catches: authenticateUatOrApiRequest letting a user-actor token act with no actor recorded. */
  it("records a user-actor token minted from a PAT as its user and source PAT", async () => {
    const user = await createUser();
    const pat = await database.prisma.personalAccessToken.create({
      data: {
        name: "cli",
        userId: user.id,
        encryptedToken: {},
        obfuscatedToken: "tr_pat_****",
        hashedToken: `hash_${suffix()}`,
      },
    });
    const token = await signUserActorToken(SESSION_SECRET, {
      userId: user.id,
      client: "cli",
      pat: pat.id,
    });

    let authenticated: UatRoutePreamble.UatAuthentication | undefined;
    const context = await inRequest(async () => {
      authenticated = await uatRoutePreamble.authenticateUatOrApiRequest(uatRequest(token));
    });

    expect(authenticated?.userActor?.pat).toBe(pat.id);
    expect(context.actor).toEqual({ type: "user", id: user.id });
    expect(context.credential).toEqual({
      kind: "pat",
      id: pat.id,
      last4: null,
      fingerprintId: null,
    });
    expect(context.source).toBe("api");
    expect(context.endpoint).toEqual({ ip: null, userAgent: "dashboard-agent" });
  });

  /** Catches: a user-actor token minted from a session recorded as a PAT the user doesn't have. */
  it("records a user-actor token minted without a PAT as its user, with no credential", async () => {
    const user = await createUser();
    const token = await signUserActorToken(SESSION_SECRET, {
      userId: user.id,
      client: "dashboard-agent",
    });

    const context = await inRequest(() =>
      uatRoutePreamble.authenticateUatOrApiRequest(uatRequest(token))
    );

    expect(context.actor).toEqual({ type: "user", id: user.id });
    expect(context.credential).toBeNull();
    expect(context.source).toBe("api");
  });
});

// Auth functions that note the caller in more than one branch. The coverage test checks each
// function calls its note, but not that every branch does.
describe("request audit context from every branch of multi-branch auth functions", () => {
  function bearerRequest(token: string, method = "GET") {
    return new Request("https://api.trigger.dev/api/v1/test", {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  /** Catches: one of authenticateRequest's PAT, OAT or API key branches not noting its caller. */
  it("notes the caller on each authenticateRequest branch", async () => {
    const { user, organization, project } = await createTestOrgProjectWithMember(database.prisma);
    const pat = await personalAccessTokens.createPersonalAccessToken({
      name: "audit",
      userId: user.id,
    });
    const oatToken = `tr_oat_${suffix()}${suffix()}`;
    const oat = await database.prisma.organizationAccessToken.create({
      data: {
        name: "audit",
        organizationId: organization.id,
        hashedToken: tokens.hashToken(oatToken),
      },
    });
    const apiKey = `tr_prod_${suffix()}${suffix()}`;
    const environment = await createRuntimeEnvironment(database.prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      apiKey,
    });
    const allowAll = { personalAccessToken: true, organizationAccessToken: true, apiKey: true };

    const viaPat = await inRequest(() =>
      apiAuth.authenticateRequest(bearerRequest(pat.token), allowAll)
    );
    const viaOat = await inRequest(() =>
      apiAuth.authenticateRequest(bearerRequest(oatToken), allowAll)
    );
    const viaApiKey = await inRequest(() =>
      apiAuth.authenticateRequest(bearerRequest(apiKey), allowAll)
    );

    expect(viaPat.actor).toEqual({ type: "user", id: user.id });
    expect(viaPat.credential).toMatchObject({ kind: "pat", id: pat.id });
    expect(viaOat.credential).toMatchObject({ kind: "oat", id: oat.id });
    expect(viaApiKey.credential).toMatchObject({ kind: "root_api_key", id: environment.id });
  });

  /** Catches: a PAT route builder's PAT or user-actor token branch not noting its caller. */
  it("notes the caller on both branches of the PAT route builders", async () => {
    const user = await createUser();
    const pat = await personalAccessTokens.createPersonalAccessToken({
      name: "audit",
      userId: user.id,
    });
    const uat = await signUserActorToken(SESSION_SECRET, { userId: user.id, client: "cli" });
    const ok = async () => new Response(null, { status: 204 });
    const loader = apiBuilder.createLoaderPATApiRoute({}, ok);
    const action = apiBuilder.createActionPATApiRoute({ method: "POST" }, ok);
    const call = (route: typeof loader, token: string, method?: string) =>
      inRequest(async () => {
        const response = await route({
          request: bearerRequest(token, method),
          params: {},
          context: {},
        } as any);
        expect(response.status).toBe(204);
      });

    for (const [route, method] of [
      [loader, "GET"],
      [action, "POST"],
    ] as const) {
      const viaPat = await call(route, pat.token, method);
      const viaUat = await call(route, uat, method);

      expect(viaPat.credential).toMatchObject({ kind: "pat", id: pat.id });
      expect(viaUat.actor).toEqual({ type: "user", id: user.id });
      expect(viaUat.credential).toBeNull();
    }
  });
});
