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
  createDefaultVercelIntegrationData,
} from "~/v3/vercel/vercelProjectIntegrationSchema";

/**
 * Base type for Vercel project integration with parsed data.
 * Used for simple operations that don't need related data.
 */
export type VercelProjectIntegrationWithParsedData = OrganizationProjectIntegration & {
  parsedIntegrationData: VercelProjectIntegrationData;
};

/**
 * Vercel project integration including the organization integration relation.
 */
export type VercelProjectIntegrationWithData = VercelProjectIntegrationWithParsedData & {
  organizationIntegration: OrganizationIntegration;
};

/**
 * Vercel project integration including both organization integration and project relations.
 */
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

  /**
   * Get the Vercel project integration for a specific project.
   */
  async getVercelProjectIntegration(
    projectId: string
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

  /**
   * Get all connected Vercel projects for an organization.
   */
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

  /**
   * Create a new Vercel project integration.
   * This links a Vercel project to a Trigger.dev project.
   */
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
        integrationData: integrationData as any,
        installedBy: params.installedByUserId,
      },
    });
  }

  /**
   * Select a Vercel project during onboarding.
   * Creates the OrganizationProjectIntegration record and syncs API keys to Vercel.
   */
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
    // Get the org integration
    const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationByOrganization(
      params.organizationId
    );

    if (!orgIntegration) {
      throw new Error("No Vercel organization integration found");
    }

    // Get the team ID from the stored secret
    const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

    // Check if there's already a project integration (shouldn't happen, but handle gracefully)
    const existing = await this.getVercelProjectIntegration(params.projectId);
    if (existing) {
      // Update the existing integration
      const updated = await this.#prismaClient.organizationProjectIntegration.update({
        where: { id: existing.id },
        data: {
          externalEntityId: params.vercelProjectId,
          integrationData: {
            ...existing.parsedIntegrationData,
            vercelProjectId: params.vercelProjectId,
            vercelProjectName: params.vercelProjectName,
            vercelTeamId: teamId,
          } as any,
        },
      });

      // Sync API keys to the newly selected project
      const syncResult = await VercelIntegrationRepository.syncApiKeysToVercel({
        projectId: params.projectId,
        vercelProjectId: params.vercelProjectId,
        teamId,
        vercelStagingEnvironment: existing.parsedIntegrationData.config.vercelStagingEnvironment,
        orgIntegration,
      });

      return { integration: updated, syncResult };
    }

    // Create new project integration
    const integration = await this.createVercelProjectIntegration({
      organizationIntegrationId: orgIntegration.id,
      projectId: params.projectId,
      vercelProjectId: params.vercelProjectId,
      vercelProjectName: params.vercelProjectName,
      vercelTeamId: teamId,
      installedByUserId: params.userId,
    });

    // Sync API keys to Vercel immediately
    const syncResult = await VercelIntegrationRepository.syncApiKeysToVercel({
      projectId: params.projectId,
      vercelProjectId: params.vercelProjectId,
      teamId,
      // No staging environment mapping yet - will be set during onboarding
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

  /**
   * Update the Vercel integration config for a project.
   */
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
        integrationData: updatedData as any,
      },
    });

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  /**
   * Update the environment variable sync mapping for a project.
   */
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
        integrationData: updatedData as any,
      },
    });

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  /**
   * Update the sync status of a specific environment variable for a given environment type.
   * This is used when toggling individual env var sync settings from the UI.
   */
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

    // Get the current sync mapping
    const currentMapping = existing.parsedIntegrationData.syncEnvVarsMapping || {};

    // Get the current settings for this env var (if any)
    const currentEnvVarSettings = currentMapping[envVarKey] || {};

    // Create a new mapping with the updated value
    const updatedMapping: SyncEnvVarsMapping = {
      ...currentMapping,
      [envVarKey]: {
        ...currentEnvVarSettings,
        [environmentType]: syncEnabled,
      },
    };

    const updatedData: VercelProjectIntegrationData = {
      ...existing.parsedIntegrationData,
      syncEnvVarsMapping: updatedMapping,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData as any,
      },
    });

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  /**
   * Complete the onboarding process and save all user selections.
   * If pullEnvVarsFromVercel is true, also pulls env vars from Vercel and stores them in the database.
   */
  async completeOnboarding(
    projectId: string,
    params: {
      vercelStagingEnvironment?: string | null;
      vercelStagingName?: string | null;
      pullEnvVarsFromVercel: boolean;
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
        pullEnvVarsFromVercel: params.pullEnvVarsFromVercel,
        vercelStagingEnvironment: params.vercelStagingEnvironment ?? null,
        vercelStagingName: params.vercelStagingName ?? null,
      },
      syncEnvVarsMapping: params.syncEnvVarsMapping,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData as any,
      },
    });

    // Pull env vars from Vercel if enabled
    if (params.pullEnvVarsFromVercel) {
      try {
        // Get the org integration with token reference
        const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationForProject(
          projectId
        );

        if (orgIntegration) {
          const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

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
        // Log but don't fail onboarding if env var pull fails
        logger.error("Failed to pull env vars from Vercel during onboarding", {
          projectId,
          vercelProjectId: updatedData.vercelProjectId,
          error,
        });
      }
    }

    return {
      ...updated,
      parsedIntegrationData: updatedData,
    };
  }

  /**
   * Skip onboarding without modifying any settings.
   * This is a no-op that just closes the modal - no database changes needed.
   */
  async skipOnboarding(_projectId: string): Promise<void> {
    // No-op - onboarding is tracked only via URL query parameter
    // This method exists for API consistency
  }

  /**
   * Disconnect a Vercel project from a Trigger.dev project (soft delete).
   */
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

