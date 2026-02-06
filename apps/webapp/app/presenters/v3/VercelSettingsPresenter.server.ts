import { type PrismaClient } from "@trigger.dev/database";
import { type Result, fromPromise, ok, okAsync, ResultAsync } from "neverthrow";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import {
  VercelIntegrationRepository,
  VercelCustomEnvironment,
  VercelEnvironmentVariable,
} from "~/models/vercelIntegration.server";
import { type GitHubAppInstallation } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  VercelProjectIntegrationDataSchema,
  VercelProjectIntegrationData,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { BasePresenter } from "./basePresenter.server";

type VercelSettingsOptions = {
  projectId: string;
  organizationId: string;
};

export type VercelSettingsResult = {
  enabled: boolean;
  hasOrgIntegration: boolean;
  authInvalid?: boolean;
  connectedProject?: {
    id: string;
    vercelProjectId: string;
    vercelProjectName: string;
    vercelTeamId: string | null;
    integrationData: VercelProjectIntegrationData;
    createdAt: Date;
  };
  isGitHubConnected: boolean;
  hasStagingEnvironment: boolean;
  hasPreviewEnvironment: boolean;
  customEnvironments: VercelCustomEnvironment[];
  /** Whether autoAssignCustomDomains is enabled on the Vercel project. null if unknown. */
  autoAssignCustomDomains?: boolean | null;
};

export type VercelAvailableProject = {
  id: string;
  name: string;
};

export type VercelOnboardingData = {
  customEnvironments: VercelCustomEnvironment[];
  environmentVariables: VercelEnvironmentVariable[];
  availableProjects: VercelAvailableProject[];
  hasProjectSelected: boolean;
  authInvalid?: boolean;
  existingVariables: Record<string, { environments: string[] }>; // Environment slugs (non-archived only)
  gitHubAppInstallations: GitHubAppInstallation[];
  isGitHubConnected: boolean;
  isOnboardingComplete: boolean;
};

