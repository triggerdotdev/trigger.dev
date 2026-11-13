// The HTTP contract for an expired personal access token, checked end to end: a real token row in
// a real Postgres, the routes' real authentication, and the 401 body each route sends back. A
// route that skips the expiry explanation, drops `code`, or lets an expired token through fails
// here. Only the database client (pointed at the test database) and a few env values are
// substituted.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", async () => {
  const { boundedIn } = await import("@trigger.dev/database");
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        const value = (db.client as any)[prop];
        return typeof value === "function" ? value.bind(db.client) : value;
      },
    }
  );
  return { prisma: client, $replica: client, boundedIn };
});

// Only the values these routes read. The real env module is never imported (see the
// trigger-tests skill): it validates the whole process environment at import.
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-pat-expiry-responses",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      APP_ORIGIN: "https://dashboard.example.test",
      PUBLIC_APP_ORIGIN: undefined,
      ADMIN_API_ENABLED: true,
      // The built-in RBAC fallback, on the test database. An installed plugin would open its
      // own connection instead.
      RBAC_FORCE_FALLBACK: true,
      PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS: [30, 90, 365],
      PERSONAL_ACCESS_TOKEN_DEFAULT_EXPIRY_DAYS: 90,
    }),
  };
});

import { loader as whoamiLoader } from "~/routes/api.v2.whoami";
import { loader as platformNotificationsLoader } from "~/routes/api.v1.platform-notifications";
import { loader as projectsLoader } from "~/routes/api.v1.projects";
import { action as invitesAction } from "~/routes/api.v1.orgs.$orgParam.invites";
import { action as userActorTokenAction } from "~/routes/api.v1.auth.user-actor-token";
import { action as envJwtAction } from "~/routes/api.v1.projects.$projectRef.$env.jwt";
import { action as pauseAction } from "~/routes/api.v1.projects.$projectRef.$env.pause";
import { action as resumeAction } from "~/routes/api.v1.projects.$projectRef.$env.resume";
import { action as regenerateApiKeyAction } from "~/routes/api.v1.projects.$projectRef.$env.regenerate-api-key";
import { loader as backgroundWorkerLoader } from "~/routes/api.v1.projects.$projectRef.background-workers.$envSlug.$version";
import {
  action as upsertBranchAction,
  loader as branchesLoader,
} from "~/routes/api.v1.projects.$projectRef.branches";
import { action as archiveBranchAction } from "~/routes/api.v1.projects.$projectRef.branches.archive";
import { loader as devStatusLoader } from "~/routes/api.v1.projects.$projectRef.dev-status";
import { loader as vercelProjectsLoader } from "~/routes/api.v1.orgs.$organizationSlug.projects.$projectParam.vercel.projects";
import { loader as metricsLoader } from "~/routes/projects.v3.$projectRef.metrics/route";
import { action as adminSessionDurationAction } from "~/routes/admin.api.v1.orgs.$organizationId.session-duration";
import { action as adminPlatformNotificationsAction } from "~/routes/admin.api.v1.platform-notifications";
import { createPersonalAccessToken } from "~/services/personalAccessToken.server";

const EXPIRED_AT = new Date("2026-10-01T10:00:00.000Z");

const EXPIRED_BODY = {
  error:
    "This personal access token expired on 2026-10-01 (UTC). Create a new one at https://dashboard.example.test/account/tokens.",
  code: "personal_access_token_expired",
};

const CLI_LOGIN_EXPIRED_BODY = {
  error:
    "Your CLI login expired because it wasn't used for a while. Run `npx trigger.dev@latest login` to log in again (add `--profile <name>` if you use a named profile). With an older CLI version, run `trigger.dev logout` first.",
  code: "cli_login_expired",
};

const DAY_MS = 24 * 60 * 60 * 1000;

type RouteCall = (token: string) => Promise<unknown>;

