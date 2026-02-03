import type {
  PrismaClient,
  OrganizationProjectIntegration,
  OrganizationIntegration,
  SecretReference,
} from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";
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

    try {
      const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);
      await VercelIntegrationRepository.disableAutoAssignCustomDomains(
        client,
        params.vercelProjectId,
        teamId
      );
    } catch (error) {
      logger.warn("Failed to disable autoAssignCustomDomains during project selection", {
        projectId: params.projectId,
        vercelProjectId: params.vercelProjectId,
        error,
      });
    }

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

    if (updatedConfig.atomicBuilds?.includes("prod")) {
      const orgIntegration = await VercelIntegrationRepository.findVercelOrgIntegrationForProject(
        projectId
      );

      if (orgIntegration) {
        await this.#syncTriggerVersionToVercelProduction(
          projectId,
          updatedConfig.atomicBuilds,
          orgIntegration
        );
      }
    }

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

  async removeSyncEnvVarForEnvironment(
    projectId: string,
    envVarKey: string,
    environmentType: TriggerEnvironmentType
  ): Promise<void> {
    const existing = await this.getVercelProjectIntegration(projectId);
    if (!existing) return;

    const currentMapping = existing.parsedIntegrationData.syncEnvVarsMapping || {};
    const envSlug = envTypeToSlug(environmentType);
    const currentEnvSettings = currentMapping[envSlug];
    if (!currentEnvSettings || !(envVarKey in currentEnvSettings)) return;

    const { [envVarKey]: _, ...rest } = currentEnvSettings;
    const updatedMapping = { ...currentMapping, [envSlug]: rest };

    await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: {
          ...existing.parsedIntegrationData,
          syncEnvVarsMapping: updatedMapping,
        },
      },
    });
  }

  async completeOnboarding(
    projectId: string,
    params: {
      vercelStagingEnvironment?: { environmentId: string; displayName: string } | null;
      pullEnvVarsBeforeBuild?: EnvSlug[] | null;
      atomicBuilds?: EnvSlug[] | null;
      discoverEnvVars?: EnvSlug[] | null;
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
        discoverEnvVars: params.discoverEnvVars ?? null,
        vercelStagingEnvironment: params.vercelStagingEnvironment ?? null,
      },
      syncEnvVarsMapping: existing.parsedIntegrationData.syncEnvVarsMapping,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData,
      },
    });

    try {
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

        await this.#syncTriggerVersionToVercelProduction(
          projectId,
          updatedData.config.atomicBuilds,
          orgIntegration
        );
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

  async #syncTriggerVersionToVercelProduction(
    projectId: string,
    atomicBuilds: string[] | null | undefined,
    orgIntegration: OrganizationIntegration & { tokenReference: SecretReference }
  ): Promise<void> {
    try {
      if (!atomicBuilds?.includes("prod")) {
        return;
      }

      const prodEnvironment = await this.#prismaClient.runtimeEnvironment.findFirst({
        where: {
          projectId,
          type: "PRODUCTION",
        },
        select: {
          id: true,
        },
      });

      if (!prodEnvironment) {
        return;
      }

      const currentDeployment = await findCurrentWorkerDeployment({
        environmentId: prodEnvironment.id,
      });

      if (!currentDeployment?.version) {
        return;
      }

      const client = await VercelIntegrationRepository.getVercelClient(orgIntegration);
      const teamId = await VercelIntegrationRepository.getTeamIdFromIntegration(orgIntegration);

      // Get the Vercel project ID from the project integration
      const projectIntegration = await this.#prismaClient.organizationProjectIntegration.findFirst({
        where: {
          projectId,
          organizationIntegrationId: orgIntegration.id,
          deletedAt: null,
        },
        select: {
          externalEntityId: true,
        },
      });

      if (!projectIntegration) {
        return;
      }

      const vercelProjectId = projectIntegration.externalEntityId;

      // Check if TRIGGER_VERSION already exists targeting production
      const envVarsResult = await VercelIntegrationRepository.getVercelEnvironmentVariables(
        client,
        vercelProjectId,
        teamId
      );

      if (!envVarsResult.success) {
        logger.warn("Failed to fetch Vercel env vars for TRIGGER_VERSION sync", {
          projectId,
          vercelProjectId,
          error: envVarsResult.error,
        });
        return;
      }

      const existingTriggerVersion = envVarsResult.data.find(
        (env) => env.key === "TRIGGER_VERSION" && env.target.includes("production")
      );

      if (existingTriggerVersion) {
        return;
      }

      // Push TRIGGER_VERSION to Vercel production
      await client.projects.createProjectEnv({
        idOrName: vercelProjectId,
        ...(teamId && { teamId }),
        upsert: "true",
        requestBody: {
          key: "TRIGGER_VERSION",
          value: currentDeployment.version,
          target: ["production"] as any,
          type: "encrypted",
        },
      });

      logger.info("Synced TRIGGER_VERSION to Vercel production", {
        projectId,
        vercelProjectId,
        version: currentDeployment.version,
      });
    } catch (error) {
      logger.error("Failed to sync TRIGGER_VERSION to Vercel production", {
        projectId,
        error,
      });
    }
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

