import { type PrismaClient } from "@trigger.dev/database";
import { fromPromise, ok, ResultAsync } from "neverthrow";
import { env } from "~/env.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import {
  VercelIntegrationRepository,
  VercelCustomEnvironment,
  VercelEnvironmentVariable,
} from "~/models/vercelIntegration.server";
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
};

export class VercelSettingsPresenter extends BasePresenter {
  /**
   * Get Vercel integration settings for the settings page
   */
  public call({ projectId, organizationId }: VercelSettingsOptions) {
    const vercelIntegrationEnabled = OrgIntegrationRepository.isVercelSupported;

    if (!vercelIntegrationEnabled) {
      return ok({
        enabled: false,
        hasOrgIntegration: false,
        connectedProject: undefined,
        isGitHubConnected: false,
        hasStagingEnvironment: false,
      } as VercelSettingsResult);
    }

    // Check if org-level Vercel integration exists
    const checkOrgIntegration = () =>
      fromPromise(
        (this._replica as PrismaClient).organizationIntegration.findFirst({
          where: {
            organizationId,
            service: "VERCEL",
            deletedAt: null,
          },
          select: {
            id: true,
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map((orgIntegration) => orgIntegration !== null);

    // Check if GitHub is connected
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

    return ResultAsync.combine([
      checkOrgIntegration(),
      checkGitHubConnection(),
      checkStagingEnvironment(),
      getVercelProjectIntegration(),
    ]).map(([hasOrgIntegration, isGitHubConnected, hasStagingEnvironment, connectedProject]) => ({
      enabled: true,
      hasOrgIntegration,
      connectedProject,
      isGitHubConnected,
      hasStagingEnvironment,
    }));
  }

  /**
   * Get data needed for the onboarding modal (custom environments and env vars)
   */
  public async getOnboardingData(projectId: string, organizationId: string): Promise<VercelOnboardingData | null> {
    // First, check if there's an org integration for this organization
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

    // Get the Vercel client
    const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);

    // Get the team ID from the secret
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
    const availableProjects = await VercelIntegrationRepository.getVercelProjects(client, teamId);

    // If no project integration exists, return early with just available projects
    if (!projectIntegration) {
      return {
        customEnvironments: [],
        environmentVariables: [],
        availableProjects,
        hasProjectSelected: false,
      };
    }

    // Fetch custom environments, project env vars, and shared env vars in parallel
    const [customEnvironments, projectEnvVars, sharedEnvVars] = await Promise.all([
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
        : Promise.resolve([]),
    ]);

    // Merge project and shared env vars (project vars take precedence)
    // Also filter out TRIGGER_SECRET_KEY as it's managed by Trigger.dev
    const projectEnvVarKeys = new Set(projectEnvVars.map((v) => v.key));
    const mergedEnvVars: VercelEnvironmentVariable[] = [
      ...projectEnvVars.filter((v) => v.key !== "TRIGGER_SECRET_KEY"),
      ...sharedEnvVars
        .filter((v) => !projectEnvVarKeys.has(v.key) && v.key !== "TRIGGER_SECRET_KEY")
        .map((v) => ({
          id: v.id,
          key: v.key,
          type: v.type as VercelEnvironmentVariable["type"],
          isSecret: v.isSecret,
          target: v.target,
          isShared: true,
        })),
    ];

    // Sort environment variables alphabetically
    const sortedEnvVars = [...mergedEnvVars].sort((a, b) =>
      a.key.localeCompare(b.key)
    );

    return {
      customEnvironments,
      environmentVariables: sortedEnvVars,
      availableProjects,
      hasProjectSelected: true,
    };
  }

}

