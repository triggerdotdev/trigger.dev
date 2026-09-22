import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";

// Scope carries projectId (not just org) so the RBAC plugin honors project-scoped role overrides.
export async function resolveDeployNowAuthScope(
  params: { organizationSlug: string; projectParam: string },
  prismaClient: PrismaClient = prisma
): Promise<{ organizationId?: string; projectId?: string }> {
  const project = await prismaClient.project.findFirst({
    where: {
      slug: params.projectParam,
      organization: { slug: params.organizationSlug },
    },
    select: { id: true, organizationId: true },
  });
  return project ? { organizationId: project.organizationId, projectId: project.id } : {};
}
