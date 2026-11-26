import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Database from "~/db.server";
import type * as ConsentRoute from "~/routes/account_.authorization-code.$authorizationCode/route";
import type * as MfaVerifyRoute from "~/routes/mfa.verify/route";
import type * as Csrf from "~/services/csrf.server";
import type * as SessionStorage from "~/services/sessionStorage.server";

// The consent route through its real loader and action, against a real database: granting
// read:envvars asks for recent MFA when one of the user's organizations requires it.

vi.setConfig({ testTimeout: 60_000 });

const CALLBACK = "https://app.example.com/callback";
const STATE = "client-state-123";

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let sessionStorage: typeof SessionStorage;
let csrf: typeof Csrf;
let route: typeof ConsentRoute;
let mfaVerify: typeof MfaVerifyRoute;
let oauthCodeKey: (code: string) => string;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("SESSION_SECRET", "test-session-secret-for-consent-mfa");
  vi.stubEnv("MCP_SERVER_ENABLED", "true");

  database = await import("~/db.server");
  sessionStorage = await import("~/services/sessionStorage.server");
  csrf = await import("~/services/csrf.server");
  route = await import("~/routes/account_.authorization-code.$authorizationCode/route");
  mfaVerify = await import("~/routes/mfa.verify/route");
  ({ oauthCodeKey } = await import("~/services/oauth/authorize.server"));
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

const suffix = () => Math.random().toString(36).slice(2, 10);
const pagePath = (code: string) => `/account/authorization-code/${code}?state=${STATE}`;
const page = (code: string) => `http://localhost${pagePath(code)}`;

async function setup() {
  const { prisma } = database;
  const user = await prisma.user.create({
    data: {
      email: `u-${suffix()}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      mfaEnabledAt: new Date(),
    },
  });
  await prisma.organization.create({
    data: {
      slug: `org-${suffix()}`,
      title: "Org",
      mfaStepUpActions: ["environmentVariables"],
      members: { create: { userId: user.id, role: "MEMBER" } },
    },
  });
  const oauthClient = await prisma.oAuthClient.create({
    data: {
      kind: "PREREGISTERED",
      clientId: `client_${suffix()}`,
      displayName: "Client",
      redirectUris: [CALLBACK],
    },
  });
  const code = async (scope: string[], createdAt = new Date()) => {
    const plaintext = `code_${suffix()}${suffix()}`;
    await prisma.authorizationCode.create({
      data: {
        code: oauthCodeKey(plaintext),
        oauthClientId: oauthClient.id,
        redirectUri: CALLBACK,
        scope,
        requestedByUserId: user.id,
        createdAt,
      },
    });
    return plaintext;
  };
  const session = await sessionStorage.getSession();
  session.set("user", { userId: user.id });
  const signedIn = (await sessionStorage.commitSession(session)).split(";")[0]!;
  const { token, setCookie } = await csrf.getCsrfToken(
    new Request("http://localhost/", { headers: { Cookie: signedIn } })
  );
  const cookie = setCookie!.split(";")[0]!;
  const { MFA_VERIFIED_AT_SESSION_KEY } = await import("~/services/mfa/mfaPolicy.server");
  const verified = await sessionStorage.getSession(cookie);
  verified.set(MFA_VERIFIED_AT_SESSION_KEY, Date.now());
  const verifiedCookie = (await sessionStorage.commitSession(verified)).split(";")[0]!;

  const load = (authorizationCode: string) => () =>
    route.loader({
      request: new Request(page(authorizationCode), { headers: { Cookie: cookie } }),
      params: { authorizationCode },
      context: {},
    });
  const decide =
    (authorizationCode: string, decision: "approve" | "deny", mfaVerified = false) =>
    () =>
      route.action({
        request: new Request(page(authorizationCode), {
          method: "POST",
          headers: {
            Cookie: mfaVerified ? verifiedCookie : cookie,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ csrfToken: token, decision }).toString(),
        }),
        params: { authorizationCode },
        context: {},
      });
  /** Where the MFA page sends the user back to once the code is verified. */
  const backFromMfa = async (location: string) => {
    const response = await mfaVerify.loader({
      request: new Request(`http://localhost${location}`, { headers: { Cookie: cookie } }),
      params: {},
      context: {},
    });
    return ((await response.json()) as { redirectTo: string }).redirectTo;
  };
  return { code, load, decide, backFromMfa };
}

/** Where the route sends the user: the redirect it throws or returns, or "no redirect". */
async function redirectOf(run: () => Promise<unknown>) {
  const outcome = await run().then(
    (value) => value,
    (thrown) => thrown
  );
  if (!(outcome instanceof Response) || outcome.status !== 302) return "no redirect";
  const location = outcome.headers.get("Location")!;
  if (!location.startsWith(CALLBACK)) return location;
  // The client callback, without the issuer the server appends.
  const query = new URL(location).searchParams;
  query.delete("iss");
  return `${CALLBACK}?${query}`;
}

const toMfa = (code: string) =>
  `/mfa/verify?${new URLSearchParams({ redirectTo: pagePath(code) })}`;

describe("authorization code consent route", () => {
  // Mutation: drop the MFA check from the loader or the approval, check before validating the
  // code or the CSRF token, ask on a deny or without the scope, lose the consent page on return,
  // or refuse an approval after a recent MFA check.
  it("asks for recent MFA only to show or approve a pending read:envvars consent", async () => {
    const { code, load, decide, backFromMfa } = await setup();
    const envVars = await code(["read:runs", "read:envvars"]);
    const plain = await code(["read:runs"]);
    const denied = await code(["read:envvars"]);
    const stale = await code(["read:envvars"], new Date(Date.now() - 24 * 60 * 60 * 1000));
    const verified = await code(["read:envvars"]);

    const outcomes = {
      showEnvVars: await redirectOf(load(envVars)),
      approveEnvVars: await redirectOf(decide(envVars, "approve")),
      denyEnvVars: await redirectOf(decide(denied, "deny")),
      showStale: await redirectOf(load(stale)),
      approveStale: await redirectOf(decide(stale, "approve")),
      showPlain: await redirectOf(load(plain)),
      approvePlain: await redirectOf(decide(plain, "approve")),
      approveAfterMfa: await redirectOf(decide(verified, "approve", true)),
    };

    expect(await backFromMfa(outcomes.approveEnvVars!)).toBe(pagePath(envVars));
    expect(outcomes).toEqual({
      showEnvVars: toMfa(envVars),
      approveEnvVars: toMfa(envVars),
      denyEnvVars: `${CALLBACK}?error=access_denied&state=${STATE}`,
      showStale: "no redirect",
      approveStale: "no redirect",
      showPlain: "no redirect",
      approvePlain: `${CALLBACK}?code=${plain}&state=${STATE}`,
      approveAfterMfa: `${CALLBACK}?code=${verified}&state=${STATE}`,
    });
  });
});
