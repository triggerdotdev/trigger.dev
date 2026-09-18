import { postgresTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { resolveDeployNowAuthScope } from "~/services/deployNowAuthScope.server";
import { createTestOrgProjectWithMember } from "./fixtures/environmentVariablesFixtures";

// Regression guard for the deploy-now authorization scope. The RBAC plugin filters roles by
// (organizationId, projectId); if the scope omits projectId, a project-scoped role override is
// ignored and an org-permitted-but-project-restricted user could deploy. The plugin's role
// logic is closed-source, so this pins the scope the route feeds it, not the plugin itself.
describe("resolveDeployNowAuthScope", () => {
  postgresTest("includes both organizationId and projectId", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);

    const scope = await resolveDeployNowAuthScope(
      { organizationSlug: organization.slug, projectParam: project.slug },
      prisma
    );

    expect(scope).toEqual({ organizationId: organization.id, projectId: project.id });
  });

  postgresTest("returns an empty scope when the project can't be resolved", async ({ prisma }) => {
    const scope = await resolveDeployNowAuthScope(
      { organizationSlug: "does-not-exist", projectParam: "does-not-exist" },
      prisma
    );

    expect(scope).toEqual({});
  });
});
