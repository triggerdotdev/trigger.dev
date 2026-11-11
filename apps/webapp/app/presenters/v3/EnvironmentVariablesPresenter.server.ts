import { emptyEnvironmentVariableValuesEnabled } from "~/v3/environmentVariables/emptyValuesFlag.server";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { $replica, prisma } from "~/db.server";
import type { Project } from "~/models/project.server";
import type { User } from "~/models/user.server";
import {
  selectEnvironmentVariablesFilter,
  type EnvironmentVariablesFilter,
} from "~/v3/environmentVariables/environmentFilter";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import type { EnvironmentVariableUpdater } from "~/v3/environmentVariables/repository";
import type { SyncEnvVarsMapping, EnvSlug } from "~/v3/vercel/vercelProjectIntegrationSchema";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { loadEnvironmentVariablesEnvironments } from "./environmentVariablesEnvironments.server";

import { boundedIn, type Prisma } from "@trigger.dev/database";
type Result = Awaited<ReturnType<EnvironmentVariablesPresenter["call"]>>;
export type EnvironmentVariableWithSetValues = Result["environmentVariables"][number];

const DEFAULT_ENV_VARS_PAGE_SIZE = 50;

export class EnvironmentVariablesPresenter {
  #prismaClient: PrismaClient;
  #replicaClient: PrismaReplicaClient;

  constructor(prismaClient: PrismaClient = prisma, replicaClient: PrismaReplicaClient = $replica) {
    this.#prismaClient = prismaClient;
    this.#replicaClient = replicaClient;
  }

  public async call({
    userId,
    projectId,
    page = 1,
    pageSize = DEFAULT_ENV_VARS_PAGE_SIZE,
    search,
    environmentFilter,
    branches,
    currentEnvironmentSlug,
  }: {
    userId: User["id"];
    projectId: Project["id"];
    page?: number;
    pageSize?: number;
    search?: string;
    /** The requested filter. Without one, the current environment's type is used. */
    environmentFilter?: EnvironmentVariablesFilter;
    /** Preview branch names, or `ALL_BRANCHES`. Only used by the Preview filter. */
    branches?: string[];
    /** The environment the page is opened in. Without one, every environment is listed. */
    currentEnvironmentSlug?: string;
  }) {
    const project = await this.#replicaClient.project.findFirst({
      select: {
        id: true,
        organization: { select: { featureFlags: true } },
      },
      where: {
        id: projectId,
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

    const { environments: sortedEnvironments, hasStaging } =
      await loadEnvironmentVariablesEnvironments(
        this.#replicaClient,
        { userId, projectId: project.id },
        { skipProjectAccessCheck: true }
      );

    // Narrow to the filtered environments before counting and paging, so the totals and the
    // pages follow the filter. Archived branch environments are never in this list, so the
    // values projects accumulate in them are never loaded.
    const currentEnvironment = currentEnvironmentSlug
      ? sortedEnvironments.find((env) => env.slug === currentEnvironmentSlug)
      : undefined;
    // An archived branch isn't in the list, but its URL still opens the page: default to its type.
    const missingCurrentEnvironment =
      currentEnvironmentSlug && !currentEnvironment
        ? await this.#replicaClient.runtimeEnvironment.findFirst({
            select: { type: true },
            where: { projectId: project.id, slug: currentEnvironmentSlug },
          })
        : null;
    const { filter, environmentIds, branchEnvironmentIds } = selectEnvironmentVariablesFilter({
      environments: sortedEnvironments,
      requested: environmentFilter,
      requestedBranches: branches,
      currentEnvironmentId: currentEnvironment?.id,
      currentEnvironmentType: missingCurrentEnvironment?.type,
    });
    const filteredEnvironmentIds = new Set(environmentIds);
    const listedEnvironments = sortedEnvironments.filter((env) =>
      filteredEnvironmentIds.has(env.id)
    );

    const variableWhere: Prisma.EnvironmentVariableWhereInput = {
      projectId: project.id,
      values: { some: { environmentId: { in: boundedIn(environmentIds) } } },
      ...(search ? { key: { contains: search, mode: "insensitive" } } : {}),
    };

