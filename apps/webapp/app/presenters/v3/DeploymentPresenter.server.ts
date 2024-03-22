import { WorkerDeployment, WorkerDeploymentStatus } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { getUsername } from "~/utils/username";

export class DeploymentPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    deploymentShortCode,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    deploymentShortCode: WorkerDeployment["shortCode"];
  }) {
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
      },
      where: {
        slug: projectSlug,
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    const deployment = await this.#prismaClient.workerDeployment.findUniqueOrThrow({
      where: {
        projectId_shortCode: {
          projectId: project.id,
          shortCode: deploymentShortCode,
        },
      },
      select: {
        id: true,
        shortCode: true,
        version: true,
        environment: {
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
        status: true,
        deployedAt: true,
        createdAt: true,
        promotions: {
          select: {
            label: true,
          },
        },
        worker: {
          select: {
            tasks: {
              select: {
                slug: true,
                exportName: true,
                filePath: true,
              },
              orderBy: {
                exportName: "asc",
              },
            },
          },
        },
        triggeredBy: {
          select: {
            id: true,
            name: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });

    return {
      deployment: {
        id: deployment.id,
        shortCode: deployment.shortCode,
        version: deployment.version,
        status: deployment.status,
        createdAt: deployment.createdAt,
        deployedAt: deployment.deployedAt,
        tasks: deployment.worker?.tasks,
        label: deployment.promotions?.[0]?.label,
        environment: {
          id: deployment.environment.id,
          type: deployment.environment.type,
          slug: deployment.environment.slug,
          userId: deployment.environment.orgMember?.user.id,
          userName: getUsername(deployment.environment.orgMember?.user),
        },
        deployedBy: deployment.triggeredBy,
      },
    };
  }
}
