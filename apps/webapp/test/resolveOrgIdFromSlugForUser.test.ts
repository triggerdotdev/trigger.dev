import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { resolveOrgIdFromSlug, resolveOrgIdFromSlugForUser } from "~/models/organization.server";
import {
  createTestOrgProjectWithMember,
  createTestUser,
} from "./fixtures/environmentVariablesFixtures";

// The org settings routes resolve their org through this helper, so a non-member resolving to null
// is what makes the dashboard route builder fail closed. ability.can is not a tenant floor (the RBAC
// plugin and the OSS fallback both return a permissive ability for a non-member), so without the
// membership filter a non-member reached those routes for any org whose slug they knew: a live
// cross-tenant read of SSO/directory-sync config and an open set-role gate, confirmed on test-cloud.
describe("resolveOrgIdFromSlugForUser", () => {
  postgresTest("resolves an org the user is a member of", async ({ prisma }) => {
    const { user, organization } = await createTestOrgProjectWithMember(prisma);

    const resolved = await resolveOrgIdFromSlugForUser(organization.slug, user.id, prisma, prisma);

    expect(resolved).toBe(organization.id);
  });

  postgresTest("returns null for a non-member, the tenant floor", async ({ prisma }) => {
    const { organization: target } = await createTestOrgProjectWithMember(prisma);
    const outsider = await createTestUser(prisma);

    const resolved = await resolveOrgIdFromSlugForUser(target.slug, outsider.id, prisma, prisma);

    // The unscoped resolver still hands the same non-member the org id: this is the exact gap the
    // membership filter closes, and why scoping by slug alone was the hole.
    const unscoped = await resolveOrgIdFromSlug(target.slug, prisma, prisma);
    expect(unscoped).toBe(target.id);
    expect(resolved).toBeNull();
  });
});
