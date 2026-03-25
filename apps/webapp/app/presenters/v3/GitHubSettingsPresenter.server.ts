import { type PrismaClient } from "@trigger.dev/database";
import { err, fromPromise, ok, ResultAsync } from "neverthrow";
import { env } from "~/env.server";
import { BranchTrackingConfigSchema } from "~/v3/github";
import { BasePresenter } from "./basePresenter.server";

type GitHubSettingsOptions = {
  projectId: string;
  organizationId: string;
};

export class GitHubSettingsPresenter extends BasePresenter {
  public call({ projectId, organizationId }: GitHubSettingsOptions) {
    const githubAppEnabled = env.GITHUB_APP_ENABLED === "1";

    if (!githubAppEnabled) {
      return ok({
        enabled: false,
        connectedRepository: undefined,
        installations: undefined,
        isPreviewEnvironmentEnabled: undefined,
      });
    }

    const findConnectedGithubRepository = () =>
      fromPromise(
        (this._replica as PrismaClient).connectedGithubRepository.findFirst({
          where: {
            projectId,
            repository: {
              installation: {
                deletedAt: null,
                suspendedAt: null,
              },
            },
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

    const listGithubAppInstallations = () =>
      fromPromise(
        (this._replica as PrismaClient).githubAppInstallation.findMany({
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

    const isPreviewEnvironmentEnabled = () =>
      fromPromise(
        (this._replica as PrismaClient).runtimeEnvironment.findFirst({
          select: {
            id: true,
          },
          where: {
            projectId: projectId,
            slug: "preview",
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((previewEnvironment) => previewEnvironment !== null);

    return ResultAsync.combine([
      isPreviewEnvironmentEnabled(),
      findConnectedGithubRepository(),
      listGithubAppInstallations(),
    ]).map(([isPreviewEnvironmentEnabled, connectedGithubRepository, githubAppInstallations]) => ({
      enabled: true,
      connectedRepository: connectedGithubRepository,
      installations: githubAppInstallations,
      isPreviewEnvironmentEnabled,
    }));
  }
}
