import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { BranchTrackingConfigSchema } from "~/v3/github";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { err, fromPromise, ok, ResultAsync } from "neverthrow";
import { BuildSettingsSchema } from "~/v3/buildSettings";

export class ProjectSettingsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  getProjectSettings(organizationSlug: string, projectSlug: string, userId: string) {
    const githubAppEnabled = env.GITHUB_APP_ENABLED === "1";

    const getProject = () =>
      fromPromise(findProjectBySlug(organizationSlug, projectSlug, userId), (error) => ({
        type: "other" as const,
        cause: error,
      }))
        .andThen((project) => {
          if (!project) {
            return err({ type: "project_not_found" as const });
          }
          return ok(project);
        })
        .map((project) => {
          const buildSettingsOrFailure = BuildSettingsSchema.safeParse(project.buildSettings);
          const buildSettings = buildSettingsOrFailure.success
            ? buildSettingsOrFailure.data
            : undefined;
          return { ...project, buildSettings };
        });

    if (!githubAppEnabled) {
      return getProject().map(({ buildSettings }) => ({
        gitHubApp: {
          enabled: false,
          connectedRepository: undefined,
          installations: undefined,
          isPreviewEnvironmentEnabled: undefined,
        },
        buildSettings,
      }));
    }

    const findConnectedGithubRepository = (projectId: string) =>
      fromPromise(
        this.#prismaClient.connectedGithubRepository.findFirst({
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

    const isPreviewEnvironmentEnabled = (projectId: string) =>
      fromPromise(
        prisma.runtimeEnvironment.findFirst({
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

    return getProject().andThen((project) =>
      ResultAsync.combine([
        isPreviewEnvironmentEnabled(project.id),
        findConnectedGithubRepository(project.id),
        listGithubAppInstallations(project.organizationId),
      ]).map(
        ([isPreviewEnvironmentEnabled, connectedGithubRepository, githubAppInstallations]) => ({
          gitHubApp: {
            enabled: true,
            connectedRepository: connectedGithubRepository,
            installations: githubAppInstallations,
            isPreviewEnvironmentEnabled,
          },
          buildSettings: project.buildSettings,
        })
      )
    );
  }
}
