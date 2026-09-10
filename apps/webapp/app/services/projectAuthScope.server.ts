import { $replica, prisma } from "~/db.server";

export async function resolveProjectAuthScope(
  organizationSlug: string,
  projectSlug: string
): Promise<{ organizationId?: string; projectId?: string }> {
  const where = { slug: projectSlug, organization: { slug: organizationSlug } };
  const select = { id: true, organizationId: true };
  const project =
    (await $replica.project.findFirst({ where, select })) ??
    (await prisma.project.findFirst({ where, select }));

  return project ? { organizationId: project.organizationId, projectId: project.id } : {};
}