function call(
  handler: unknown,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> = {},
  body: unknown = {}
): RouteCall {
  return (token) =>
    (handler as any)({
      request: new Request(`https://api.example.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      }),
      params,
      context: {},
    });
}

/** Every route that authenticates a personal access token and explains an expired one. */
const ROUTES: Array<[name: string, route: RouteCall]> = [
  ["whoami", call(whoamiLoader, "GET", "/api/v2/whoami")],
  [
    "platform notifications",
    call(platformNotificationsLoader, "GET", "/api/v1/platform-notifications"),
  ],
  [
    "the route builder's PAT loader (project list)",
    call(projectsLoader, "GET", "/api/v1/projects"),
  ],
  [
    "the route builder's PAT action (org invites)",
    // The PAT action builder validates the body before the token, so send a valid one.
    call(
      invitesAction,
      "POST",
      "/api/v1/orgs/org_x/invites",
      { orgParam: "org_x" },
      { emails: ["teammate@example.com"] }
    ),
  ],
  ["user-actor token mint", call(userActorTokenAction, "POST", "/api/v1/auth/user-actor-token")],
  [
    "env JWT exchange",
    call(envJwtAction, "POST", "/api/v1/projects/proj_x/dev/jwt", {
      projectRef: "proj_x",
      env: "dev",
    }),
  ],
  [
    "environment pause",
    call(pauseAction, "POST", "/api/v1/projects/proj_x/prod/pause", {
      projectRef: "proj_x",
      env: "prod",
    }),
  ],
  [
    "environment resume",
    call(resumeAction, "POST", "/api/v1/projects/proj_x/prod/resume", {
      projectRef: "proj_x",
      env: "prod",
    }),
  ],
  [
    "API key regeneration",
    call(regenerateApiKeyAction, "POST", "/api/v1/projects/proj_x/prod/regenerate-api-key", {
      projectRef: "proj_x",
      env: "prod",
    }),
  ],
  [
    "background worker lookup",
    call(backgroundWorkerLoader, "GET", "/api/v1/projects/proj_x/background-workers/prod/1", {
      projectRef: "proj_x",
      envSlug: "prod",
      version: "1",
    }),
  ],
  [
    "branch list",
    call(branchesLoader, "GET", "/api/v1/projects/proj_x/branches", { projectRef: "proj_x" }),
  ],
  [
    "branch upsert",
    call(upsertBranchAction, "POST", "/api/v1/projects/proj_x/branches", { projectRef: "proj_x" }),
  ],
  [
    "branch archive",
    call(archiveBranchAction, "POST", "/api/v1/projects/proj_x/branches/archive", {
      projectRef: "proj_x",
    }),
  ],
  [
    "dev status",
    call(devStatusLoader, "GET", "/api/v1/projects/proj_x/dev-status", { projectRef: "proj_x" }),
  ],
  [
    "Vercel projects",
    call(vercelProjectsLoader, "GET", "/api/v1/orgs/org-x/projects/proj_x/vercel/projects", {
      organizationSlug: "org-x",
      projectParam: "proj_x",
    }),
  ],
  [
    "project metrics",
    call(metricsLoader, "GET", "/projects/v3/proj_x/metrics", { projectRef: "proj_x" }),
  ],
  [
    "admin API",
    call(adminSessionDurationAction, "POST", "/admin/api/v1/orgs/org_x/session-duration", {
      organizationId: "org_x",
    }),
  ],
  [
    "admin platform notifications",
    call(adminPlatformNotificationsAction, "POST", "/admin/api/v1/platform-notifications"),
  ],
];

/** The route's response, whether it was returned or thrown (the admin API throws it). */
async function responseOf(route: RouteCall, token: string): Promise<Response> {
  try {
    const result = await route(token);
    if (!(result instanceof Response)) throw new Error("the route returned no Response");
    return result;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function createToken(prisma: PrismaClient) {
  db.client = prisma;
  const suffix = Math.random().toString(36).slice(2, 10);
  const user = await prisma.user.create({
    data: {
      email: `pat-expiry-${suffix}@example.com`,
      authenticationMethod: "MAGIC_LINK",
      admin: true,
    },
  });
  const created = await createPersonalAccessToken({
    name: "ci",
    userId: user.id,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
  });
  return { token: created.token, tokenId: created.id };
}

/** A CLI login token, last used 8 days ago, so past its 7-day idle limit. */
async function createIdleCliLogin(prisma: PrismaClient) {
  db.client = prisma;
  const suffix = Math.random().toString(36).slice(2, 10);
  const user = await prisma.user.create({
    data: {
      email: `cli-idle-${suffix}@example.com`,
      authenticationMethod: "MAGIC_LINK",
      admin: true,
    },
  });
  const created = await createPersonalAccessToken({
    name: "cli",
    userId: user.id,
    idleTimeoutSeconds: 7 * 24 * 60 * 60,
  });
  await prisma.personalAccessToken.update({
    where: { id: created.id },
    data: { lastAccessedAt: new Date(Date.now() - 8 * DAY_MS) },
  });
  return { token: created.token };
}

describe("a personal access token past its expiry", () => {
  for (const [name, route] of ROUTES) {
    /** Catches: a route that lets an expired token through, or answers it with a bare 401. */
    postgresTest(`${name}: gets a 401 that explains the expiry`, async ({ prisma }) => {
      const { token, tokenId } = await createToken(prisma);
      await prisma.personalAccessToken.update({
        where: { id: tokenId },
        data: { expiresAt: EXPIRED_AT },
      });

      const response = await responseOf(route, token);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(EXPIRED_BODY);
    });

    /** Catches: the expiry lookup matching a revoked token, which should stay a plain 401. */
    postgresTest(`${name}: a revoked one gets the plain 401`, async ({ prisma }) => {
      const { token, tokenId } = await createToken(prisma);
      await prisma.personalAccessToken.update({
        where: { id: tokenId },
        data: { expiresAt: EXPIRED_AT, revokedAt: new Date() },
      });

      const response = await responseOf(route, token);

      expect(response.status).toBe(401);
      expect(await response.json()).not.toHaveProperty("code");
    });
  }
});

describe("a CLI login that went unused for too long", () => {
  for (const [name, route] of ROUTES) {
    /** Catches: a route that lets an idle CLI login through, or doesn't say to log in again. */
    postgresTest(`${name}: gets a 401 that says to log in again`, async ({ prisma }) => {
      const { token } = await createIdleCliLogin(prisma);

      const response = await responseOf(route, token);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(CLI_LOGIN_EXPIRED_BODY);
    });
  }
});

describe("a personal access token before its expiry", () => {
  /** Catches: the expiry check rejecting a token that hasn't expired. */
  postgresTest("whoami accepts it", async ({ prisma }) => {
    const { token } = await createToken(prisma);

    const response = await responseOf(ROUTES[0]![1], token);

    expect(response.status).toBe(200);
  });

  /** Catches: the route builder's PAT check rejecting a token that hasn't expired. */
  postgresTest("the route builder accepts it", async ({ prisma }) => {
    const { token } = await createToken(prisma);

    const response = await responseOf(ROUTES[2]![1], token);

    expect(response.status).toBe(200);
  });
});

describe("a token that isn't in the database", () => {
  /** Catches: the expiry explanation leaking onto a token nobody issued. */
  postgresTest("whoami gets the plain 401", async ({ prisma }) => {
    db.client = prisma;

    const response = await responseOf(ROUTES[0]![1], `tr_pat_${"z".repeat(40)}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid or Missing Access Token" });
  });
});
