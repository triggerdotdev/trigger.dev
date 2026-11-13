import { boundedIn } from "@trigger.dev/database";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { $replica, prisma } from "~/db.server";
import type { Project } from "~/models/project.server";
import type { User } from "~/models/user.server";
import {
  keyPanelEnvironments,
  type EnvironmentVariableKeyCounts,
} from "~/v3/environmentVariables/environmentVariableKey";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import type { EnvironmentVariableUpdater } from "~/v3/environmentVariables/repository";
import type { EnvironmentVariableWithSetValues } from "./EnvironmentVariablesPresenter.server";
import { getReadableVariableValues } from "./readableVariableValues.server";
import {
  loadEnvironmentVariablesEnvironments,
  type EnvironmentVariablesEnvironment,
} from "./environmentVariablesEnvironments.server";

const DEFAULT_BRANCH_PAGE_SIZE = 20;

const valueSelect = {
  id: true,
  environmentId: true,
  version: true,
  lastUpdatedBy: true,
  updatedAt: true,
  isSecret: true,
} as const;

type ValueRecord = {
  id: string;
  environmentId: string;
  version: number;
  lastUpdatedBy: unknown;
  updatedAt: Date;
  isSecret: boolean;
};

type EnvironmentVariableKeyEnvironment = Pick<
  EnvironmentVariablesEnvironment,
  "id" | "type" | "branchName"
>;

export type EnvironmentVariableKeyDetail = {
  key: string;
  /** False when the key has no value in any environment the user can see. */
  exists: boolean;
  /**
   * One entry per environment that isn't a branch (Dev, Staging, the Preview base, Prod), in
   * the page's filter order. `variable` is null where the key isn't set.
   */
  environments: Array<{
    environment: EnvironmentVariableKeyEnvironment;
    variable: EnvironmentVariableWithSetValues | null;
  }>;
  /** One page of the Preview branches that have their own value for the key, by branch name. */
  branches: {
    variables: EnvironmentVariableWithSetValues[];
    search?: string;
    pagination: { currentPage: number; totalPages: number; totalCount: number };
  };
  /** Every Preview branch without its own value for the key, by branch name: the ones an override can be added for. */
  unsetBranches: Array<{ id: string; branchName: string }>;
  counts: EnvironmentVariableKeyCounts;
};

/** Everything one key is set to: its value in each environment and in each Preview branch. */
export class EnvironmentVariableKeyPresenter {
  #prismaClient: PrismaClient;
  #replicaClient: PrismaReplicaClient;

  constructor(prismaClient: PrismaClient = prisma, replicaClient: PrismaReplicaClient = $replica) {
    this.#prismaClient = prismaClient;
    this.#replicaClient = replicaClient;
  }

  public async call({
    userId,
    projectId,
    key,
    branchSearch,
    branchPage = 1,
    branchPageSize = DEFAULT_BRANCH_PAGE_SIZE,
  }: {
    userId: User["id"];
    projectId: Project["id"];
    key: string;
    /** Narrows the branches list to branch names that contain this, ignoring case. */
    branchSearch?: string;
    branchPage?: number;
    branchPageSize?: number;
  }): Promise<EnvironmentVariableKeyDetail> {
    // Checks the user is a member of the project's organization, and leaves out archived
    // branches and other members' dev environments.
    const { environments } = await loadEnvironmentVariablesEnvironments(this.#replicaClient, {
      userId,
      projectId,
    });

    const rowEnvironments = keyPanelEnvironments(environments);
    const branchEnvironments = environments.filter(
      (environment) => environment.type === "PREVIEW" && environment.parentEnvironmentId !== null
    );
    const branchIds = branchEnvironments.map((environment) => environment.id);
    const search = branchSearch?.trim() || undefined;
    const matchingBranchIds = search
      ? branchEnvironments
          .filter((environment) =>
            environment.branchName?.toLowerCase().includes(search.toLowerCase())
          )
          .map((environment) => environment.id)
      : branchIds;

