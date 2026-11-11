// Drives real admin API routes against a real Postgres with ADMIN_API_ENABLED on and off. The
// PAT route authenticates with a real personal access token; only the session lookup for the
// dashboard-session route is substituted.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));
const adminApi = vi.hoisted(() => ({ enabled: true }));

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

vi.mock("~/env.server", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "ADMIN_API_ENABLED") return adminApi.enabled;
        return (target as any)[prop];
      },
    }),
  };
});

vi.mock("~/services/rbac.server", () => ({
  rbac: { isUsingPlugin: async () => false, setTokenRole: async () => ({ ok: true }) },
}));

vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "user_admin", admin: true }),
}));

import { loader as patLoader } from "~/routes/admin.api.v1.orgs.$organizationId.feature-flags";
import { loader as sessionLoader } from "~/routes/admin.api.v2.orgs.$organizationId.feature-flags";
import { createPersonalAccessToken } from "~/services/personalAccessToken.server";

async function seed(prisma: PrismaClient) {
  db.client = prisma;
  const suffix = Math.random().toString(36).slice(2, 10);
  const user = await prisma.user.create({
    data: {
      email: `admin-api-${suffix}@example.com`,
      authenticationMethod: "MAGIC_LINK",
      admin: true,
    },
  });
  const pat = (await createPersonalAccessToken({ name: "admin-api", userId: user.id })) as {
    token: string;
  };
  const org = await prisma.organization.create({
    data: { title: "Admin API org", slug: `admin-api-${suffix}` },
  });
  return { token: pat.token, orgId: org.id };
}

async function statusOf(call: Promise<unknown>) {
  try {
    const result = await call;
    return result instanceof Response ? result.status : 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

function callLoader(loader: unknown, path: string, orgId: string, token?: string) {
  return (loader as any)({
    request: new Request(`https://cloud.example${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    params: { organizationId: orgId },
    context: {},
  });
}

describe("ADMIN_API_ENABLED", () => {
  /** Catches: an admin PAT or an admin's dashboard session still reaching the admin API on an
   * instance that has it turned off. */
  postgresTest(
    "off: admin API routes answer 404 for an admin PAT and a session",
    async ({ prisma }) => {
      const { token, orgId } = await seed(prisma);
      adminApi.enabled = false;

      expect(
        await statusOf(
          callLoader(patLoader, `/admin/api/v1/orgs/${orgId}/feature-flags`, orgId, token)
        )
      ).toBe(404);
      expect(
        await statusOf(
          callLoader(sessionLoader, `/admin/api/v2/orgs/${orgId}/feature-flags`, orgId)
        )
      ).toBe(404);
    }
  );

  /** Catches: the gate refusing the admin API on the instance meant to serve it. */
  postgresTest("on: the same calls succeed", async ({ prisma }) => {
    const { token, orgId } = await seed(prisma);
    adminApi.enabled = true;

    expect(
      await statusOf(
        callLoader(patLoader, `/admin/api/v1/orgs/${orgId}/feature-flags`, orgId, token)
      )
    ).toBe(200);
    expect(
      await statusOf(callLoader(sessionLoader, `/admin/api/v2/orgs/${orgId}/feature-flags`, orgId))
    ).toBe(200);
  });
});
