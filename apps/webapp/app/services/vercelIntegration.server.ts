import type {
  PrismaClient,
  OrganizationProjectIntegration,
  OrganizationIntegration,
} from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import {
  VercelProjectIntegrationDataSchema,
  VercelProjectIntegrationData,
  VercelIntegrationConfig,
  SyncEnvVarsMapping,
  TriggerEnvironmentType,
  EnvSlug,
  envTypeToSlug,
  createDefaultVercelIntegrationData,
} from "~/v3/vercel/vercelProjectIntegrationSchema";

export type VercelProjectIntegrationWithParsedData = OrganizationProjectIntegration & {
  parsedIntegrationData: VercelProjectIntegrationData;
};

export type VercelProjectIntegrationWithData = VercelProjectIntegrationWithParsedData & {
  organizationIntegration: OrganizationIntegration;
};

export type VercelProjectIntegrationWithProject = VercelProjectIntegrationWithData & {
  project: {
    id: string;
    name: string;
    slug: string;
  };
};

export class VercelIntegrationService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async getVercelProjectIntegration(
    projectId: string,
    migrateIfNeeded: boolean = false
  ): Promise<VercelProjectIntegrationWithData | null> {
    const integration = await this.#prismaClient.organizationProjectIntegration.findFirst({
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
    });

    if (!integration) {
      return null;
    }

    const parsedData = VercelProjectIntegrationDataSchema.safeParse(integration.integrationData);

    if (!parsedData.success) {
      logger.error("Failed to parse Vercel integration data", {
        projectId,
        integrationId: integration.id,
        error: parsedData.error,
      });
      return null;
    }

    return {
      ...integration,
      parsedIntegrationData: parsedData.data,
    };
  }

  async getConnectedVercelProjects(
    organizationId: string
  ): Promise<VercelProjectIntegrationWithProject[]> {
    const integrations = await this.#prismaClient.organizationProjectIntegration.findMany({
      where: {
        deletedAt: null,
        organizationIntegration: {
          organizationId,
          service: "VERCEL",
          deletedAt: null,
        },
      },
      include: {
        organizationIntegration: true,
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    return integrations
      .map((integration) => {
        const parsedData = VercelProjectIntegrationDataSchema.safeParse(integration.integrationData);
        if (!parsedData.success) {
          logger.error("Failed to parse Vercel integration data", {
            integrationId: integration.id,
            error: parsedData.error,
          });
          return null;
        }

        return {
          ...integration,
          parsedIntegrationData: parsedData.data,
        };
      })
      .filter((i): i is VercelProjectIntegrationWithProject => i !== null);
  }

  async createVercelProjectIntegration(params: {
    organizationIntegrationId: string;
    projectId: string;
    vercelProjectId: string;
    vercelProjectName: string;
    vercelTeamId: string | null;
    installedByUserId?: string;
  }): Promise<OrganizationProjectIntegration> {
    const integrationData = createDefaultVercelIntegrationData(
      params.vercelProjectId,
      params.vercelProjectName,
      params.vercelTeamId
    );

    return this.#prismaClient.organizationProjectIntegration.create({
      data: {
        organizationIntegrationId: params.organizationIntegrationId,
        projectId: params.projectId,
        externalEntityId: params.vercelProjectId,
        integrationData: integrationData,
        installedBy: params.installedByUserId,
      },
    });
  }

  async selectVercelProject(params: {
    organizationId: string;
    projectId: string;
    vercelProjectId: string;
    vercelProjectName: string;
    userId: string;
  }): Promise<{
    integration: OrganizationProjectIntegration;
    syncResult: { success: boolean; errors: string[] };
  }> {
    const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByOrganization(
      params.organizationId
    );

    if (!orgIntegration) {
      throw new Error("No Vercel organization integration found");
    }

    const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

    const existing = await this.getVercelProjectIntegration(params.projectId);
    if (existing) {
      const updated = await this.#prismaClient.organizationProjectIntegration.update({
        where: { id: existing.id },
        data: {
          externalEntityId: params.vercelProjectId,
          integrationData: {
            ...existing.parsedIntegrationData,
            vercelProjectId: params.vercelProjectId,
            vercelProjectName: params.vercelProjectName,
            vercelTeamId: teamId,
          },
        },
      });

      const syncResult = await VercelIntegrationRepository.syncApiKeysToVercel({
        projectId: params.projectId,
        vercelProjectId: params.vercelProjectId,
        teamId,
        vercelStagingEnvironment: existing.parsedIntegrationData.config.vercelStagingEnvironment,
        orgIntegration,
      });

      return { integration: updated, syncResult };
    }

    const integration = await this.createVercelProjectIntegration({
      organizationIntegrationId: orgIntegration.id,
      projectId: params.projectId,
      vercelProjectId: params.vercelProjectId,
      vercelProjectName: params.vercelProjectName,
      vercelTeamId: teamId,
      installedByUserId: params.userId,
    });

    const syncResult = await VercelIntegrationRepository.syncApiKeysToVercel({
      projectId: params.projectId,
      vercelProjectId: params.vercelProjectId,
      teamId,
      vercelStagingEnvironment: null,
      orgIntegration,
    });

    logger.info("Vercel project selected and API keys synced", {
      projectId: params.projectId,
      vercelProjectId: params.vercelProjectId,
      vercelProjectName: params.vercelProjectName,
      syncSuccess: syncResult.success,
      syncErrors: syncResult.errors,
    });

    return { integration, syncResult };
  }

  async updateVercelIntegrationConfig(
    projectId: string,
    configUpdates: Partial<VercelIntegrationConfig>
  ): Promise<VercelProjectIntegrationWithParsedData | null> {
    const existing = await this.getVercelProjectIntegration(projectId);
    if (!existing) {
      return null;
    }

    const updatedConfig = {
      ...existing.parsedIntegrationData.config,
      ...configUpdates,
    };

    const updatedData: VercelProjectIntegrationData = {
      ...existing.parsedIntegrationData,
      config: updatedConfig,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData,
      },
    });

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  async updateSyncEnvVarsMapping(
    projectId: string,
    syncEnvVarsMapping: SyncEnvVarsMapping
  ): Promise<VercelProjectIntegrationWithParsedData | null> {
    const existing = await this.getVercelProjectIntegration(projectId);
    if (!existing) {
      return null;
    }

    const updatedData: VercelProjectIntegrationData = {
      ...existing.parsedIntegrationData,
      syncEnvVarsMapping,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData,
      },
    });

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  async updateSyncEnvVarForEnvironment(
    projectId: string,
    envVarKey: string,
    environmentType: TriggerEnvironmentType,
    syncEnabled: boolean
  ): Promise<VercelProjectIntegrationWithParsedData | null> {
    const existing = await this.getVercelProjectIntegration(projectId);
    if (!existing) {
      return null;
    }

    const currentMapping = existing.parsedIntegrationData.syncEnvVarsMapping || {};
    const envSlug = envTypeToSlug(environmentType);

    const currentEnvSettings = currentMapping[envSlug] || {};

    const updatedMapping: SyncEnvVarsMapping = {
      ...currentMapping,
      [envSlug]: {
        ...currentEnvSettings,
        [envVarKey]: syncEnabled,
      },
    };

    const updatedData: VercelProjectIntegrationData = {
      ...existing.parsedIntegrationData,
      syncEnvVarsMapping: updatedMapping,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData,
      },
    });

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  async completeOnboarding(
    projectId: string,
    params: {
      vercelStagingEnvironment?: { environmentId: string; displayName: string } | null;
      pullEnvVarsBeforeBuild?: EnvSlug[] | null;
      atomicBuilds?: EnvSlug[] | null;
      pullNewEnvVars?: boolean | null;
      syncEnvVarsMapping: SyncEnvVarsMapping;
    }
  ): Promise<VercelProjectIntegrationWithParsedData | null> {
    const existing = await this.getVercelProjectIntegration(projectId);
    if (!existing) {
      return null;
    }

    const updatedData: VercelProjectIntegrationData = {
      ...existing.parsedIntegrationData,
      config: {
        ...existing.parsedIntegrationData.config,
        pullEnvVarsBeforeBuild: params.pullEnvVarsBeforeBuild ?? null,
        atomicBuilds: params.atomicBuilds ?? null,
        pullNewEnvVars: params.pullNewEnvVars ?? null,
        vercelStagingEnvironment: params.vercelStagingEnvironment ?? null,
      },
      // Don't save syncEnvVarsMapping - it's only used for the one-time pull during onboarding
      // Keep the existing mapping (or empty default)
      syncEnvVarsMapping: existing.parsedIntegrationData.syncEnvVarsMapping,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData,
      },
    });

    // Pull env vars now (one-time sync during onboarding)
    // Always attempt to pull - the pullEnvVarsFromVercel function will filter based on the mapping.
    // We can't easily check hasEnabledVars because vars NOT in the mapping are enabled by default,
    // so a mapping like { "dev": { "VAR1": false } } still means VAR2, VAR3, etc. should be synced.
    try {
      // Get the org integration with token reference
      const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationForProject(
        projectId
      );

      if (orgIntegration) {
        const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

        logger.info("Vercel onboarding: pulling env vars from Vercel", {
          projectId,
          vercelProjectId: updatedData.vercelProjectId,
          teamId,
          vercelStagingEnvironment: params.vercelStagingEnvironment,
          syncEnvVarsMappingKeys: Object.keys(params.syncEnvVarsMapping),
        });

        const pullResult = await VercelIntegrationRepository.pullEnvVarsFromVercel({
          projectId,
          vercelProjectId: updatedData.vercelProjectId,
          teamId,
          vercelStagingEnvironment: params.vercelStagingEnvironment,
          syncEnvVarsMapping: params.syncEnvVarsMapping,
          orgIntegration,
        });

        if (!pullResult.success) {
          logger.warn("Some errors occurred while pulling env vars from Vercel", {
            projectId,
            vercelProjectId: updatedData.vercelProjectId,
            errors: pullResult.errors,
            syncedCount: pullResult.syncedCount,
          });
        } else {
          logger.info("Successfully pulled env vars from Vercel", {
            projectId,
            vercelProjectId: updatedData.vercelProjectId,
            syncedCount: pullResult.syncedCount,
          });
        }
      } else {
        logger.warn("No org integration found when trying to pull env vars from Vercel", {
          projectId,
        });
      }
    } catch (error) {
      logger.error("Failed to pull env vars from Vercel during onboarding", {
        projectId,
        vercelProjectId: updatedData.vercelProjectId,
        error,
      });
    }

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  async disconnectVercelProject(projectId: string): Promise<boolean> {
    const existing = await this.getVercelProjectIntegration(projectId);
    if (!existing) {
      return false;
    }

    await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        deletedAt: new Date(),
      },
    });

    return true;
  }
}