    const totalCount = await this.#replicaClient.environmentVariable.count({
      where: variableWhere,
    });
    // A project with no variables in any listed environment gets the first-run empty state
    // whatever the filter is. Only an unsearched view with nothing in it has to look further.
    const projectHasNoVariables =
      totalCount === 0 &&
      !search &&
      (filter === "all" ||
        (await this.#replicaClient.environmentVariable.findFirst({
          select: { id: true },
          where: {
            projectId: project.id,
            values: {
              some: { environmentId: { in: boundedIn(sortedEnvironments.map((env) => env.id)) } },
            },
          },
        })) === null);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);

    const environmentVariables = await this.#replicaClient.environmentVariable.findMany({
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
            isSecret: true,
          },
          where: {
            environmentId: {
              in: boundedIn(environmentIds),
            },
          },
        },
      },
      where: variableWhere,
      orderBy: {
        key: "asc",
      },
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
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
        ? await this.#replicaClient.user.findMany({
            where: {
              id: {
                in: boundedIn(Array.from(userIds)),
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

    const usersRecord: Record<
      string,
      { id: string; name: string | null; displayName: string | null; avatarUrl: string | null }
    > = Object.fromEntries(users.map((u) => [u.id, u]));

    const repository = new EnvironmentVariablesRepository(this.#prismaClient, this.#replicaClient);

    const nonSecretItems: Array<{ environmentId: string; key: string }> = [];
    for (const environmentVariable of environmentVariables) {
      for (const env of listedEnvironments) {
        const valueRecord = environmentVariable.values.find((v) => v.environmentId === env.id);
        if (valueRecord && !valueRecord.isSecret) {
          nonSecretItems.push({ environmentId: env.id, key: environmentVariable.key });
        }
      }
    }

    const variableValuesByEnvAndKey = await repository.getVariableValuesForKeys(
      project.id,
      nonSecretItems
    );

    // Get Vercel integration data if it exists
    const vercelService = new VercelIntegrationService(this.#prismaClient);
    const vercelIntegration = await vercelService.getVercelProjectIntegration(project.id);

    let vercelSyncEnvVarsMapping: SyncEnvVarsMapping = {};
    let vercelPullEnvVarsBeforeBuild: EnvSlug[] | null = null;

    if (vercelIntegration) {
      vercelSyncEnvVarsMapping = vercelIntegration.parsedIntegrationData.syncEnvVarsMapping;
      vercelPullEnvVarsBeforeBuild =
        vercelIntegration.parsedIntegrationData.config.pullEnvVarsBeforeBuild ?? null;
    }

    return {
      allowEmptyEnvironmentVariableValues: await emptyEnvironmentVariableValuesEnabled(
        project.organization.featureFlags,
        this.#prismaClient
      ),
      environmentVariables: environmentVariables.flatMap((environmentVariable) => {
        return listedEnvironments.flatMap((env) => {
          const valueRecord = environmentVariable.values.find((v) => v.environmentId === env.id);
          const isSecret = valueRecord?.isSecret ?? false;

          if (!valueRecord) {
            return [];
          }

          const val = isSecret
            ? undefined
            : variableValuesByEnvAndKey.get(`${env.id}:${environmentVariable.key}`);

          if (!isSecret && val === undefined) {
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
              value: isSecret ? "" : val!,
              isSecret,
              version: valueRecord.version,
              lastUpdatedBy,
              updatedByUser,
              updatedAt: valueRecord.updatedAt,
            },
          ];
        });
      }),
      // Every environment, not only the listed ones: the page needs them all for its filter
      // options, its permission lists and the create dialog.
      environments: sortedEnvironments,
      filter,
      filterEnvironmentIds: environmentIds,
      filterBranchEnvironmentIds: branchEnvironmentIds ?? [],
      projectHasNoVariables,
      hasStaging,
      pagination: {
        currentPage,
        totalPages,
        totalCount,
      },
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
