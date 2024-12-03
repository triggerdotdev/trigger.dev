import {
  DeploymentErrorData,
  ExternalBuildData,
  prepareDeploymentError,
} from "@trigger.dev/core/v3";
import { WorkerDeployment } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { getUsername } from "~/utils/username";

export type ErrorData = {
  name: string;
  message: string;
  stack?: string;
  stderr?: string;
};

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
        organizationId: true,
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
        errorData: true,
        imageReference: true,
        externalBuildData: true,
        projectId: true,
        type: true,
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
        builtAt: true,
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
            sdkVersion: true,
            cliVersion: true,
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

    const externalBuildData = deployment.externalBuildData
      ? ExternalBuildData.safeParse(deployment.externalBuildData)
      : undefined;

    return {
      deployment: {
        id: deployment.id,
        shortCode: deployment.shortCode,
        version: deployment.version,
        status: deployment.status,
        createdAt: deployment.createdAt,
        builtAt: deployment.builtAt,
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
        sdkVersion: deployment.worker?.sdkVersion,
        cliVersion: deployment.worker?.cliVersion,
        imageReference: deployment.imageReference,
        externalBuildData:
          externalBuildData && externalBuildData.success ? externalBuildData.data : undefined,
        projectId: deployment.projectId,
        organizationId: project.organizationId,
        errorData: DeploymentPresenter.prepareErrorData(deployment.errorData),
        isBuilt: !!deployment.builtAt,
        type: deployment.type,
      },
    };
  }

  public static prepareErrorData(errorData: WorkerDeployment["errorData"]): ErrorData | undefined {
    if (!errorData) {
      return;
    }

    const deploymentError = DeploymentErrorData.safeParse(errorData);

    if (!deploymentError.success) {
      return;
    }

    return prepareDeploymentError(deploymentError.data);
  }
}
