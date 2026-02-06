import type {
  PrismaClient,
  OrganizationProjectIntegration,
  OrganizationIntegration,
  SecretReference,
} from "@trigger.dev/database";
import { ResultAsync } from "neverthrow";
import { prisma, $transaction } from "~/db.server";
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
    vercelTeamSlug?: string;
    installedByUserId?: string;
  }): Promise<OrganizationProjectIntegration> {
    const integrationData = createDefaultVercelIntegrationData(
      params.vercelProjectId,
      params.vercelProjectName,
      params.vercelTeamId,
      params.vercelTeamSlug
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

    const vercelTeamSlug = await VercelIntegrationRepository.getVercelClient(orgIntegration)
      .andThen((client) => VercelIntegrationRepository.getTeamSlug(client, teamId))
      .match(
        (slug) => slug,
        () => undefined
      );

    // Use a serializable transaction to prevent duplicate project integrations
    // from concurrent selectVercelProject calls (read-then-write race condition).
    const txResult = await $transaction(
      this.#prismaClient,
      "selectVercelProject",
      async (tx) => {
        const existing = await tx.organizationProjectIntegration.findFirst({
          where: {
            projectId: params.projectId,
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

        if (existing) {
          const parsedData = VercelProjectIntegrationDataSchema.safeParse(
            existing.integrationData
          );

          const updated = await tx.organizationProjectIntegration.update({
            where: { id: existing.id },
            data: {
              externalEntityId: params.vercelProjectId,
              integrationData: {
                ...(parsedData.success ? parsedData.data : {}),
                vercelProjectId: params.vercelProjectId,
                vercelProjectName: params.vercelProjectName,
                vercelTeamId: teamId,
                vercelTeamSlug,
              },
            },
          });

          return {
            integration: updated,
            wasCreated: false,
            vercelStagingEnvironment: parsedData.success
              ? parsedData.data.config.vercelStagingEnvironment
              : null,
          };
        }

        const integrationData = createDefaultVercelIntegrationData(
          params.vercelProjectId,
          params.vercelProjectName,
          teamId,
          vercelTeamSlug
        );

        const created = await tx.organizationProjectIntegration.create({
          data: {
            organizationIntegrationId: orgIntegration.id,
            projectId: params.projectId,
            externalEntityId: params.vercelProjectId,
            integrationData: integrationData,
            installedBy: params.userId,
          },
        });

        return {
          integration: created,
          wasCreated: true,
          vercelStagingEnvironment: null,
        };
      },
      { isolationLevel: "Serializable" }
    );

    if (!txResult) {
      throw new Error("Failed to select Vercel project: transaction returned undefined");
    }

    const { integration, wasCreated, vercelStagingEnvironment } = txResult;

    const syncResultAsync = await VercelIntegrationRepository.syncApiKeysToVercel({
      projectId: params.projectId,
      vercelProjectId: params.vercelProjectId,
      teamId,
      vercelStagingEnvironment,
      orgIntegration,
    });
    const syncResult = syncResultAsync.isOk()
      ? { success: syncResultAsync.value.errors.length === 0, errors: syncResultAsync.value.errors }
      : { success: false, errors: [syncResultAsync.error.message] };

    if (wasCreated) {
      const disableResult = await VercelIntegrationRepository.getVercelClient(orgIntegration)
        .andThen((client) =>
          VercelIntegrationRepository.disableAutoAssignCustomDomains(
            client,
            params.vercelProjectId,
            teamId
          )
        );

      if (disableResult.isErr()) {
        logger.warn("Failed to disable autoAssignCustomDomains during project selection", {
          projectId: params.projectId,
          vercelProjectId: params.vercelProjectId,
          error: disableResult.error.message,
        });
      }

      logger.info("Vercel project selected and API keys synced", {
        projectId: params.projectId,
        vercelProjectId: params.vercelProjectId,
        vercelProjectName: params.vercelProjectName,
        syncSuccess: syncResult.success,
        syncErrors: syncResult.errors,
      });
    }

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

    if (!updatedConfig.atomicBuilds?.includes("prod")) {
      return { ...updated, parsedIntegrationData: updatedData };
    }

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
      syncEnvVarsMapping?: SyncEnvVarsMapping;
    }
  ): Promise<VercelProjectIntegrationWithParsedData | null> {
    const existing = await this.getVercelProjectIntegration(projectId);
    if (!existing) {
      return null;
    }

    const syncEnvVarsMapping = params.syncEnvVarsMapping ?? { "dev":{}, "stg":{}, "prod":{}, "preview":{} };
    const updatedData: VercelProjectIntegrationData = {
      ...existing.parsedIntegrationData,
      config: {
        ...existing.parsedIntegrationData.config,
        pullEnvVarsBeforeBuild: params.pullEnvVarsBeforeBuild ?? null,
        atomicBuilds: params.atomicBuilds ?? null,
        discoverEnvVars: params.discoverEnvVars ?? null,
        vercelStagingEnvironment: params.vercelStagingEnvironment ?? null,
      },
      //This is intentionally not updated here, in case of resetting the onboarding it should not override the existing mapping with an empty one
      syncEnvVarsMapping: existing.parsedIntegrationData.syncEnvVarsMapping, 
      onboardingCompleted: true,
    };

    const updated = await this.#prismaClient.organizationProjectIntegration.update({
      where: { id: existing.id },
      data: {
        integrationData: updatedData,
      },
    });

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
        syncEnvVarsMapping,
        orgIntegration,
      });

      if (pullResult.isErr()) {
        logger.error("Failed to pull env vars from Vercel during onboarding", {
          projectId,
          error: pullResult.error.message,
        });
      } else if (pullResult.value.errors.length > 0) {
        logger.warn("Errors pulling env vars from Vercel during onboarding", {
          projectId,
          errors: pullResult.value.errors,
        });
      }

      await this.#syncTriggerVersionToVercelProduction(
        projectId,
        updatedData.config.atomicBuilds,
        orgIntegration
      );
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

    const clientResult = await VercelIntegrationRepository.getVercelClient(orgIntegration);
    if (clientResult.isErr()) {
      logger.error("Failed to get Vercel client for TRIGGER_VERSION sync", {
        projectId,
        error: clientResult.error.message,
      });
      return;
    }
    const client = clientResult.value;
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

    if (envVarsResult.isErr()) {
      logger.warn("Failed to fetch Vercel env vars for TRIGGER_VERSION sync", {
        projectId,
        vercelProjectId,
        error: envVarsResult.error.message,
      });
      return;
    }

    const existingTriggerVersion = envVarsResult.value.find(
      (env) => env.key === "TRIGGER_VERSION" && env.target.includes("production")
    );

    if (existingTriggerVersion) {
      return;
    }

    // Push TRIGGER_VERSION to Vercel production
    const createResult = await ResultAsync.fromPromise(
      client.projects.createProjectEnv({
        idOrName: vercelProjectId,
        ...(teamId && { teamId }),
        upsert: "true",
        requestBody: {
          key: "TRIGGER_VERSION",
          value: currentDeployment.version,
          target: ["production"] as any,
          type: "encrypted",
        },
      }),
      (error) => error
    );

    if (createResult.isErr()) {
      logger.error("Failed to sync TRIGGER_VERSION to Vercel production", {
        projectId,
        vercelProjectId,
        error: createResult.error instanceof Error ? createResult.error.message : String(createResult.error),
      });
      return;
    }

    logger.info("Synced TRIGGER_VERSION to Vercel production", {
      projectId,
      vercelProjectId,
      version: currentDeployment.version,
    });
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

