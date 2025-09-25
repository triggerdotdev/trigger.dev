import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { BranchTrackingConfigSchema, type BranchTrackingConfig } from "~/v3/github";
import { checkGitHubBranchExists } from "~/services/gitHub.server";
import { errAsync, fromPromise, okAsync, ResultAsync } from "neverthrow";
import { BuildSettings } from "~/v3/buildSettings";

export class ProjectSettingsService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  renameProject(projectId: string, newName: string) {
    return fromPromise(
      this.#prismaClient.project.update({
        where: {
          id: projectId,
        },
        data: {
          name: newName,
        },
      }),
      (error) => ({
        type: "other" as const,
        cause: error,
      })
    );
  }

  deleteProject(projectSlug: string, userId: string) {
    const deleteProjectService = new DeleteProjectService(this.#prismaClient);

    return fromPromise(deleteProjectService.call({ projectSlug, userId }), (error) => ({
      type: "other" as const,
      cause: error,
    }));
  }

  connectGitHubRepo(
    projectId: string,
    organizationId: string,
    repositoryId: string,
    installationId: string
  ) {
    const getRepository = () =>
      fromPromise(
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
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).andThen((repository) => {
        if (!repository) {
          return errAsync({ type: "gh_repository_not_found" as const });
        }
        return okAsync(repository);
      });

    const findExistingConnection = () =>
      fromPromise(
        this.#prismaClient.connectedGithubRepository.findFirst({
          where: {
            projectId: projectId,
          },
        }),
        (error) => ({ type: "other" as const, cause: error })
      );

    const createConnectedRepo = (defaultBranch: string) =>
      fromPromise(
        this.#prismaClient.connectedGithubRepository.create({
          data: {
            projectId: projectId,
            repositoryId: repositoryId,
            branchTracking: {
              prod: { branch: defaultBranch },
              staging: {},
            } satisfies BranchTrackingConfig,
            previewDeploymentsEnabled: true,
          },
        }),
        (error) => ({ type: "other" as const, cause: error })
      );

    return ResultAsync.combine([getRepository(), findExistingConnection()]).andThen(
      ([repository, existingConnection]) => {
        if (existingConnection) {
          return errAsync({ type: "project_already_has_connected_repository" as const });
        }

        return createConnectedRepo(repository.defaultBranch);
      }
    );
  }

  disconnectGitHubRepo(projectId: string) {
    return fromPromise(
      this.#prismaClient.connectedGithubRepository.delete({
        where: {
          projectId: projectId,
        },
      }),
      (error) => ({ type: "other" as const, cause: error })
    );
  }

  updateGitSettings(
    projectId: string,
    productionBranch?: string,
    stagingBranch?: string,
    previewDeploymentsEnabled?: boolean
  ) {
    const getExistingConnectedRepo = () =>
      fromPromise(
        this.#prismaClient.connectedGithubRepository.findFirst({
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
        }),
        (error) => ({ type: "other" as const, cause: error })
      )
        .andThen((connectedRepo) => {
          if (!connectedRepo) {
            return errAsync({ type: "connected_gh_repository_not_found" as const });
          }
          return okAsync(connectedRepo);
        })
        .map((connectedRepo) => {
          const branchTrackingOrFailure = BranchTrackingConfigSchema.safeParse(
            connectedRepo.branchTracking
          );
          const branchTracking = branchTrackingOrFailure.success
            ? branchTrackingOrFailure.data
            : undefined;

          return {
            ...connectedRepo,
            branchTracking,
          };
        });

    const validateProductionBranch = ({
      installationId,
      fullRepoName,
      oldProductionBranch,
    }: {
      installationId: number;
      fullRepoName: string;
      oldProductionBranch?: string;
    }) => {
      if (productionBranch && oldProductionBranch !== productionBranch) {
        return checkGitHubBranchExists(installationId, fullRepoName, productionBranch).andThen(
          (exists) => {
            if (!exists) {
              return errAsync({ type: "production_tracking_branch_not_found" as const });
            }
            return okAsync(productionBranch);
          }
        );
      }

      return okAsync(productionBranch);
    };

    const validateStagingBranch = ({
      installationId,
      fullRepoName,
      oldStagingBranch,
    }: {
      installationId: number;
      fullRepoName: string;
      oldStagingBranch?: string;
    }) => {
      if (stagingBranch && oldStagingBranch !== stagingBranch) {
        return checkGitHubBranchExists(installationId, fullRepoName, stagingBranch).andThen(
          (exists) => {
            if (!exists) {
              return errAsync({ type: "staging_tracking_branch_not_found" as const });
            }
            return okAsync(stagingBranch);
          }
        );
      }

      return okAsync(stagingBranch);
    };

    const updateConnectedRepo = () =>
      fromPromise(
        this.#prismaClient.connectedGithubRepository.update({
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
        }),
        (error) => ({ type: "other" as const, cause: error })
      );

    return getExistingConnectedRepo()
      .andThen((connectedRepo) => {
        const installationId = Number(connectedRepo.repository.installation.appInstallationId);

        return ResultAsync.combine([
          validateProductionBranch({
            installationId,
            fullRepoName: connectedRepo.repository.fullName,
            oldProductionBranch: connectedRepo.branchTracking?.prod?.branch,
          }),
          validateStagingBranch({
            installationId,
            fullRepoName: connectedRepo.repository.fullName,
            oldStagingBranch: connectedRepo.branchTracking?.staging?.branch,
          }),
        ]);
      })
      .andThen(updateConnectedRepo);
  }

  updateBuildSettings(projectId: string, buildSettings: BuildSettings) {
    return fromPromise(
      this.#prismaClient.project.update({
        where: {
          id: projectId,
        },
        data: {
          buildSettings: buildSettings,
        },
      }),
      (error) => ({
        type: "other" as const,
        cause: error,
      })
    );
  }

  verifyProjectMembership(organizationSlug: string, projectSlug: string, userId: string) {
    const findProject = () =>
      fromPromise(
        this.#prismaClient.project.findFirst({
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
        }),
        (error) => ({ type: "other" as const, cause: error })
      );

    return findProject().andThen((project) => {
      if (!project) {
        return errAsync({ type: "user_not_in_project" as const });
      }

      return okAsync({
        projectId: project.id,
        organizationId: project.organizationId,
      });
    });
  }
}
