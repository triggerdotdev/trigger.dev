import {
  DeploymentErrorData,
  ExternalBuildData,
  prepareDeploymentError,
} from "@trigger.dev/core/v3";
import { RuntimeEnvironment, type WorkerDeployment } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { type User } from "~/models/user.server";
import { getUsername } from "~/utils/username";
import { processGitMetadata } from "./BranchesPresenter.server";

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
    environmentSlug,
    deploymentShortCode,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    environmentSlug: RuntimeEnvironment["slug"];
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

    const environment = await findEnvironmentBySlug(project.id, environmentSlug, userId);
    if (!environment) {
      throw new Error(`Environment not found`);
    }

    const deployment = await this.#prismaClient.workerDeployment.findFirstOrThrow({
      where: {
        projectId: project.id,
        shortCode: deploymentShortCode,
        environmentId: environment.id,
      },
      select: {
        id: true,
        shortCode: true,
        version: true,
        runtime: true,
        runtimeVersion: true,
        errorData: true,
        imageReference: true,
        imagePlatform: true,
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
        startedAt: true,
        installedAt: true,
        canceledAt: true,
        canceledReason: true,
        git: true,
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
                filePath: true,
              },
              orderBy: {
                slug: "asc",
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
        startedAt: deployment.startedAt,
        installedAt: deployment.installedAt,
        builtAt: deployment.builtAt,
        deployedAt: deployment.deployedAt,
        canceledAt: deployment.canceledAt,
        canceledReason: deployment.canceledReason,
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
        runtime: deployment.runtime,
        runtimeVersion: deployment.runtimeVersion,
        imageReference: deployment.imageReference,
        imagePlatform: deployment.imagePlatform,
        externalBuildData:
          externalBuildData && externalBuildData.success ? externalBuildData.data : undefined,
        projectId: deployment.projectId,
        organizationId: project.organizationId,
        errorData: DeploymentPresenter.prepareErrorData(deployment.errorData),
        isBuilt: !!deployment.builtAt,
        type: deployment.type,
        git: processGitMetadata(deployment.git),
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
