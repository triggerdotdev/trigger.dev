import { type PrismaClient, type RuntimeEnvironmentType } from "@trigger.dev/database";
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
  existingVariables: Record<string, { environments: RuntimeEnvironmentType[] }>;
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

      // Check if staging environment exists
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

      // Get Vercel project integration
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
          getVercelProjectIntegration(),
        ]).map(([hasOrgIntegration, isGitHubConnected, hasStagingEnvironment, connectedProject]) => ({
          enabled: true,
          hasOrgIntegration,
          authInvalid: false,
          connectedProject,
          isGitHubConnected,
          hasStagingEnvironment,
        })).mapErr((error) => {
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
        };
      }

      const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);
      const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

    // Get the project integration to find the Vercel project ID (if selected)
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

    // Always fetch available projects for selection
      const availableProjectsResult = await VercelIntegrationRepository.getVercelProjects(client, teamId);
      
      if (!availableProjectsResult.success) {
        return {
          customEnvironments: [],
          environmentVariables: [],
          availableProjects: [],
          hasProjectSelected: false,
          authInvalid: availableProjectsResult.authInvalid,
          existingVariables: {},
        };
      }

    // If no project integration exists, return early with just available projects
      if (!projectIntegration) {
        return {
          customEnvironments: [],
          environmentVariables: [],
          availableProjects: availableProjectsResult.data,
          hasProjectSelected: false,
          existingVariables: {},
        };
      }

    // Fetch custom environments, project env vars, and shared env vars in parallel
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
      // Check if any of the API calls failed due to auth issues
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
        };
      }

    // Extract data from successful results
      const customEnvironments = customEnvironmentsResult.success ? customEnvironmentsResult.data : [];
      const projectEnvVars = projectEnvVarsResult.success ? projectEnvVarsResult.data : [];
      const sharedEnvVars = sharedEnvVarsResult.success ? sharedEnvVarsResult.data : [];

    // Merge project and shared env vars (project vars take precedence)
    // Also filter out TRIGGER_SECRET_KEY as it's managed by Trigger.dev
      const projectEnvVarKeys = new Set(projectEnvVars.map((v) => v.key));
      const mergedEnvVars: VercelEnvironmentVariable[] = [
        ...projectEnvVars
          .filter((v) => v.key !== "TRIGGER_SECRET_KEY")
          .map((v) => {
            const envVar = { ...v };
            // Check if this env var is used in the selected custom environment
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
            // Check if this shared env var is used in the selected custom environment
            if (vercelEnvironmentId && (v as any).customEnvironmentIds?.includes(vercelEnvironmentId)) {
              envVar.target = [...v.target, 'staging'];
            }
            return envVar;
          }),
      ];

    // Sort environment variables alphabetically
      const sortedEnvVars = [...mergedEnvVars].sort((a, b) =>
        a.key.localeCompare(b.key)
      );

    // Get existing environment variables in Trigger.dev
      const envVarRepository = new EnvironmentVariablesRepository(this._replica as PrismaClient);
      const existingVariables = await envVarRepository.getProject(projectId);
      const existingVariablesRecord: Record<string, { environments: RuntimeEnvironmentType[] }> = {};
      for (const v of existingVariables) {
        existingVariablesRecord[v.key] = {
          environments: v.values.map((val) => val.environment.type),
        };
      }

      return {
        customEnvironments,
        environmentVariables: sortedEnvVars,
        availableProjects: availableProjectsResult.data,
        hasProjectSelected: true,
        existingVariables: existingVariablesRecord,
      };
    } catch (error) {
      console.error("Error in getOnboardingData:", error);
      return null;
    }
  }

}