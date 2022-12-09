import type { Organization, User, Workflow } from ".prisma/client";
import { prisma } from "~/db.server";
export type { Workflow } from ".prisma/client";

export function getWorkflowFromSlugs({
  userId,
  organizationSlug,
  workflowSlug,
}: {
  userId: User["id"];
  organizationSlug: Organization["slug"];
  workflowSlug: Workflow["slug"];
}): Promise<Workflow | null> {
  return prisma.workflow.findFirst({
    where: {
      slug: workflowSlug,
      organization: {
        slug: organizationSlug,
        users: {
          some: {
            id: userId,
          },
        },
      },
    },
  });
}
