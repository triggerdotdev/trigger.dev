import { emptyEnvironmentVariableValuesEnabled } from "~/v3/environmentVariables/emptyValuesFlag.server";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { $replica, prisma, sqlDatabaseSchema } from "~/db.server";
import type { Project } from "~/models/project.server";
import type { User } from "~/models/user.server";
import {
  canSortEnvironmentVariablesView,
  selectEnvironmentVariablesFilter,
  type EnvironmentVariablesFilter,
  type EnvironmentVariablesSort,
} from "~/v3/environmentVariables/environmentFilter";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import type { EnvironmentVariableUpdater } from "~/v3/environmentVariables/repository";
import type { SyncEnvVarsMapping, EnvSlug } from "~/v3/vercel/vercelProjectIntegrationSchema";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { loadEnvironmentVariablesEnvironments } from "./environmentVariablesEnvironments.server";
import { getReadableVariableValues } from "./readableVariableValues.server";

import { boundedIn, Prisma } from "@trigger.dev/database";
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
    sort,
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
    /**
     * Without one, keys are listed alphabetically. Only applied to a view
     * `canSortEnvironmentVariablesView` allows; any other view is listed alphabetically.
     */
    sort?: EnvironmentVariablesSort;
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
    const view = selectEnvironmentVariablesFilter({
      environments: sortedEnvironments,
      requested: environmentFilter,
      requestedBranches: branches,
      currentEnvironmentId: currentEnvironment?.id,
      currentEnvironmentType: missingCurrentEnvironment?.type,
    });
    const { filter, environmentIds, branchEnvironmentIds } = view;
    const appliedSort = sort && canSortEnvironmentVariablesView(view) ? sort : undefined;
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

    // Sorted by update time, the page's ids come from the values first, then load like the
    // alphabetical page and keep that order.
    const sortedPageIds = appliedSort
      ? await this.#updatedSortPageIds({
          projectId: project.id,
          environmentIds,
          search,
          direction: appliedSort === "updated" ? "desc" : "asc",
          skip: (currentPage - 1) * pageSize,
          take: pageSize,
        })
      : undefined;

    const loadedVariables = await this.#replicaClient.environmentVariable.findMany({
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
      where: sortedPageIds
        ? { projectId: project.id, id: { in: boundedIn(sortedPageIds) } }
        : variableWhere,
      orderBy: {
        key: "asc",
      },
      ...(sortedPageIds ? {} : { skip: (currentPage - 1) * pageSize, take: pageSize }),
    });
    const environmentVariables = sortedPageIds
      ? sortByIds(loadedVariables, sortedPageIds)
      : loadedVariables;

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

    const { values: variableValuesByEnvAndKey, unavailableEnvironments } =
      await getReadableVariableValues(repository, project.id, nonSecretItems);

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
        const rows = listedEnvironments.flatMap((env) => {
          const valueRecord = environmentVariable.values.find((v) => v.environmentId === env.id);
          const isSecret = valueRecord?.isSecret ?? false;

          if (!valueRecord) {
            return [];
          }

          const val = isSecret
            ? undefined
            : variableValuesByEnvAndKey.get(`${env.id}:${environmentVariable.key}`);

          const valueUnavailable = unavailableEnvironments.has(env.id);
          if (!isSecret && !valueUnavailable && val === undefined) {
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
              value: isSecret || valueUnavailable ? "" : val!,
              ...(valueUnavailable ? { valueUnavailable: true } : {}),
              isSecret,
              version: valueRecord.version,
              lastUpdatedBy,
              updatedByUser,
              updatedAt: valueRecord.updatedAt,
            },
          ];
        });

        // Sorted by update time, a key's own rows follow the same order, so the value that
        // placed the key comes first. Rows with the same time keep the environment order.
        if (appliedSort) {
          const direction = appliedSort === "updated" ? -1 : 1;
          rows.sort((a, b) => direction * (a.updatedAt.getTime() - b.updatedAt.getTime()));
        }

        return rows;
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

  /**
   * One page of variable ids in update order, for a view `canSortEnvironmentVariablesView`
   * allows: one environment, or the Preview base plus one branch. Matches the alphabetical
   * page's filter: keys with a value in one of the environments, and the same case-insensitive
   * key search. Ties are broken by variable id.
   *
   * Every read stays inside the values table, in the order of its
   * (environmentId, updatedAt DESC, variableId) index: newest first walks that index forward and
   * oldest first walks it backward (so the tie-break flips with the direction), and the walk
   * stops once the page is full. Joining the variables, or breaking ties by key, would make the
   * database read every value in view and sort them.
   *
   * The values aren't filtered by project: `environmentIds` are the project's own environments,
   * resolved by the caller from the project, and a value belongs to its environment's project.
   */
  async #updatedSortPageIds({
    projectId,
    environmentIds,
    search,
    direction,
    skip,
    take,
  }: {
    projectId: string;
    environmentIds: string[];
    search?: string;
    direction: "asc" | "desc";
    skip: number;
    take: number;
  }): Promise<string[]> {
    if (environmentIds.length === 0) {
      return [];
    }

    // The same pattern Prisma builds for `contains`, which the count and the alphabetical page
    // use: the search goes in as it is, so `_` and `%` in it are wildcards there and here.
    // `IS TRUE` keeps the search a filter on the walk, checked against the matching ids read
    // once, instead of a join. As a join the planner picks an order from a guess at how many
    // keys match, and a wrong guess reads the index once per key or the keys once per value.
    const searchCondition = search
      ? Prisma.sql`AND (val."variableId" IN (
          SELECT sv."id"
          FROM ${sqlDatabaseSchema}."EnvironmentVariable" AS sv
          WHERE sv."projectId" = ${projectId}
            AND sv."key" ILIKE ${`%${search}%`}
        )) IS TRUE`
      : Prisma.empty;
    const valueOrder =
      direction === "desc"
        ? Prisma.sql`val."updatedAt" DESC, val."variableId" ASC`
        : Prisma.sql`val."updatedAt" ASC, val."variableId" DESC`;

    if (environmentIds.length === 1) {
      const rows = await this.#replicaClient.$queryRaw<{ id: string }[]>`
        SELECT val."variableId" AS "id"
        FROM ${sqlDatabaseSchema}."EnvironmentVariableValue" AS val
        WHERE val."environmentId" = ${environmentIds[0]}
          ${searchCondition}
        ORDER BY ${valueOrder}
        OFFSET ${skip}
        LIMIT ${take}
      `;

      return rows.map((row) => row.id);
    }

    // More than one environment (the Preview base and a branch): a key can have a value in each,
    // and is placed by its newest value (newest first) or its oldest (oldest first). Each
    // environment gives its first `skip + take` values in that order, and the page comes from
    // those. That is the same page as ordering every key: a key on the page is among the first
    // `skip + take` keys overall, so the value that places it is among the first `skip + take`
    // of its own environment, and a key cut short here can only move later, never onto the page.
    const keyOrder =
      direction === "desc"
        ? Prisma.sql`MAX(candidate."updatedAt") DESC, candidate."variableId" ASC`
        : Prisma.sql`MIN(candidate."updatedAt") ASC, candidate."variableId" DESC`;
    const rows = await this.#replicaClient.$queryRaw<{ id: string }[]>`
      SELECT candidate."variableId" AS "id"
      FROM unnest(${environmentIds}::text[]) AS environment("id")
      CROSS JOIN LATERAL (
        SELECT val."variableId", val."updatedAt"
        FROM ${sqlDatabaseSchema}."EnvironmentVariableValue" AS val
        WHERE val."environmentId" = environment."id"
          ${searchCondition}
        ORDER BY ${valueOrder}
        LIMIT ${skip + take}
      ) AS candidate
      GROUP BY candidate."variableId"
      ORDER BY ${keyOrder}
      OFFSET ${skip}
      LIMIT ${take}
    `;

    return rows.map((row) => row.id);
  }
}

function sortByIds<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  return items
    .filter((item) => position.has(item.id))
    .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
}
