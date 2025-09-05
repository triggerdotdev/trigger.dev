import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { BranchTrackingConfigSchema, type BranchTrackingConfig } from "~/v3/github";
import { checkGitHubBranchExists } from "~/services/gitHub.server";
import { tryCatch } from "@trigger.dev/core/utils";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";

export class ProjectSettingsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async getProjectSettings(organizationSlug: string, projectSlug: string, userId: string) {
    const githubAppEnabled = env.GITHUB_APP_ENABLED === "1";

    if (!githubAppEnabled) {
      return {
        gitHubApp: {
          enabled: false,
          connectedRepository: undefined,
          installations: undefined,
        },
      };
    }

    const project = await findProjectBySlug(organizationSlug, projectSlug, userId);
    if (!project) {
      throw new Error("Project not found");
    }
    const connectedGithubRepository = await prisma.connectedGithubRepository.findFirst({
      where: {
        projectId: project.id,
      },
      select: {
        branchTracking: true,
        previewDeploymentsEnabled: true,
        createdAt: true,
        repository: {
          select: {
            id: true,
            name: true,
            fullName: true,
            htmlUrl: true,
            private: true,
          },
        },
      },
    });

    if (connectedGithubRepository) {
      const branchTrackingOrFailure = BranchTrackingConfigSchema.safeParse(
        connectedGithubRepository.branchTracking
      );

      return {
        gitHubApp: {
          enabled: true,
          connectedRepository: {
            ...connectedGithubRepository,
            branchTracking: branchTrackingOrFailure.success
              ? branchTrackingOrFailure.data
              : undefined,
          },
          // skip loading installations if there is a connected repository
          // a project can have only a single connected repository
          installations: undefined,
        },
      };
    }

    const githubAppInstallations = await prisma.githubAppInstallation.findMany({
      where: {
        organizationId: project.organizationId,
        deletedAt: null,
        suspendedAt: null,
      },
      select: {
        id: true,
        accountHandle: true,
        targetType: true,
        appInstallationId: true,
        repositories: {
          select: {
            id: true,
            name: true,
            fullName: true,
            htmlUrl: true,
            private: true,
          },
          // Most installations will only have a couple of repos so loading them here should be fine.
          // However, there might be outlier organizations so it's best to expose the installation repos
          // via a resource endpoint and filter on user input.
          take: 200,
        },
      },
      take: 20,
      orderBy: {
        createdAt: "desc",
      },
    });

    return {
      gitHubApp: {
        enabled: true,
        connectedRepository: undefined,
        installations: githubAppInstallations,
      },
    };
  }
}
