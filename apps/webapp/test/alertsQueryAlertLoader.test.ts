import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import { encodeQueryParam } from "~/components/alerts/queryAlertLink";
import { applyAlertsMigration } from "./helpers/alertTables";
import { alertEngineTest } from "./helpers/alertEngineRedis";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const test = alertEngineTest.extend<{ app: void }>({
  app: [
    async ({ postgresContainer, prisma, engine: _engine }, use) => {
      const url = postgresContainer.getConnectionUri();
      process.env.DATABASE_URL = url;
      process.env.DIRECT_URL = url;
      delete process.env.DATABASE_READ_REPLICA_URL;
      delete process.env.DASHBOARD_AGENT_DATABASE_URL;
      process.env.DASHBOARD_AGENT_SECRET_KEY = "test-dashboard-agent-secret";
      (globalThis as any).__trigger_singletons = {};
      vi.resetModules();
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      await applyAlertsMigration(prisma);
      await use();
    },
    { auto: true },
  ],
});

async function seed(prisma: PrismaClient) {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: slug,
      slug,
      featureFlags: { alertsEnabled: true },
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: slug.slice(0, 4),
      projectId: project.id,
      organizationId: organization.id,
    },
  });
  return { user, organization, project, environment };
}

type QueryAlert = {
  query: string;
  period: string;
  analysis: { ok: boolean; modes: { mode: string }[]; errors: { message: string }[] };
  names: Record<string, string>;
} | null;

async function loadQueryAlert(prisma: PrismaClient, search: string): Promise<QueryAlert> {
  const seeded = await seed(prisma);
  const { commitSession, getSession } = await import("~/services/sessionStorage.server");
  const session = await getSession();
  session.set("user", { userId: seeded.user.id });
  const cookie = (await commitSession(session)).split(";")[0];
  const { loader } =
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts/route");
  const path = `/orgs/${seeded.organization.slug}/projects/${seeded.project.slug}/env/prod/alerts`;
  const response = (await loader({
    request: new Request(`http://localhost${path}?${search}`, { headers: { Cookie: cookie } }),
    params: {
      organizationSlug: seeded.organization.slug,
      projectParam: seeded.project.slug,
      envParam: "prod",
    },
    context: {},
  } as never)) as unknown as { data: { queryAlert: QueryAlert } };
  return response.data.queryAlert;
}

const ROW_QUERY = "SELECT run_id, completed_at FROM runs WHERE status = 'Failed'";
const FORGED = encodeURIComponent(
  JSON.stringify({
    ok: true,
    modes: [{ mode: "threshold", measures: [{ column: "x" }], absenceAllowed: true }],
  })
);

describe("alerts loader with source=query", () => {
  test("re-analyzes the decoded query and ignores a client-supplied analysis (catches a loader trusting the params)", async ({
    prisma,
  }) => {
    const queryAlert = await loadQueryAlert(
      prisma,
      `create=1&source=query&q=${encodeQueryParam(ROW_QUERY)}&qperiod=1h&analysis=${FORGED}&mode=threshold&measure=x`
    );
    expect(queryAlert?.query).toBe(ROW_QUERY);
    expect(queryAlert?.period).toBe("1h");
    expect(queryAlert?.analysis.ok).toBe(true);
    expect(queryAlert?.analysis.modes.map((m) => m.mode)).toEqual(["match"]);
    expect(queryAlert?.names).toEqual({ "match:": "New runs rows matching the query" });
  });

  test("reports an analyzer error for an unusable query", async ({ prisma }) => {
    const queryAlert = await loadQueryAlert(
      prisma,
      `create=1&source=query&q=${encodeQueryParam("SELEC nope")}&analysis=${FORGED}`
    );
    expect(queryAlert?.analysis.ok).toBe(false);
    expect(queryAlert?.analysis.modes).toEqual([]);
    expect(queryAlert?.analysis.errors.length).toBeGreaterThan(0);
  });

  test("rejects a malformed q", async ({ prisma }) => {
    const queryAlert = await loadQueryAlert(prisma, "create=1&source=query&q=%%%not-base64");
    expect(queryAlert?.query).toBe("");
    expect(queryAlert?.analysis.ok).toBe(false);
    expect(queryAlert?.analysis.errors[0]?.message).toBe(
      "The query is missing or too long to watch."
    );
  });

  test("rejects an oversized q before decoding", async ({ prisma }) => {
    const oversized = encodeQueryParam(
      `SELECT run_id, completed_at FROM runs -- ${"x".repeat(6200)}`
    );
    expect(oversized.length).toBeGreaterThan(8192);
    const queryAlert = await loadQueryAlert(prisma, `create=1&source=query&q=${oversized}`);
    expect(queryAlert?.query).toBe("");
    expect(queryAlert?.analysis.ok).toBe(false);
  });

  test("falls back to 7d for an invalid qperiod", async ({ prisma }) => {
    const queryAlert = await loadQueryAlert(
      prisma,
      `create=1&source=query&q=${encodeQueryParam(ROW_QUERY)}&qperiod=forever`
    );
    expect(queryAlert?.period).toBe("7d");
  });

  test("is not computed without source=query", async ({ prisma }) => {
    expect(await loadQueryAlert(prisma, `create=1&q=${encodeQueryParam(ROW_QUERY)}`)).toBeNull();
  });

  it("falls back to an unusable analysis when the analyzer throws (catches an unguarded analyzer)", async () => {
    const { queryAlertPrefill } =
      await import("~/v3/services/alerts/queryAlerts/queryAlertPrefill.server");
    const queryAlert = queryAlertPrefill(
      new URLSearchParams(`create=1&source=query&q=${encodeQueryParam(ROW_QUERY)}`),
      () => {
        throw new RangeError("Maximum call stack size exceeded");
      }
    );
    expect(queryAlert.query).toBe(ROW_QUERY);
    expect(queryAlert.analysis.ok).toBe(false);
    expect(queryAlert.analysis.modes).toEqual([]);
    expect(queryAlert.analysis.errors.map((e) => e.message)).toEqual([
      "This query can't be used for an alert.",
    ]);
  });
});
