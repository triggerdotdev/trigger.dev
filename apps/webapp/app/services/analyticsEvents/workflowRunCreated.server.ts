import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { analytics } from "../analytics.server";

export class WorkflowRunCreatedEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string): Promise<boolean> {
    const workflowRun = await this.#prismaClient.workflowRun.findUnique({
      where: { id },
      include: {
        workflow: {
          select: {
            id: true,
            organization: {
              select: {
                id: true,
                users: {
                  select: {
                    id: true,
                    organizations: {
                      select: {
                        workflows: {
                          select: {
                            _count: {
                              select: { runs: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!workflowRun) {
      console.error(`WorkflowRun ${id} not found`);
      return false;
    }

    workflowRun.workflow.organization.users.forEach((user) => {
      const runCount = user.organizations.reduce(
        (acc, org) =>
          acc +
          org.workflows.reduce(
            (acc, workflow) => acc + workflow._count.runs,
            0
          ),
        0
      );
      analytics.workflowRun.new({
        workflowRun,
        userId: user.id,
        organizationId: workflowRun.workflow.organization.id,
        workflowId: workflowRun.workflow.id,
        runCount,
      });
    });

    return true;
  }
}
