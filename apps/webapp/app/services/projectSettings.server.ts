import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { BranchTrackingConfigSchema, type BranchTrackingConfig } from "~/v3/github";
import { checkGitHubBranchExists } from "~/services/gitHub.server";
import { tryCatch } from "@trigger.dev/core/utils";

export class ProjectSettingsService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async renameProject(projectId: string, newName: string) {
    const updatedProject = await this.#prismaClient.project.update({
      where: {
        id: projectId,
      },
      data: {
        name: newName,
      },
    });

    return updatedProject;
  }

  async deleteProject(projectSlug: string, userId: string) {
    const deleteProjectService = new DeleteProjectService(this.#prismaClient);
    await deleteProjectService.call({ projectSlug, userId });
  }

  async connectGitHubRepo(
    projectId: string,
    organizationId: string,
    repositoryId: string,
    installationId: string
  ) {
    const [repository, existingConnection] = await Promise.all([
      this.#prismaClient.githubRepository.findFirst({
        where: {
          id: repositoryId,
          installationId,
          installation: {
            organizationId: organizationId,
          },
        },
        select: {
          id: true,
          name: true,
          defaultBranch: true,
        },
      }),
      this.#prismaClient.connectedGithubRepository.findFirst({
        where: {
          projectId: projectId,
        },
      }),
    ]);

    if (!repository) {
      throw new Error("Repository not found");
    }

    if (existingConnection) {
      throw new Error("Project is already connected to a repository");
    }

    const connectedRepo = await this.#prismaClient.connectedGithubRepository.create({
      data: {
        projectId: projectId,
        repositoryId: repositoryId,
        branchTracking: {
          prod: { branch: repository.defaultBranch },
          staging: { branch: repository.defaultBranch },
        } satisfies BranchTrackingConfig,
        previewDeploymentsEnabled: true,
      },
    });

    return connectedRepo;
  }

  async disconnectGitHubRepo(projectId: string) {
    await this.#prismaClient.connectedGithubRepository.delete({
      where: {
        projectId: projectId,
      },
    });
  }

  async updateGitSettings(
    projectId: string,
    productionBranch?: string,
    stagingBranch?: string,
    previewDeploymentsEnabled?: boolean
  ) {
    const existingConnection = await this.#prismaClient.connectedGithubRepository.findFirst({
      where: {
        projectId: projectId,
      },
      include: {
        repository: {
          include: {
            installation: true,
          },
        },
      },
    });

    if (!existingConnection) {
      throw new Error("No connected GitHub repository found");
    }

    const [owner, repo] = existingConnection.repository.fullName.split("/");
    const installationId = Number(existingConnection.repository.installation.appInstallationId);

    const existingBranchTracking = BranchTrackingConfigSchema.safeParse(
      existingConnection.branchTracking
    );

    const [error, branchValidationsOrFail] = await tryCatch(
      Promise.all([
        productionBranch && existingBranchTracking.data?.prod?.branch !== productionBranch
          ? checkGitHubBranchExists(installationId, owner, repo, productionBranch)
          : Promise.resolve(true),
        stagingBranch && existingBranchTracking.data?.staging?.branch !== stagingBranch
          ? checkGitHubBranchExists(installationId, owner, repo, stagingBranch)
          : Promise.resolve(true),
      ])
    );

    if (error) {
      throw new Error("Failed to validate tracking branches");
    }

    const [productionBranchExists, stagingBranchExists] = branchValidationsOrFail;

    if (productionBranch && !productionBranchExists) {
      throw new Error(
        `Production tracking branch '${productionBranch}' does not exist in the repository`
      );
    }

    if (stagingBranch && !stagingBranchExists) {
      throw new Error(
        `Staging tracking branch '${stagingBranch}' does not exist in the repository`
      );
    }

    const updatedConnection = await this.#prismaClient.connectedGithubRepository.update({
      where: {
        projectId: projectId,
      },
      data: {
        branchTracking: {
          prod: productionBranch ? { branch: productionBranch } : {},
          staging: stagingBranch ? { branch: stagingBranch } : {},
        } satisfies BranchTrackingConfig,
        previewDeploymentsEnabled: previewDeploymentsEnabled,
      },
    });

    return updatedConnection;
  }

  async verifyProjectMembership(projectSlug: string, organizationSlug: string, userId: string) {
    const project = await this.#prismaClient.project.findFirst({
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
      select: {
        id: true,
        organizationId: true,
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    return project;
  }
}
