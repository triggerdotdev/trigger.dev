import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { BranchTrackingConfigSchema } from "~/v3/github";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { err, fromPromise, ok, okAsync } from "neverthrow";

export class ProjectSettingsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  getProjectSettings(organizationSlug: string, projectSlug: string, userId: string) {
    const githubAppEnabled = env.GITHUB_APP_ENABLED === "1";

    if (!githubAppEnabled) {
      return okAsync({
        gitHubApp: {
          enabled: false,
          connectedRepository: undefined,
          installations: undefined,
        },
      });
    }

    const getProject = () =>
      fromPromise(findProjectBySlug(organizationSlug, projectSlug, userId), (error) => ({
        type: "other" as const,
        cause: error,
      })).andThen((project) => {
        if (!project) {
          return err({ type: "project_not_found" as const });
        }
        return ok(project);
      });

    const findConnectedGithubRepository = (projectId: string) =>
      fromPromise(
        this.#prismaClient.connectedGithubRepository.findFirst({
          where: {
            projectId,
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
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((connectedGithubRepository) => {
        if (!connectedGithubRepository) {
          return undefined;
        }

        const branchTrackingOrFailure = BranchTrackingConfigSchema.safeParse(
          connectedGithubRepository.branchTracking
        );
        const branchTracking = branchTrackingOrFailure.success
          ? branchTrackingOrFailure.data
          : undefined;

        return {
          ...connectedGithubRepository,
          branchTracking,
        };
      });

    const listGithubAppInstallations = (organizationId: string) =>
      fromPromise(
        this.#prismaClient.githubAppInstallation.findMany({
          where: {
            organizationId,
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
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      );

    return getProject().andThen((project) =>
      findConnectedGithubRepository(project.id).andThen((connectedGithubRepository) => {
        if (connectedGithubRepository) {
          return okAsync({
            gitHubApp: {
              enabled: true,
              connectedRepository: connectedGithubRepository,
              // skip loading installations if there is a connected repository
              // a project can have only a single connected repository
              installations: undefined,
            },
          });
        }

        return listGithubAppInstallations(project.organizationId).map((githubAppInstallations) => {
          return {
            gitHubApp: {
              enabled: true,
              connectedRepository: undefined,
              installations: githubAppInstallations,
            },
          };
        });
      })
    );
  }
}
