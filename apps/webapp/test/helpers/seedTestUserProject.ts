import type { PrismaClient } from "@trigger.dev/database";
import { randomBytes } from "node:crypto";
import { seedTestPAT, seedTestUser } from "./seedTestPAT";

function randomHex(len = 12): string {
  return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

// Composite test fixture: a User, an Organization with that user as a
// member, a Project owned by the org, a DEVELOPMENT environment, and a
// non-revoked PAT for the user.
//
// Used by the PAT-comprehensive matrix (TRI-8741) to exercise routes
// like GET /api/v1/projects/:projectRef/runs whose access check is
// `findProjectByRef(externalRef, userId)` — i.e. the project's org
// must have the userId in its members. seedTestEnvironment alone
// doesn't create the OrgMember link, which is why this helper exists.
//
// Caller passes `projectDeleted: true` to test the soft-deleted-
// project path; `userAdmin: true` to confirm the global admin flag
// doesn't add cross-org visibility (the route is per-user).
export async function seedTestUserProject(
  prisma: PrismaClient,
  opts: { userAdmin?: boolean; projectDeleted?: boolean } = {}
) {
  const suffix = randomHex(8);
  const apiKey = `tr_dev_${randomHex(24)}`;
  const pkApiKey = `pk_dev_${randomHex(24)}`;

  const user = await seedTestUser(prisma, { admin: opts.userAdmin ?? false });

  const organization = await prisma.organization.create({
    data: {
      title: `e2e-pat-org-${suffix}`,
      slug: `e2e-pat-org-${suffix}`,
      v3Enabled: true,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });

  const project = await prisma.project.create({
    data: {
      name: `e2e-pat-project-${suffix}`,
      slug: `e2e-pat-proj-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
      engine: "V2",
      deletedAt: opts.projectDeleted ? new Date() : null,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      apiKey,
      pkApiKey,
      shortcode: suffix.slice(0, 4),
      projectId: project.id,
      organizationId: organization.id,
    },
  });

  const pat = await seedTestPAT(prisma, user.id);

  return { user, organization, project, environment, pat };
}
