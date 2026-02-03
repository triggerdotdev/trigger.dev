import { type PrismaClient } from "@trigger.dev/database";
import { fromPromise, ok, ResultAsync } from "neverthrow";
import { env } from "~/env.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import {
  VercelIntegrationRepository,
  VercelCustomEnvironment,
  VercelEnvironmentVariable,
} from "~/models/vercelIntegration.server";
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

export type GitHubAppInstallationForVercel = {
  id: string;
  appInstallationId: bigint;
  targetType: string;
  accountHandle: string;
  repositories: Array<{
    id: string;
    name: string;
    fullName: string;
    private: boolean;
    htmlUrl: string;
  }>;
};

export type VercelOnboardingData = {
  customEnvironments: VercelCustomEnvironment[];
  environmentVariables: VercelEnvironmentVariable[];
  availableProjects: VercelAvailableProject[];
  hasProjectSelected: boolean;
  authInvalid?: boolean;
  existingVariables: Record<string, { environments: string[] }>; // Environment slugs (non-archived only)
  gitHubAppInstallations: GitHubAppInstallationForVercel[];
  isGitHubConnected: boolean;
};

export class VercelSettingsPresenter extends BasePresenter {
  /**
   * Get Vercel integration settings for the settings page
   */
  public async call({ projectId, organizationId }: VercelSettingsOptions) {
    try {
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

      const hasOrgIntegration = orgIntegration !== null;

      if (hasOrgIntegration) {
        const tokenValidation = await VercelIntegrationRepository.validateVercelToken(orgIntegration);
        if (!tokenValidation.isValid) {
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

      try {
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
            try {
              const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);
              const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);
              const [customEnvsResult, autoAssign] = await Promise.all([
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
                customEnvironments: customEnvsResult.success ? customEnvsResult.data : [],
                autoAssignCustomDomains: autoAssign,
              };
            } catch {
              return { customEnvironments: [], autoAssignCustomDomains: null };
            }
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
          console.error("Error in VercelSettingsPresenter.call:", error);
          return error;
        });
      } catch (syncError) {
        // Handle any synchronous errors that might occur
        console.error("Synchronous error in VercelSettingsPresenter.call:", syncError);
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
    } catch (error) {
      // If there's an unexpected error, log it and return a safe error result
      console.error("Unexpected error in VercelSettingsPresenter.call:", error);
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
  }

  /**
   * Get data needed for the onboarding modal (custom environments and env vars)
   */
  public async getOnboardingData(
    projectId: string,
    organizationId: string,
    vercelEnvironmentId?: string
  ): Promise<VercelOnboardingData | null> {
    try {
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
      const gitHubAppInstallations: GitHubAppInstallationForVercel[] = gitHubInstallations.map((installation) => ({
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

      const tokenValidation = await VercelIntegrationRepository.validateVercelToken(orgIntegration);
      if (!tokenValidation.isValid) {
        return {
          customEnvironments: [],
          environmentVariables: [],
          availableProjects: [],
          hasProjectSelected: false,
          authInvalid: true,
          existingVariables: {},
          gitHubAppInstallations,
          isGitHubConnected,
        };
      }

      const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);
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
      
      if (!availableProjectsResult.success) {
        return {
          customEnvironments: [],
          environmentVariables: [],
          availableProjects: [],
          hasProjectSelected: false,
          authInvalid: availableProjectsResult.authInvalid,
          existingVariables: {},
          gitHubAppInstallations,
          isGitHubConnected,
        };
      }

      if (!projectIntegration) {
        return {
          customEnvironments: [],
          environmentVariables: [],
          availableProjects: availableProjectsResult.data,
          hasProjectSelected: false,
          existingVariables: {},
          gitHubAppInstallations,
          isGitHubConnected,
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
          : Promise.resolve({ success: true as const, data: [] }),
      ]);
      const authInvalid =
        (!customEnvironmentsResult.success && customEnvironmentsResult.authInvalid) ||
        (!projectEnvVarsResult.success && projectEnvVarsResult.authInvalid) ||
        (!sharedEnvVarsResult.success && sharedEnvVarsResult.authInvalid);

      if (authInvalid) {
        return {
          customEnvironments: [],
          environmentVariables: [],
          availableProjects: availableProjectsResult.data,
          hasProjectSelected: true,
          authInvalid: true,
          existingVariables: {},
          gitHubAppInstallations,
          isGitHubConnected,
        };
      }

      const customEnvironments = customEnvironmentsResult.success ? customEnvironmentsResult.data : [];
      const projectEnvVars = projectEnvVarsResult.success ? projectEnvVarsResult.data : [];
      const sharedEnvVars = sharedEnvVarsResult.success ? sharedEnvVarsResult.data : [];

      // Filter out TRIGGER_SECRET_KEY (managed by Trigger.dev) and merge project + shared env vars
      const projectEnvVarKeys = new Set(projectEnvVars.map((v) => v.key));
      const mergedEnvVars: VercelEnvironmentVariable[] = [
        ...projectEnvVars
          .filter((v) => v.key !== "TRIGGER_SECRET_KEY")
          .map((v) => {
            const envVar = { ...v };
            if (vercelEnvironmentId && (v as any).customEnvironmentIds?.includes(vercelEnvironmentId)) {
              envVar.target = [...v.target, 'staging'];
            }
            return envVar;
          }),
        ...sharedEnvVars
          .filter((v) => !projectEnvVarKeys.has(v.key) && v.key !== "TRIGGER_SECRET_KEY")
          .map((v) => {
            const envVar = {
              id: v.id,
              key: v.key,
              type: v.type as VercelEnvironmentVariable["type"],
              isSecret: v.isSecret,
              target: v.target,
              isShared: true,
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

      return {
        customEnvironments,
        environmentVariables: sortedEnvVars,
        availableProjects: availableProjectsResult.data,
        hasProjectSelected: true,
        existingVariables: existingVariablesRecord,
        gitHubAppInstallations,
        isGitHubConnected,
      };
    } catch (error) {
      console.error("Error in getOnboardingData:", error);
      return null;
    }
  }

}