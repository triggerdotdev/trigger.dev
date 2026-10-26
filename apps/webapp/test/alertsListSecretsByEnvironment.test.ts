import { postgresTest } from "@internal/testcontainers";
import { afterAll, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENCRYPTION_KEY = vi.hoisted(() => "0123456789abcdef0123456789abcdef");
const DATABASE_ENV = ["DATABASE_URL", "DIRECT_URL", "DATABASE_READ_REPLICA_URL"] as const;
const previousEnv = DATABASE_ENV.map((key) => [key, process.env[key]] as const);

afterAll(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

vi.mock("~/env.server", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return { ...original, env: { ...original.env, ENCRYPTION_KEY } };
});

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: (_options: unknown, handler: any) => (args: any) =>
    handler({
      ...args,
      user: { id: args.userId },
      ability: {
        can: (action: string, resource: { type: string; envType?: string }) =>
          ["read", "write", "delete"].includes(action) &&
          resource.type === "alerts" &&
          resource.envType !== "PRODUCTION",
      },
    }),
  dashboardAction: () => undefined,
}));
vi.mock("~/v3/canUseAlertsList.server", () => ({ canUseAlertsList: async () => false }));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_dev", type: "DEVELOPMENT" }),
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: async () => {} } }));

postgresTest(
  "alerts page hides a PRODUCTION channel's secret when viewed from DEVELOPMENT",
  async ({ prisma, postgresContainer }) => {
    const url = postgresContainer.getConnectionUri();
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    delete process.env.DATABASE_READ_REPLICA_URL;

    const slug = `s${Math.random().toString(36).slice(2, 10)}`;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    const organization = await prisma.organization.create({
      data: {
        title: slug,
        slug,
        members: { create: { userId: user.id, role: "ADMIN" } },
      },
    });
    const project = await prisma.project.create({
      data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
    });

    const { encryptSecret } = await import("~/services/secrets/secretStore.server");
    for (const [name, environmentTypes] of [
      ["prod-hook", ["PRODUCTION", "DEVELOPMENT"]],
      ["dev-hook", ["DEVELOPMENT"]],
    ] as const) {
      await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `${slug}-${name}`,
          name,
          type: "WEBHOOK",
          properties: {
            type: "WEBHOOK",
            url: "https://example.com/hook",
            secret: await encryptSecret(ENCRYPTION_KEY, `${name}-secret`),
          },
          alertTypes: ["TASK_RUN"],
          environmentTypes: [...environmentTypes],
          deduplicationKey: `${slug}-${name}`,
          projectId: project.id,
        },
      });
    }

    const { loader } =
      await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts/route");
    const response = (await loader({
      request: new Request("http://localhost/alerts"),
      params: { organizationSlug: slug, projectParam: slug, envParam: "dev" },
      context: {},
      userId: user.id,
    } as any)) as any;
    const data = response.data ?? (await response.json());

    expect(data.mode).toBe("legacy");
    const byName = Object.fromEntries(data.alertChannels.map((c: any) => [c.name, c]));
    expect(byName["prod-hook"].properties.secret).toBeUndefined();
    expect(byName["dev-hook"].properties.secret).toBe("dev-hook-secret");
    expect(data.canWrite).toBe(true);
  }
);
