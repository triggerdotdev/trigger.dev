import type {
  Organization,
  User,
  Workflow,
  ExternalSource,
} from ".prisma/client";
import { prisma } from "~/db.server";
export type { Workflow } from ".prisma/client";

export type { ExternalSource } from ".prisma/client";

export type WorkflowWithExternalSource = Workflow & {
  externalSource: ExternalSource;
};

export function getWorkflowFromSlugs({
  userId,
  organizationSlug,
  workflowSlug,
}: {
  userId: User["id"];
  organizationSlug: Organization["slug"];
  workflowSlug: Workflow["slug"];
}) {
  return prisma.workflow.findFirst({
    include: {
      externalSource: {
        select: {
          id: true,
          type: true,
          source: true,
          status: true,
          connection: true,
          key: true,
          service: true,
        },
      },
      externalServices: {
        select: {
          id: true,
          type: true,
          status: true,
          connection: true,
          slug: true,
          service: true,
        },
      },
      rules: {
        select: {
          id: true,
          type: true,
          trigger: true,
          environmentId: true,
        },
      },
    },
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
