import { flipCauseOption } from "effect/Cause";
import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { filterOrphanedEnvironments, sortEnvironments } from "~/utils/environmentSort";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  VercelProjectIntegrationDataSchema,
  SyncEnvVarsMapping,
  isLegacySyncEnvVarsMapping,
  migrateLegacySyncEnvVarsMapping,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { logger } from "~/services/logger.server";

type Result = Awaited<ReturnType<EnvironmentVariablesPresenter["call"]>>;
export type EnvironmentVariableWithSetValues = Result["environmentVariables"][number];

export class EnvironmentVariablesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const project = await this.#prismaClient.project.findFirst({
      select: {
        id: true,
      },
      where: {
        slug: projectSlug,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const environmentVariables = await this.#prismaClient.environmentVariable.findMany({
      select: {
        id: true,
        key: true,
        values: {
          select: {
            id: true,
            environmentId: true,
            valueReference: {
              select: {
                key: true,
              },
            },
            isSecret: true,
          },
        },
      },
      where: {
        project: {
          slug: projectSlug,
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        type: true,
        isBranchableEnvironment: true,
        branchName: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
      },
      where: {
        project: {
          slug: projectSlug,
        },
        archivedAt: null,
      },
    });

    const sortedEnvironments = sortEnvironments(filterOrphanedEnvironments(environments)).filter(
      (e) => e.orgMember?.userId === userId || e.orgMember === null
    );

    const repository = new EnvironmentVariablesRepository(this.#prismaClient);
    const variables = await repository.getProject(project.id);

    // Get Vercel integration data if it exists
    const vercelIntegration = await this.#prismaClient.organizationProjectIntegration.findFirst({
      where: {
        projectId: project.id,
        deletedAt: null,
        organizationIntegration: {
          service: "VERCEL",
          deletedAt: null,
        },
      },
    });

    let vercelSyncEnvVarsMapping: SyncEnvVarsMapping = {};
    let vercelPullEnvVarsEnabled = false;

    if (vercelIntegration) {
      let parsedData = VercelProjectIntegrationDataSchema.safeParse(
        vercelIntegration.integrationData
      );
      
      // Handle migration from legacy format if needed
      if (!parsedData.success) {
        const rawData = vercelIntegration.integrationData as Record<string, unknown>;
        
        if (rawData && isLegacySyncEnvVarsMapping(rawData.syncEnvVarsMapping)) {
          logger.info("Migrating legacy Vercel sync mapping format in presenter", {
            projectId: project.id,
            integrationId: vercelIntegration.id,
          });

          // Migrate the legacy format
          const migratedMapping = migrateLegacySyncEnvVarsMapping(
            rawData.syncEnvVarsMapping as Record<string, boolean>
          );

          // Update the data with migrated mapping
          const migratedData = {
            ...rawData,
            syncEnvVarsMapping: migratedMapping,
          };

          // Try parsing again with migrated data
          parsedData = VercelProjectIntegrationDataSchema.safeParse(migratedData);

          if (parsedData.success) {
            // Save the migrated data back to the database (fire and forget)
            this.#prismaClient.organizationProjectIntegration.update({
              where: { id: vercelIntegration.id },
              data: {
                integrationData: migratedData as any,
              },
            }).catch((error) => {
              logger.error("Failed to save migrated Vercel sync mapping", {
                projectId: project.id,
                integrationId: vercelIntegration.id,
                error,
              });
            });
          }
        }
      }
      
      if (parsedData.success) {
        vercelSyncEnvVarsMapping = parsedData.data.syncEnvVarsMapping;
        vercelPullEnvVarsEnabled = parsedData.data.config.pullEnvVarsFromVercel;
      }
    }

    return {
      environmentVariables: environmentVariables
        .flatMap((environmentVariable) => {
          const variable = variables.find((v) => v.key === environmentVariable.key);

          return sortedEnvironments.flatMap((env) => {
            const val = variable?.values.find((v) => v.environment.id === env.id);
            const isSecret =
              environmentVariable.values.find((v) => v.environmentId === env.id)?.isSecret ?? false;

            if (!val) {
              return [];
            }

            return [
              {
                id: environmentVariable.id,
                key: environmentVariable.key,
                environment: { type: env.type, id: env.id, branchName: env.branchName },
                value: isSecret ? "" : val.value,
                isSecret,
              },
            ];
          });
        })
        .sort((a, b) => a.key.localeCompare(b.key)),
      environments: sortedEnvironments.map((environment) => ({
        id: environment.id,
        type: environment.type,
        isBranchableEnvironment: environment.isBranchableEnvironment,
        branchName: environment.branchName,
      })),
      hasStaging: environments.some((environment) => environment.type === "STAGING"),
      // Vercel integration data
      vercelIntegration: vercelIntegration
        ? {
            enabled: true,
            pullEnvVarsEnabled: vercelPullEnvVarsEnabled,
            syncEnvVarsMapping: vercelSyncEnvVarsMapping,
          }
        : null,
    };
  }
}