    const hasPreview = rowEnvironments.some((environment) => environment.type === "PREVIEW");
    const empty: EnvironmentVariableKeyDetail = {
      key,
      exists: false,
      environments: rowEnvironments.map((environment) => ({
        environment: toKeyEnvironment(environment),
        variable: null,
      })),
      branches: {
        variables: [],
        search,
        pagination: { currentPage: 1, totalPages: 1, totalCount: 0 },
      },
      unsetBranches: toUnsetBranches(branchEnvironments, new Set()),
      counts: {
        previewBase: hasPreview ? "unset" : "none",
        branchesSet: 0,
        branches: branchEnvironments.length,
      },
    };

    const variable = isStorableKey(key)
      ? await this.#replicaClient.environmentVariable.findFirst({
          select: { id: true, key: true },
          where: { projectId, key },
        })
      : null;

    if (!variable) {
      return empty;
    }

    const countBranchValues = (environmentIds: string[]) =>
      environmentIds.length === 0
        ? 0
        : this.#replicaClient.environmentVariableValue.count({
            where: { variableId: variable.id, environmentId: { in: boundedIn(environmentIds) } },
          });

    // Which branches have their own value: their count, and the rest are the branches an
    // override can be added for.
    const setBranchIdsQuery =
      branchIds.length === 0
        ? Promise.resolve([])
        : this.#replicaClient.environmentVariableValue.findMany({
            select: { environmentId: true },
            where: { variableId: variable.id, environmentId: { in: boundedIn(branchIds) } },
          });

    const [environmentValues, setBranchValues, matchingBranchesSet] = await Promise.all([
      this.#replicaClient.environmentVariableValue.findMany({
        select: valueSelect,
        where: {
          variableId: variable.id,
          environmentId: { in: boundedIn(rowEnvironments.map((environment) => environment.id)) },
        },
      }),
      setBranchIdsQuery,
      search ? countBranchValues(matchingBranchIds) : undefined,
    ]);
    const setBranchIds = new Set(setBranchValues.map((value) => value.environmentId));
    const branchesSet = setBranchIds.size;

    if (environmentValues.length === 0 && branchesSet === 0) {
      return empty;
    }

    const totalCount = matchingBranchesSet ?? branchesSet;
    const totalPages = Math.max(1, Math.ceil(totalCount / branchPageSize));
    const currentPage = Math.min(Math.max(1, branchPage), totalPages);

    const branchValues =
      totalCount === 0
        ? []
        : await this.#replicaClient.environmentVariableValue.findMany({
            select: valueSelect,
            where: {
              variableId: variable.id,
              environmentId: { in: boundedIn(matchingBranchIds) },
            },
            orderBy: [{ environment: { branchName: "asc" } }, { environmentId: "asc" }],
            skip: (currentPage - 1) * branchPageSize,
            take: branchPageSize,
          });

    const values: ValueRecord[] = [...environmentValues, ...branchValues];

    const repository = new EnvironmentVariablesRepository(this.#prismaClient, this.#replicaClient);
    const [{ values: plainValues, unavailableEnvironments }, usersById] = await Promise.all([
      getReadableVariableValues(
        repository,
        projectId,
        values
          .filter((value) => !value.isSecret)
          .map((value) => ({ environmentId: value.environmentId, key: variable.key }))
      ),
      this.#usersById(values),
    ]);

    const environmentsById = new Map(
      environments.map((environment) => [environment.id, environment])
    );

    const toVariable = (value: ValueRecord): EnvironmentVariableWithSetValues | null => {
      const environment = environmentsById.get(value.environmentId);
      // The value is set, but its environment's encryption key can't be used right now: the row
      // stays, without a value, as in the list.
      const valueUnavailable = !value.isSecret && unavailableEnvironments.has(value.environmentId);
      const plainValue =
        value.isSecret || valueUnavailable
          ? ""
          : plainValues.get(`${value.environmentId}:${variable.key}`);

      // A value record without a stored value is treated as not set, as the list does.
      if (!environment || plainValue === undefined) {
        return null;
      }

      const lastUpdatedBy = value.lastUpdatedBy as EnvironmentVariableUpdater | null;
      const user = lastUpdatedBy?.type === "user" ? usersById.get(lastUpdatedBy.userId) : undefined;

      return {
        id: variable.id,
        key: variable.key,
        environment: toKeyEnvironment(environment),
        value: plainValue,
        ...(valueUnavailable ? { valueUnavailable: true } : {}),
        isSecret: value.isSecret,
        version: value.version,
        lastUpdatedBy,
        updatedByUser: user
          ? {
              id: user.id,
              name: user.displayName || user.name || "Unknown",
              avatarUrl: user.avatarUrl,
            }
          : null,
        updatedAt: value.updatedAt,
      };
    };

    const environmentRows = rowEnvironments.map((environment) => {
      const value = environmentValues.find((v) => v.environmentId === environment.id);
      return {
        environment: toKeyEnvironment(environment),
        variable: value ? toVariable(value) : null,
      };
    });

    const previewBase = environmentRows.find((row) => row.environment.type === "PREVIEW");

    return {
      key: variable.key,
      exists: true,
      environments: environmentRows,
      branches: {
        variables: branchValues
          .map(toVariable)
          .filter((v): v is EnvironmentVariableWithSetValues => v !== null),
        search,
        pagination: { currentPage, totalPages, totalCount },
      },
      unsetBranches: toUnsetBranches(branchEnvironments, setBranchIds),
      counts: {
        previewBase: previewBase ? (previewBase.variable ? "set" : "unset") : "none",
        branchesSet,
        branches: branchEnvironments.length,
      },
    };
  }

  /**
   * Whether the key has a value in any environment the user can see. Reads the primary, so it
   * is right straight after a delete.
   */
  public async isSet({
    userId,
    projectId,
    key,
  }: {
    userId: User["id"];
    projectId: Project["id"];
    key: string;
  }): Promise<boolean> {
    const { environments } = await loadEnvironmentVariablesEnvironments(this.#replicaClient, {
      userId,
      projectId,
    });

    const variable = isStorableKey(key)
      ? await this.#prismaClient.environmentVariable.findFirst({
          select: { id: true },
          where: { projectId, key },
        })
      : null;
    if (!variable) {
      return false;
    }

    const value = await this.#prismaClient.environmentVariableValue.findFirst({
      select: { id: true },
      where: {
        variableId: variable.id,
        environmentId: { in: boundedIn(environments.map((environment) => environment.id)) },
      },
    });

    return value !== null;
  }

  async #usersById(values: ValueRecord[]) {
    const userIds = new Set<string>();
    for (const value of values) {
      const lastUpdatedBy = value.lastUpdatedBy as EnvironmentVariableUpdater | null;
      if (lastUpdatedBy?.type === "user" && typeof lastUpdatedBy.userId === "string") {
        userIds.add(lastUpdatedBy.userId);
      }
    }

    const users =
      userIds.size > 0
        ? await this.#replicaClient.user.findMany({
            where: { id: { in: boundedIn(Array.from(userIds)) } },
            select: { id: true, name: true, displayName: true, avatarUrl: true },
          })
        : [];

    return new Map(users.map((user) => [user.id, user]));
  }
}

// Postgres can't store a null byte in text and rejects a query that compares against one, so
// a key from the URL with one in it is a key that isn't set, not an error.
function isStorableKey(key: string): boolean {
  return !key.includes("\0");
}

function toKeyEnvironment(
  environment: EnvironmentVariablesEnvironment
): EnvironmentVariableKeyEnvironment {
  return { id: environment.id, type: environment.type, branchName: environment.branchName };
}

function toUnsetBranches(
  branchEnvironments: EnvironmentVariablesEnvironment[],
  setBranchIds: Set<string>
): EnvironmentVariableKeyDetail["unsetBranches"] {
  return branchEnvironments
    .flatMap((environment) =>
      environment.branchName !== null && !setBranchIds.has(environment.id)
        ? [{ id: environment.id, branchName: environment.branchName }]
        : []
    )
    .sort((a, b) => a.branchName.localeCompare(b.branchName));
}