export class VercelSettingsPresenter extends BasePresenter {
  /**
   * Get Vercel integration settings for the settings page
   */
  public async call({ projectId, organizationId }: VercelSettingsOptions): Promise<Result<VercelSettingsResult, unknown>> {
    const vercelIntegrationEnabled = OrgIntegrationRepository.isVercelSupported;

    if (!vercelIntegrationEnabled) {
      return ok({
        enabled: false,
        hasOrgIntegration: false,
        authInvalid: false,
        connectedProject: undefined,
        isGitHubConnected: false,
        hasStagingEnvironment: false,
        hasPreviewEnvironment: false,
        customEnvironments: [],
      } as VercelSettingsResult);
    }

    const orgIntegrationResult = await fromPromise(
      (this._replica as PrismaClient).organizationIntegration.findFirst({
        where: {
          organizationId,
          service: "VERCEL",
          deletedAt: null,
        },
        include: {
          tokenReference: true,
        },
      }),
      (error) => error
    );

    if (orgIntegrationResult.isErr()) {
      logger.error("Unexpected error in VercelSettingsPresenter.call", { error: orgIntegrationResult.error });
      return ok({
        enabled: true,
        hasOrgIntegration: false,
        authInvalid: true,
        connectedProject: undefined,
        isGitHubConnected: false,
        hasStagingEnvironment: false,
        hasPreviewEnvironment: false,
        customEnvironments: [],
      } as VercelSettingsResult);
    }

    const orgIntegration = orgIntegrationResult.value;
    const hasOrgIntegration = orgIntegration !== null;

    if (hasOrgIntegration) {
      const tokenResult = await VercelIntegrationRepository.validateVercelToken(orgIntegration);
      if (tokenResult.isErr() || !tokenResult.value.isValid) {
        return ok({
          enabled: true,
          hasOrgIntegration: true,
          authInvalid: true,
          connectedProject: undefined,
          isGitHubConnected: false,
          hasStagingEnvironment: false,
          hasPreviewEnvironment: false,
          customEnvironments: [],
        } as VercelSettingsResult);
      }
    }

    const checkOrgIntegration = () => fromPromise(
      Promise.resolve(hasOrgIntegration),
      (error) => ({
        type: "other" as const,
        cause: error,
      })
    );

    const checkGitHubConnection = () =>
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
            id: true,
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((repo) => repo !== null);

    const checkStagingEnvironment = () =>
      fromPromise(
        (this._replica as PrismaClient).runtimeEnvironment.findFirst({
          select: {
            id: true,
          },
          where: {
            projectId,
            type: "STAGING",
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((env) => env !== null);

    const checkPreviewEnvironment = () =>
      fromPromise(
        (this._replica as PrismaClient).runtimeEnvironment.findFirst({
          select: {
            id: true,
          },
          where: {
            projectId,
            type: "PREVIEW",
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((env) => env !== null);

    const getVercelProjectIntegration = () =>
      fromPromise(
        (this._replica as PrismaClient).organizationProjectIntegration.findFirst({
          where: {
            projectId,
            deletedAt: null,
            organizationIntegration: {
              service: "VERCEL",
              deletedAt: null,
            },
          },
          include: {
            organizationIntegration: true,
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((integration) => {
        if (!integration) {
          return undefined;
        }

        const parsedData = VercelProjectIntegrationDataSchema.safeParse(
          integration.integrationData
        );

        if (!parsedData.success) {
          return undefined;
        }

        return {
          id: integration.id,
          vercelProjectId: integration.externalEntityId,
          vercelProjectName: parsedData.data.vercelProjectName,
          vercelTeamId: parsedData.data.vercelTeamId,
          integrationData: parsedData.data,
          createdAt: integration.createdAt,
        };
      });

    return ResultAsync.combine([
      checkOrgIntegration(),
      checkGitHubConnection(),
      checkStagingEnvironment(),
      checkPreviewEnvironment(),
      getVercelProjectIntegration(),
    ]).andThen(([hasOrgIntegration, isGitHubConnected, hasStagingEnvironment, hasPreviewEnvironment, connectedProject]) => {
        const fetchCustomEnvsAndProjectSettings = async (): Promise<{
          customEnvironments: VercelCustomEnvironment[];
          autoAssignCustomDomains: boolean | null;
        }> => {
          if (!connectedProject || !orgIntegration) {
            return { customEnvironments: [], autoAssignCustomDomains: null };
          }
          const clientResult = await VercelIntegrationRepository.getVercelClient(orgIntegration);
          if (clientResult.isErr()) {
            return { customEnvironments: [], autoAssignCustomDomains: null };
          }
          const client = clientResult.value;
          const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);
          const [customEnvsResult, autoAssignResult] = await Promise.all([
            VercelIntegrationRepository.getVercelCustomEnvironments(
              client,
              connectedProject.vercelProjectId,
              teamId
            ),
            VercelIntegrationRepository.getAutoAssignCustomDomains(
              client,
              connectedProject.vercelProjectId,
              teamId
            ),
          ]);
          return {
            customEnvironments: customEnvsResult.isOk() ? customEnvsResult.value : [],
            autoAssignCustomDomains: autoAssignResult.isOk() ? autoAssignResult.value : null,
          };
        };

        return fromPromise(
          fetchCustomEnvsAndProjectSettings(),
          (error) => ({ type: "other" as const, cause: error })
        ).map(({ customEnvironments, autoAssignCustomDomains }) => ({
          enabled: true,
          hasOrgIntegration,
          authInvalid: false,
          connectedProject,
          isGitHubConnected,
          hasStagingEnvironment,
          hasPreviewEnvironment,
          customEnvironments,
          autoAssignCustomDomains,
        } as VercelSettingsResult));
      }).mapErr((error) => {
        // Log the error and return a safe fallback
        logger.error("Error in VercelSettingsPresenter.call", { error });
        return error;
      });
  }

  /**
   * Get data needed for the onboarding modal (custom environments and env vars)
   */
  public async getOnboardingData(
    projectId: string,
    organizationId: string,
    vercelEnvironmentId?: string
  ): Promise<VercelOnboardingData | null> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<VercelOnboardingData | null> => {
        const [gitHubInstallations, connectedGitHubRepo] = await Promise.all([
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
              id: true,
            },
          }),
        ]);

        const isGitHubConnected = connectedGitHubRepo !== null;
        const gitHubAppInstallations: GitHubAppInstallation[] = gitHubInstallations.map((installation) => ({
          id: installation.id,
          appInstallationId: installation.appInstallationId,
          targetType: installation.targetType,
          accountHandle: installation.accountHandle,
          repositories: installation.repositories.map((repo) => ({
            id: repo.id,
            name: repo.name,
            fullName: repo.fullName,
            private: repo.private,
            htmlUrl: repo.htmlUrl,
          })),
        }));

        const orgIntegration = await (this._replica as PrismaClient).organizationIntegration.findFirst({
          where: {
            organizationId,
            service: "VERCEL",
            deletedAt: null,
          },
          include: {
            tokenReference: true,
          },
        });

        if (!orgIntegration) {
          return null;
        }

        const tokenResult = await VercelIntegrationRepository.validateVercelToken(orgIntegration);
        if (tokenResult.isErr() || !tokenResult.value.isValid) {
          return {
            customEnvironments: [],
            environmentVariables: [],
            availableProjects: [],
            hasProjectSelected: false,
            authInvalid: true,
            existingVariables: {},
            gitHubAppInstallations,
            isGitHubConnected,
            isOnboardingComplete: false,
          };
        }

        const clientResult = await VercelIntegrationRepository.getVercelClient(orgIntegration);
        if (clientResult.isErr()) {
          return {
            customEnvironments: [],
            environmentVariables: [],
            availableProjects: [],
            hasProjectSelected: false,
            authInvalid: clientResult.error.authInvalid,
            existingVariables: {},
            gitHubAppInstallations,
            isGitHubConnected,
            isOnboardingComplete: false,
          };
        }
        const client = clientResult.value;
        const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

        const projectIntegration = await (this._replica as PrismaClient).organizationProjectIntegration.findFirst({
          where: {
            projectId,
            deletedAt: null,
            organizationIntegration: {
              service: "VERCEL",
              deletedAt: null,
            },
          },
        });

        const availableProjectsResult = await VercelIntegrationRepository.getVercelProjects(client, teamId);

        if (availableProjectsResult.isErr()) {
          return {
            customEnvironments: [],
            environmentVariables: [],
            availableProjects: [],
            hasProjectSelected: false,
            authInvalid: availableProjectsResult.error.authInvalid,
            existingVariables: {},
            gitHubAppInstallations,
            isGitHubConnected,
            isOnboardingComplete: false,
          };
        }

        if (!projectIntegration) {
          return {
            customEnvironments: [],
            environmentVariables: [],
            availableProjects: availableProjectsResult.value,
            hasProjectSelected: false,
            existingVariables: {},
            gitHubAppInstallations,
            isGitHubConnected,
            isOnboardingComplete: false,
          };
        }

        const [customEnvironmentsResult, projectEnvVarsResult, sharedEnvVarsResult] = await Promise.all([
          VercelIntegrationRepository.getVercelCustomEnvironments(
            client,
            projectIntegration.externalEntityId,
            teamId
          ),
          VercelIntegrationRepository.getVercelEnvironmentVariables(
            client,
            projectIntegration.externalEntityId,
            teamId
          ),
        // Only fetch shared env vars if teamId is available
          teamId
            ? VercelIntegrationRepository.getVercelSharedEnvironmentVariables(
                client,
                teamId,
                projectIntegration.externalEntityId
              )
            : okAsync([] as Array<{ id: string; key: string; type: string; isSecret: boolean; target: string[] }>),
        ]);
        const authInvalid =
          (customEnvironmentsResult.isErr() && customEnvironmentsResult.error.authInvalid) ||
          (projectEnvVarsResult.isErr() && projectEnvVarsResult.error.authInvalid) ||
          (sharedEnvVarsResult.isErr() && sharedEnvVarsResult.error.authInvalid);

        if (authInvalid) {
          return {
            customEnvironments: [],
            environmentVariables: [],
            availableProjects: availableProjectsResult.value,
            hasProjectSelected: true,
            authInvalid: true,
            existingVariables: {},
            gitHubAppInstallations,
            isGitHubConnected,
            isOnboardingComplete: false,
          };
        }

        const customEnvironments = customEnvironmentsResult.isOk() ? customEnvironmentsResult.value : [];
        const projectEnvVars = projectEnvVarsResult.isOk() ? projectEnvVarsResult.value : [];
        const sharedEnvVars = sharedEnvVarsResult.isOk() ? sharedEnvVarsResult.value : [];

        // Filter out TRIGGER_SECRET_KEY and TRIGGER_VERSION (managed by Trigger.dev) and merge project + shared env vars
        const excludedKeys = new Set(["TRIGGER_SECRET_KEY", "TRIGGER_VERSION"]);
        const projectEnvVarKeys = new Set(projectEnvVars.map((v) => v.key));
        const mergedEnvVars: VercelEnvironmentVariable[] = [
          ...projectEnvVars
            .filter((v) => !excludedKeys.has(v.key))
            .map((v) => {
              const envVar = { ...v };
              if (vercelEnvironmentId && (v as any).customEnvironmentIds?.includes(vercelEnvironmentId)) {
                envVar.target = [...v.target, 'staging'];
              }
              return envVar;
            }),
          ...sharedEnvVars
            .filter((v) => !projectEnvVarKeys.has(v.key) && !excludedKeys.has(v.key))
            .map((v) => {
              const envVar = {
                id: v.id,
                key: v.key,
                type: v.type as VercelEnvironmentVariable["type"],
                isSecret: v.isSecret,
                target: v.target,
                isShared: true,
                customEnvironmentIds: [] as string[],
              };
              if (vercelEnvironmentId && (v as any).customEnvironmentIds?.includes(vercelEnvironmentId)) {
                envVar.target = [...v.target, 'staging'];
              }
              return envVar;
            }),
        ];

        const sortedEnvVars = [...mergedEnvVars].sort((a, b) =>
          a.key.localeCompare(b.key)
        );

        const projectEnvs = await (this._replica as PrismaClient).runtimeEnvironment.findMany({
          where: {
            projectId,
            archivedAt: null, // Filter out archived environments
          },
          select: {
            id: true,
            slug: true,
            type: true,
          },
        });
        const envIdToSlug = new Map(projectEnvs.map((e) => [e.id, e.slug]));
        const activeEnvIds = new Set(projectEnvs.map((e) => e.id));

        const envVarRepository = new EnvironmentVariablesRepository(this._replica as PrismaClient);
        const existingVariables = await envVarRepository.getProject(projectId);
        const existingVariablesRecord: Record<string, { environments: string[] }> = {};
        for (const v of existingVariables) {
          // Filter out archived environments and map to slugs
          const activeEnvSlugs = v.values
            .filter((val) => activeEnvIds.has(val.environment.id))
            .map((val) => envIdToSlug.get(val.environment.id) || val.environment.type.toLowerCase());
          if (activeEnvSlugs.length > 0) {
            existingVariablesRecord[v.key] = {
              environments: activeEnvSlugs,
            };
          }
        }

        const parsedIntegrationData = VercelProjectIntegrationDataSchema.safeParse(
          projectIntegration.integrationData
        );

        return {
          customEnvironments,
          environmentVariables: sortedEnvVars,
          availableProjects: availableProjectsResult.value,
          hasProjectSelected: true,
          existingVariables: existingVariablesRecord,
          gitHubAppInstallations,
          isGitHubConnected,
          isOnboardingComplete: parsedIntegrationData.success
            ? (parsedIntegrationData.data.onboardingCompleted ?? false)
            : false,
        };
      })(),
      (error) => error
    );

    if (result.isErr()) {
      logger.error("Error in getOnboardingData", { error: result.error });
      return null;
    }

    return result.value;
  }

}