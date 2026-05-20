import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { filterOrphanedEnvironments, sortEnvironments } from "~/utils/environmentSort";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import type { EnvironmentVariableUpdater } from "~/v3/environmentVariables/repository";
import {
  SyncEnvVarsMapping,
  EnvSlug,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";

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
            version: true,
            lastUpdatedBy: true,
            updatedAt: true,
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

    const userIds = new Set(
      environmentVariables
        .flatMap((envVar) => envVar.values)
        .map((value) => value.lastUpdatedBy)
        .filter(
          (lastUpdatedBy): lastUpdatedBy is { type: "user"; userId: string } =>
            lastUpdatedBy !== null &&
            typeof lastUpdatedBy === "object" &&
            "type" in lastUpdatedBy &&
            lastUpdatedBy.type === "user" &&
            "userId" in lastUpdatedBy &&
            typeof lastUpdatedBy.userId === "string"
        )
        .map((lastUpdatedBy) => lastUpdatedBy.userId)
    );

    const users =
      userIds.size > 0
        ? await this.#prismaClient.user.findMany({
            where: {
              id: {
                in: Array.from(userIds),
              },
            },
            select: {
              id: true,
              name: true,
              displayName: true,
              avatarUrl: true,
            },
          })
        : [];

    const usersRecord: Record<string, { id: string; name: string | null; displayName: string | null; avatarUrl: string | null }> =
      Object.fromEntries(users.map((u) => [u.id, u]));

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
    const vercelService = new VercelIntegrationService(this.#prismaClient);
    const vercelIntegration = await vercelService.getVercelProjectIntegration(project.id);

    let vercelSyncEnvVarsMapping: SyncEnvVarsMapping = {};
    let vercelPullEnvVarsBeforeBuild: EnvSlug[] | null = null;

    if (vercelIntegration) {
      vercelSyncEnvVarsMapping = vercelIntegration.parsedIntegrationData.syncEnvVarsMapping;
      vercelPullEnvVarsBeforeBuild = vercelIntegration.parsedIntegrationData.config.pullEnvVarsBeforeBuild ?? null;
    }

    return {
      environmentVariables: environmentVariables
        .flatMap((environmentVariable) => {
          const variable = variables.find((v) => v.key === environmentVariable.key);

          return sortedEnvironments.flatMap((env) => {
            const val = variable?.values.find((v) => v.environment.id === env.id);
            const valueRecord = environmentVariable.values.find((v) => v.environmentId === env.id);
            const isSecret = valueRecord?.isSecret ?? false;

            if (!val || !valueRecord) {
              return [];
            }

            const lastUpdatedBy = valueRecord.lastUpdatedBy as EnvironmentVariableUpdater | null;

            const updatedByUser =
              lastUpdatedBy?.type === "user"
                ? (() => {
                    const user = usersRecord[lastUpdatedBy.userId];
                    return user
                      ? {
                          id: user.id,
                          name: user.displayName || user.name || "Unknown",
                          avatarUrl: user.avatarUrl,
                        }
                      : null;
                  })()
                : null;

            return [
              {
                id: environmentVariable.id,
                key: environmentVariable.key,
                environment: { type: env.type, id: env.id, branchName: env.branchName },
                value: isSecret ? "" : val.value,
                isSecret,
                version: valueRecord.version,
                lastUpdatedBy,
                updatedByUser,
                updatedAt: valueRecord.updatedAt,
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
            pullEnvVarsBeforeBuild: vercelPullEnvVarsBeforeBuild,
            syncEnvVarsMapping: vercelSyncEnvVarsMapping,
          }
        : null,
    };
  }
}
