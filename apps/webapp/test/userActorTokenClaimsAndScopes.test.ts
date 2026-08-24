/**
 * Two seams a delegated user-actor token meets outside the route builder: the PAT-only
 * authentication (which enforces nothing, so it refuses the token outright while still
 * authenticating an ordinary PAT), and the
 * environment JWT exchange (which ceilings the minted scopes by the token's cap and only
 * mints for the environment it was signed for).
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { signUserActorToken } from "@trigger.dev/rbac";
import { expect, it, vi } from "vitest";

const SESSION_SECRET = "test-session-secret-for-user-actor-claims";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-session-secret-for-user-actor-claims",
    ENCRYPTION_KEY: "12345678901234567890123456789012",
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// The RBAC controller is the OSS fallback's behaviour: verify the token, ability from its own cap.
vi.mock("~/services/rbac.server", async () => {
  const { buildJwtAbility, verifyUserActorToken } = await import("@trigger.dev/rbac");
  const bearerOf = (request: Request) =>
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim() ?? "";

  return {
    rbac: {
      authenticateUserActor: async (request: Request, context: any) => {
        const claims = await verifyUserActorToken(
          "test-session-secret-for-user-actor-claims",
          bearerOf(request)
        );
        if (!claims) return { ok: false, status: 401, error: "Invalid user-actor token" };
        return {
          ok: true,
          userId: claims.userId,
          claims,
          subject: {
            type: "userActor",
            userId: claims.userId,
            organizationId: context.organizationId ?? "",
          },
          ability: buildJwtAbility(claims.cap ?? ["read:all"]),
        };
      },
    },
  };
});

const { authenticateApiRequestWithPersonalAccessToken, createPersonalAccessToken } =
  await import("~/services/personalAccessToken.server");
const { action: jwtAction } = await import("~/routes/api.v1.projects.$projectRef.$env.jwt");

const USER_ID = "usr_claims_1";

function token(
  opts: { userId?: string; environmentId?: string; cap?: string[]; client?: string } = {}
) {
  return signUserActorToken(SESSION_SECRET, {
    userId: opts.userId ?? USER_ID,
    client: opts.client ?? "dashboard-agent",
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    ...(opts.cap ? { cap: opts.cap } : {}),
  });
}

function bearer(value: string) {
  return new Request("https://api.trigger.dev/api/v1/whatever", {
    headers: { Authorization: `Bearer ${value}` },
  });
}

it("refuses a user-actor token scoped to an environment", async () => {
  const result = await authenticateApiRequestWithPersonalAccessToken(
    bearer(await token({ environmentId: "env_claimed" }))
  );

  expect(result).toBeUndefined();
});

// The refusal is by token type, not by what the token happens to claim: a PAT-minted token
// carries neither an environment nor, necessarily, a cap, and is refused just the same.
it("refuses a user-actor token that claims nothing", async () => {
  const result = await authenticateApiRequestWithPersonalAccessToken(
    bearer(await token({ client: "cli" }))
  );

  expect(result).toBeUndefined();
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

// The other direction: the refusal is aimed at the token type only, so an ordinary PAT still
// authenticates through the same helper.
postgresTest(
  "authenticates an ordinary personal access token",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const user = await prisma.user.create({
      data: { email: `pat_${suffix()}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    const pat = await createPersonalAccessToken({ name: "claims-test", userId: user.id });

    const result = await authenticateApiRequestWithPersonalAccessToken(bearer(pat.token));

    expect(result?.userId).toBe(user.id);

    // And it is the stored token that authenticates, not the prefix.
    expect(
      await authenticateApiRequestWithPersonalAccessToken(bearer(`tr_pat_${suffix()}`))
    ).toBeUndefined();
  },
  60_000
);

/** An org with one project, a prod and a staging environment, and a member user. */
async function seedProject(prisma: PrismaClient) {
  const slug = `jwt_${suffix()}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });

  const environmentFor = (envSlug: "prod" | "stg") =>
    prisma.runtimeEnvironment.create({
      data: {
        slug: envSlug,
        type: envSlug === "prod" ? "PRODUCTION" : "STAGING",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `${envSlug}${suffix()}`,
      },
    });

  return {
    user,
    organization,
    project,
    prod: await environmentFor("prod"),
    staging: await environmentFor("stg"),
  };
}

async function exchange(opts: {
  projectRef: string;
  env: string;
  token: string;
  scopes?: string[];
}) {
  const request = new Request(
    `https://api.trigger.dev/api/v1/projects/${opts.projectRef}/${opts.env}/jwt`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(opts.scopes ? { claims: { scopes: opts.scopes } } : {}),
    }
  );

  try {
    const response = await jwtAction({
      request,
      params: { projectRef: opts.projectRef, env: opts.env },
      context: {},
    } as any);
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, body: await thrown.json() };
    }
    throw thrown;
  }
}

/** The minted env JWT's payload. Signature verification isn't what's under test here. */
function payloadOf(jwt: string): any {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

postgresTest(
  "the exchange clamps requested scopes to the token's cap",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const seeded = await seedProject(prisma);

    const minted = await exchange({
      projectRef: seeded.project.externalRef,
      env: "prod",
      token: await token({
        userId: seeded.user.id,
        environmentId: seeded.prod.id,
        cap: ["read:runs", "read:apiKeys"],
      }),
      scopes: ["read:runs", "write:runs"],
    });

    expect(minted.status).toBe(200);
    expect(payloadOf(minted.body.token).scopes).toEqual(["read:runs"]);
  },
  60_000
);

postgresTest(
  "the exchange only mints for the claimed environment",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const seeded = await seedProject(prisma);

    const other = await exchange({
      projectRef: seeded.project.externalRef,
      env: "staging",
      token: await token({
        userId: seeded.user.id,
        environmentId: seeded.prod.id,
        cap: ["read:runs", "read:apiKeys"],
      }),
    });

    expect(other.status).toBe(403);
    expect(other.body.token).toBeUndefined();
  },
  60_000
);
