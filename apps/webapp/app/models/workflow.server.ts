import type { Workflow, Organization } from ".prisma/client";
import slug from "slug";
import { prisma } from "~/db.server";

export async function createFirstWorkflow(
  userId: string,
  organizationId: string
) {
  return await createWorkflow({
    title: "My Workflow",
    organizationId,
  });
}

export function createWorkflow({
  title,
  organizationId,
}: Pick<Workflow, "title"> & {
  organizationId: Organization["id"];
}) {
  const desiredSlug = slug(title);
  return prisma.workflow.create({
    data: {
      title,
      slug: desiredSlug,
      organization: {
        connect: {
          id: organizationId,
        },
      },
    },
  });
}
