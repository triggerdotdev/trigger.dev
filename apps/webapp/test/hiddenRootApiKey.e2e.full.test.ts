import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestSession } from "./helpers/seedTestSession";
import { seedTestUserProject } from "./helpers/seedTestUserProject";

const API_KEYS_ROUTE_ID =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys";

async function seedHiddenRootApiKeyProject() {
  const server = getTestServer();
  const seeded = await seedTestUserProject(server.prisma);
  const hiddenAt = new Date();
  await server.prisma.runtimeEnvironment.update({
    where: { id: seeded.environment.id },
    data: { rootApiKeyHiddenAt: hiddenAt },
  });
  const cookie = await seedTestSession({ userId: seeded.user.id });

  return { server, ...seeded, hiddenAt, cookie };
}

function apiKeysPageData({
  organization,
  project,
}: {
  organization: { slug: string };
  project: { slug: string };
}) {
  return `/orgs/${organization.slug}/projects/${project.slug}/env/dev/apikeys?_data=${encodeURIComponent(API_KEYS_ROUTE_ID)}`;
}

describe("hidden root API keys on the dashboard", () => {
  it("returns a hidden root key masked to its last four characters only", async () => {
    const { server, environment, organization, project, cookie } =
      await seedHiddenRootApiKeyProject();

    const response = await server.webapp.fetch(apiKeysPageData({ organization, project }), {
      headers: { Cookie: cookie },
      redirect: "manual",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`tr_dev_••••••••${environment.apiKey.slice(-4)}`);
    expect(body).not.toContain(environment.apiKey);
    expect(body).not.toContain(environment.apiKey.slice("tr_dev_".length, -4));
  });

  it("returns a visible root key in full", async () => {
    const server = getTestServer();
    const { environment, organization, project, user } = await seedTestUserProject(server.prisma);
    const cookie = await seedTestSession({ userId: user.id });

    const response = await server.webapp.fetch(apiKeysPageData({ organization, project }), {
      headers: { Cookie: cookie },
      redirect: "manual",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(environment.apiKey);
  });

  it("rotates a hidden root key without returning the new key", async () => {
    const { server, environment, organization, project, hiddenAt, cookie } =
      await seedHiddenRootApiKeyProject();

    const response = await server.webapp.fetch(
      `/resources/environments/${environment.id}/regenerate-api-key`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ previousKey: "revoke", rootApiKeyHidden: "true" }).toString(),
        redirect: "manual",
      }
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    const stored = await server.prisma.runtimeEnvironment.findUniqueOrThrow({
      where: { id: environment.id },
      select: { apiKey: true, rootApiKeyHiddenAt: true },
    });
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(stored.apiKey).not.toBe(environment.apiKey);
    expect(stored.rootApiKeyHiddenAt).toEqual(hiddenAt);
    expect(body).not.toContain(stored.apiKey);
    expect(response.headers.get("set-cookie") ?? "").not.toContain(stored.apiKey);
    await expect(
      server.prisma.revokedApiKey.count({ where: { runtimeEnvironmentId: environment.id } })
    ).resolves.toBe(0);

    const pageResponse = await server.webapp.fetch(apiKeysPageData({ organization, project }), {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    const pageBody = await pageResponse.text();
    expect(pageBody).toContain(`tr_dev_••••••••${stored.apiKey.slice(-4)}`);
    expect(pageBody).not.toContain(stored.apiKey);
  });

  it("does not rotate a hidden root key from a regenerate form that expected a visible key", async () => {
    const { server, environment, cookie } = await seedHiddenRootApiKeyProject();

    const response = await server.webapp.fetch(
      `/resources/environments/${environment.id}/regenerate-api-key`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ previousKey: "revoke" }).toString(),
        redirect: "manual",
      }
    );

    expect(await response.json()).toEqual({ ok: false });
    const stored = await server.prisma.runtimeEnvironment.findUniqueOrThrow({
      where: { id: environment.id },
      select: { apiKey: true },
    });
    expect(stored.apiKey).toBe(environment.apiKey);
  });
});
