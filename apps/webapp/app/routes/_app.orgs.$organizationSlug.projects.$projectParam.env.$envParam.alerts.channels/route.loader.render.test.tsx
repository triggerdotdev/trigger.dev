import { postgresTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

postgresTest(
  "lists every channel of the project regardless of the current environment",
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
    for (const [i, environmentTypes] of [["DEVELOPMENT"], ["PRODUCTION"]].entries()) {
      await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `${slug}_${i}`,
          name: `c${i}`,
          type: "EMAIL",
          properties: { type: "EMAIL", email: "a@example.com" },
          alertTypes: ["ERROR_GROUP"],
          environmentTypes: environmentTypes as never,
          deduplicationKey: `${slug}_${i}`,
          projectId: project.id,
        },
      });
    }

    const { commitSession, getSession } = await import("~/services/sessionStorage.server");
    const session = await getSession();
    session.set("user", { userId: user.id });
    const cookie = (await commitSession(session)).split(";")[0];

    const { loader } = await import("./route");
    const response = (await loader({
      request: new Request("http://localhost/alerts/channels", { headers: { Cookie: cookie } }),
      params: { organizationSlug: slug, projectParam: slug, envParam: "dev" },
      context: {},
    } as any)) as any;
    const data = response.data ?? (await response.json());

    expect(data.alertChannels.map((c: { name: string }) => c.name).sort()).toEqual(["c0", "c1"]);
  }
);
