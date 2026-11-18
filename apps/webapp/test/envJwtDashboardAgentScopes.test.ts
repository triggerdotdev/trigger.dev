import type { PrismaClient } from "@trigger.dev/database";
import { buildJwtAbility, signUserActorToken } from "@trigger.dev/rbac";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import { seedTestUserProject } from "./helpers/seedTestUserProject";

vi.setConfig({ testTimeout: 60_000 });

const SESSION_SECRET = "test-session-secret-for-agent-env-jwt";

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

vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-agent-env-jwt",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      APP_ORIGIN: "https://dashboard.example.test",
      RBAC_FORCE_FALLBACK: true,
      PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS: [30, 90, 365],
      PERSONAL_ACCESS_TOKEN_DEFAULT_EXPIRY_DAYS: 90,
    }),
  };
});

import { action as envJwtAction } from "~/routes/api.v1.projects.$projectRef.$env.jwt";
import { action as userActorTokenAction } from "~/routes/api.v1.auth.user-actor-token";
import { createPersonalAccessToken } from "~/services/personalAccessToken.server";
import { rbac } from "~/services/rbac.server";
import { isDashboardAgentUserActor } from "~/services/userActorEnvironment.server";

const READS = ["read:runs", "read:deployments", "read:query"];
const CAP_WITHOUT_API_KEYS = [...READS, "write:alerts"];

async function seed(prisma: PrismaClient) {
  db.client = prisma;
  const seeded = await seedTestUserProject(prisma);
  const production = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: `tr_prod_${seeded.project.externalRef}`,
      pkApiKey: `pk_prod_${seeded.project.externalRef}`,
      shortcode: `p${seeded.project.externalRef.slice(-3)}`,
      projectId: seeded.project.id,
      organizationId: seeded.organization.id,
    },
  });
  return { ...seeded, production };
}

function agentToken(
  userId: string,
  environmentId: string,
  organizationId: string,
  cap = CAP_WITHOUT_API_KEYS
) {
  return signUserActorToken(SESSION_SECRET, {
    userId,
    client: "dashboard-agent",
    environmentId,
    organizationId,
    cap,
    expirationTime: Math.floor(Date.now() / 1000) + 600,
  });
}

async function patMintedToken(userId: string) {
  const pat = await createPersonalAccessToken({ name: "ci", userId, expiresInDays: 30 });
  const response: Response = await (userActorTokenAction as any)({
    request: new Request("https://api.example.test/api/v1/auth/user-actor-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cap: CAP_WITHOUT_API_KEYS }),
    }),
    params: {},
    context: {},
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function exchange(bearer: string, projectRef: string, scopes: string[]) {
  const response: Response = await (envJwtAction as any)({
    request: new Request(`https://api.example.test/api/v1/projects/${projectRef}/prod/jwt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ claims: { scopes } }),
    }),
    params: { projectRef, env: "prod" },
    context: {},
  }).catch((thrown: unknown) => {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  });
  return response;
}

function scopesOf(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).scopes;
}

describe("env JWT exchange for a dashboard-agent token without prod API key access", () => {
  // Catches: the agent exchange still gated on read:apiKeys.
  postgresTest("mints the read scopes the user can read", async ({ prisma }) => {
    const { user, organization, project, production } = await seed(prisma);
    const uat = await agentToken(user.id, production.id, organization.id);

    const response = await exchange(uat, project.externalRef, READS);

    expect(response.status).toBe(200);
    expect(scopesOf(((await response.json()) as { token: string }).token)).toEqual(READS);
  });

  // Catches: one denied read scope refusing the whole exchange.
  postgresTest("mints only the read scopes the role allows", async ({ prisma }) => {
    const { user, organization, project, production } = await seed(prisma);
    const uat = await agentToken(user.id, production.id, organization.id);
    const authenticate = rbac.authenticateUserActor.bind(rbac);
    const spy = vi.spyOn(rbac, "authenticateUserActor").mockImplementation(async (...args) => {
      const result = await authenticate(...args);
      return result.ok ? { ...result, ability: buildJwtAbility(["read:runs"]) } : result;
    });

    try {
      const response = await exchange(uat, project.externalRef, ["read:runs", "read:query"]);

      expect(response.status).toBe(200);
      expect(scopesOf(((await response.json()) as { token: string }).token)).toEqual(["read:runs"]);
    } finally {
      spy.mockRestore();
    }
  });

  // Catches: write scopes skipping the API key gate on the agent path.
  postgresTest("refuses a write scope", async ({ prisma }) => {
    const { user, organization, project, production } = await seed(prisma);
    const uat = await agentToken(user.id, production.id, organization.id);

    const response = await exchange(uat, project.externalRef, ["read:runs", "write:alerts"]);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("API keys") });
  });

  // Catches: an empty request expanding to the cap and skipping the API key gate.
  postgresTest("keeps the API key gate when no scopes are requested", async ({ prisma }) => {
    const { user, organization, project, production } = await seed(prisma);
    const uat = await agentToken(user.id, production.id, organization.id, READS);

    const response = await exchange(uat, project.externalRef, []);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("API keys") });
  });

  // Catches: a PAT-minted token taking the agent path and skipping the API key gate.
  postgresTest("keeps the API key gate for a PAT-minted token", async ({ prisma }) => {
    const { user, project } = await seed(prisma);
    const uat = await patMintedToken(user.id);

    const response = await exchange(uat, project.externalRef, READS);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("API keys") });
  });

  // Catches: the agent path skipping the token's organization scope.
  postgresTest("refuses a token for another organization", async ({ prisma }) => {
    const { user, project, production } = await seed(prisma);
    const other = await seedTestUserProject(prisma);
    const uat = await agentToken(user.id, production.id, other.organization.id);

    const response = await exchange(uat, project.externalRef, READS);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("organization") });
  });
});

describe("isDashboardAgentUserActor", () => {
  const agent = {
    userId: "usr_1",
    client: "dashboard-agent",
    environmentId: "env_1",
    organizationId: "org_1",
  };

  // Catches: the agent path keyed on claims a PAT-minted token can carry.
  it.each([
    ["the webapp's agent token", agent, true],
    ["a PAT-minted token labelled as the agent", { ...agent, pat: "pat_1" }, false],
    ["another client", { ...agent, client: "cli" }, false],
    ["no environment claim", { ...agent, environmentId: undefined }, false],
    ["no organization claim", { ...agent, organizationId: undefined }, false],
  ])("%s", (_name, claims, expected) => {
    expect(isDashboardAgentUserActor(claims)).toBe(expected);
  });
});
