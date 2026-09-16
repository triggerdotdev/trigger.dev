import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestUserProject } from "./helpers/seedTestUserProject";

describe("regenerate API key branch handling", () => {
  it.each(["feature", "", "default"])(
    "rejects a present branch header without rotating the root key (%s)",
    async (branch) => {
      const server = getTestServer();
      const { environment, pat, project } = await seedTestUserProject(server.prisma);

      const response = await server.webapp.fetch(
        `/api/v1/projects/${project.externalRef}/dev/regenerate-api-key`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pat.token}`,
            "x-trigger-branch": branch,
          },
        }
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Branch-scoped key rotation is not supported",
      });
      const persisted = await server.prisma.runtimeEnvironment.findUniqueOrThrow({
        where: { id: environment.id },
        select: { apiKey: true },
      });
      expect(persisted.apiKey).toBe(environment.apiKey);
    }
  );

  it("preserves root key rotation and grace behavior without a branch header", async () => {
    const server = getTestServer();
    const { environment, pat, project } = await seedTestUserProject(server.prisma);

    const response = await server.webapp.fetch(
      `/api/v1/projects/${project.externalRef}/dev/regenerate-api-key`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${pat.token}` },
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { apiKey: string };
    expect(body.apiKey).not.toBe(environment.apiKey);

    const revoked = await server.prisma.revokedApiKey.findFirst({
      where: { apiKey: environment.apiKey, runtimeEnvironmentId: environment.id },
    });
    expect(revoked?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
