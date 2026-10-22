import { postgresTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const builder = vi.hoisted(() => ({ canWrite: false }));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: (_options: unknown, handler: any) => (args: any) =>
    handler({
      ...args,
      user: { id: args.userId },
      ability: { can: () => builder.canWrite },
    }),
  dashboardAction: () => undefined,
}));

postgresTest(
  "webhook secret is only returned to members who can write alerts",
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
        featureFlags: { alertsEnabled: true },
        members: { create: { userId: user.id, role: "ADMIN" } },
      },
    });
    const project = await prisma.project.create({
      data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
    });

    const { env } = await import("~/env.server");
    const { encryptSecret } = await import("~/services/secrets/secretStore.server");
    await prisma.projectAlertChannel.create({
      data: {
        friendlyId: slug,
        name: "hook",
        type: "WEBHOOK",
        properties: {
          type: "WEBHOOK",
          url: "https://example.com/hook",
          secret: await encryptSecret(env.ENCRYPTION_KEY, "top-secret"),
        },
        alertTypes: ["ERROR_GROUP"],
        environmentTypes: ["PRODUCTION"],
        deduplicationKey: slug,
        projectId: project.id,
      },
    });

    const { loader } =
      await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.channels/route");
    const load = async (canWrite: boolean) => {
      builder.canWrite = canWrite;
      const response = (await loader({
        request: new Request("http://localhost/alerts/channels"),
        params: { organizationSlug: slug, projectParam: slug, envParam: "prod" },
        context: {},
        userId: user.id,
      } as any)) as any;
      return JSON.stringify(response.data ?? (await response.json()));
    };

    expect(await load(false)).not.toContain("top-secret");
    expect(await load(true)).toContain("top-secret");
  }
);
