import { type PrismaClient } from "@trigger.dev/database";
import { fromPromise, ok, ResultAsync } from "neverthrow";
import { env } from "~/env.server";
import { BranchTrackingConfigSchema, BuildFiltersSchema } from "~/v3/github";
import { ignorePathLimits } from "~/v3/github/ignorePathLimits.server";
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
        isStagingEnvironmentEnabled: undefined,
        isVercelIntegrationConnected: undefined,
        ignorePathLimits: ignorePathLimits(),
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
            buildFilters: true,
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
        const buildFiltersOrFailure = BuildFiltersSchema.safeParse(
          connectedGithubRepository.buildFilters
        );

        return {
          ...connectedGithubRepository,
          branchTracking,
          buildFilters: buildFiltersOrFailure.success ? buildFiltersOrFailure.data : undefined,
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
            type: "PREVIEW",
            parentEnvironmentId: null,
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((previewEnvironment) => previewEnvironment !== null);

    const isStagingEnvironmentEnabled = () =>
      fromPromise(
        (this._replica as PrismaClient).runtimeEnvironment.findFirst({
          select: {
            id: true,
          },
          where: {
            projectId: projectId,
            type: "STAGING",
            parentEnvironmentId: null,
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((stagingEnvironment) => stagingEnvironment !== null);

    const isVercelIntegrationConnected = () =>
      fromPromise(
        (this._replica as PrismaClient).organizationProjectIntegration.findFirst({
          select: {
            id: true,
          },
          where: {
            projectId,
            deletedAt: null,
            organizationIntegration: {
              service: "VERCEL",
              deletedAt: null,
            },
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((vercelIntegration) => vercelIntegration !== null);

    return ResultAsync.combine([
      isPreviewEnvironmentEnabled(),
      isStagingEnvironmentEnabled(),
      findConnectedGithubRepository(),
      listGithubAppInstallations(),
      isVercelIntegrationConnected(),
    ]).map(
      ([
        isPreviewEnvironmentEnabled,
        isStagingEnvironmentEnabled,
        connectedGithubRepository,
        githubAppInstallations,
        isVercelIntegrationConnected,
      ]) => ({
        enabled: true,
        connectedRepository: connectedGithubRepository,
        installations: githubAppInstallations,
        isPreviewEnvironmentEnabled,
        isStagingEnvironmentEnabled,
        isVercelIntegrationConnected,
        ignorePathLimits: ignorePathLimits(),
      })
    );
  }
}
