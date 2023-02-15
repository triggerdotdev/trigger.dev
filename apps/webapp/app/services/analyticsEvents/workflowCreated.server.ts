import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { analytics } from "../analytics.server";

export class WorkflowCreatedEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string): Promise<boolean> {
    const workflow = await this.#prismaClient.workflow.findUnique({
      where: { id },
      include: {
        organization: {
          select: {
            id: true,
            users: {
              select: {
                id: true,
                organizations: {
                  select: {
                    _count: {
                      select: { workflows: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!workflow) {
      console.error(`Workflow ${id} not found`);
      return false;
    }

    analytics.workflow.identify({ workflow });
    workflow.organization.users.forEach((user) => {
      const workflowCount = user.organizations.reduce(
        (acc, org) => acc + org._count.workflows,
        0
      );
      analytics.workflow.new({
        workflow,
        userId: user.id,
        organizationId: workflow.organizationId,
        workflowCount,
      });
    });

    return true;
  }
}
