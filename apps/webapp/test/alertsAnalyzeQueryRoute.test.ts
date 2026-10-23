import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";
import type * as DbServer from "~/db.server";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({
  prisma: undefined as unknown as Record<string | symbol, unknown>,
  userId: "",
}));

vi.mock("~/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof DbServer>();
  const prisma = new Proxy({}, { get: (_target, prop) => holder.prisma[prop] });
  return { ...actual, prisma, $replica: prisma };
});
vi.mock("~/services/session.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserId: async () => holder.userId || undefined,
}));

async function setup(
  prisma: PrismaClient,
  suffix: string,
  featureFlags: Record<string, unknown> = { alertsEnabled: true }
) {
  holder.prisma = prisma as unknown as Record<string | symbol, unknown>;
  const user = await prisma.user.create({
    data: { email: `analyze-query-${suffix}@example.test`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      slug: `analyze-query-${suffix}`,
      title: `Analyze query ${suffix}`,
      featureFlags: featureFlags as never,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: {
      slug: `analyze-query-${suffix}`,
      name: `Analyze query ${suffix}`,
      externalRef: `analyze-query-${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `analyze-query-${suffix}`,
      type: "PRODUCTION",
      organizationId: organization.id,
      projectId: project.id,
      apiKey: `tr_analyze_query_${suffix}`,
      pkApiKey: `pk_analyze_query_${suffix}`,
      shortcode: `analyze-query-${suffix}`,
    },
  });
  holder.userId = user.id;
  return {
    organizationSlug: organization.slug,
    projectParam: project.slug,
    envParam: environment.slug,
  };
}

async function call(params: Record<string, string>, body: unknown) {
  const { action } =
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.analyze-query");
  return action({
    request: new Request("http://localhost/alerts/analyze-query", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    params,
    context: {},
  } as never).catch((thrown) => thrown as Response);
}

async function analyze(params: Record<string, string>, query: string) {
  const response = await call(params, { query });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

postgresTest(
  "returns the analysis and suggested names for a watchable query",
  async ({ prisma }) => {
    const params = await setup(prisma, "ok");

    const body = await analyze(params, "SELECT count() AS total FROM runs");

    expect(body.analysis).toMatchObject({ ok: true });
    expect(body.analysis.modes.map((m: { mode: string }) => m.mode)).toEqual(["threshold"]);
    expect(body.names["threshold:total"]).toEqual(expect.any(String));
  }
);

postgresTest(
  "a LIMIT query is unsupported, with the analyzer message and no modes",
  async ({ prisma }) => {
    const params = await setup(prisma, "limit");

    const body = await analyze(params, "SELECT run_id, completed_at FROM runs LIMIT 10");

    expect(body.analysis.ok).toBe(false);
    expect(body.analysis.modes).toEqual([]);
    expect(body.analysis.errors.map((e: { code: string }) => e.code)).toContain("limit");
    expect(body.names).toEqual({});
  }
);

postgresTest("403 when alerts are not enabled for the org", async ({ prisma }) => {
  const params = await setup(prisma, "off", { alertsEnabled: false });

  const response = await call(params, { query: "SELECT count() AS total FROM runs" });

  expect(response.status).toBe(403);
});

postgresTest("a user outside the organization is denied", async ({ prisma }) => {
  const params = await setup(prisma, "perm");
  const outsider = await prisma.user.create({
    data: { email: "analyze-query-outsider@example.test", authenticationMethod: "MAGIC_LINK" },
  });
  holder.userId = outsider.id;

  const response = await call(params, { query: "SELECT count() AS total FROM runs" });

  expect([302, 403, 404]).toContain(response.status);
});

postgresTest("400 on a missing or too long query", async ({ prisma }) => {
  const params = await setup(prisma, "bad");

  expect((await call(params, {})).status).toBe(400);
  expect((await call(params, { query: `SELECT ${"a".repeat(8200)}` })).status).toBe(400);
});
