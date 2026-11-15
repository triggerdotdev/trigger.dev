import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { $replica, prisma, type PrismaClient, type PrismaReplicaClient } from "~/db.server";
import {
  ATTENTION_KINDS,
  attentionTargetEnvironment,
  missingAttentionSources,
  IGNORABLE_ATTENTION_KINDS,
  IGNORED_ATTENTION_VIEW,
  RECENT_ATTENTION_WINDOW_MS,
  type AttentionKind,
  type AttentionView,
  type IgnorableAttentionKind,
} from "~/v3/environmentVariables/attention";
import { emptyEnvironmentVariableValuesEnabled } from "~/v3/environmentVariables/emptyValuesFlag.server";
import { filterForEnvironmentType } from "~/v3/environmentVariables/environmentFilter";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { OIDC_REPLACEABLE_KEYS } from "~/v3/environmentVariables/oidcReplaceable";
import type { EnvironmentVariableUpdater } from "~/v3/environmentVariables/repository";
import {
  attentionKeysPage,
  countAttentionKeys,
  findEmptyValues,
  type AttentionCounts,
} from "./environmentVariablesAttention.server";
import { loadEnvironmentVariablesEnvironments } from "./environmentVariablesEnvironments.server";
import { getReadableVariableValues } from "./readableVariableValues.server";

const ATTENTION_PAGE_SIZE = 50;

const IGNORED_FLAGS = {
  empty: "ignoredEmpty",
  missing: "ignoredMissing",
  oidc: "ignoredOidc",
} as const satisfies Record<IgnorableAttentionKind, string>;

type ListedEnvironment = { type: RuntimeEnvironmentType; id: string; branchName: string | null };

/** A key needing attention in the page's environment: its value there, or where it is set. */
export type AttentionRow = {
  id: string;
  key: string;
  environment: ListedEnvironment;
  /** Empty for a secret, a value that couldn't be read, and a key not set here. */
  value: string;
  valueUnavailable?: true;
  isSecret: boolean;
  /** A secret known to be empty. */
  emptySecret?: true;
  version: number;
  lastUpdatedBy: EnvironmentVariableUpdater | null;
  updatedByUser: { id: string; name: string; avatarUrl: string | null } | null;
  updatedAt: Date;
  /** The kinds still needing attention, without the ignored ones. */
  kinds: AttentionKind[];
  /** The kinds the team ignored that would otherwise show. Who and when only in the Ignored view. */
  ignored: Array<{
    kind: IgnorableAttentionKind;
    createdAt?: Date;
    createdBy?: { name: string; avatarUrl: string | null } | null;
  }>;
  /** "Missing here": the key isn't set in this environment, and where it is set. */
  notSetHere?: { setIn: ListedEnvironment[] };
};

export type EnvironmentVariablesAttention = Awaited<
  ReturnType<EnvironmentVariablesAttentionPresenter["call"]>
>;

/**
 * The keys of one environment that need attention: empty, missing here, changed recently, or
 * replaceable with OIDC. Only Empty decrypts values: every value of the environment, up to
 * `maxKeys`.
 */
export class EnvironmentVariablesAttentionPresenter {
  #prismaClient: PrismaClient;
  #replicaClient: PrismaReplicaClient;

  constructor(prismaClient: PrismaClient = prisma, replicaClient: PrismaReplicaClient = $replica) {
    this.#prismaClient = prismaClient;
    this.#replicaClient = replicaClient;
  }

  public async call({
    userId,
    projectId,
    env,
    branches = [],
    currentEnvironmentSlug,
    kind,
    search,
    page = 1,
    pageSize = ATTENTION_PAGE_SIZE,
    canRead = () => true,
    canWrite = () => true,
    maxKeys = 1_000,
    isOidcEnabled = async () => false,
  }: {
    userId: string;
    projectId: string;
    /** The `env` search param: dev, stg, prod, preview, or a full name. */
    env?: string;
    /** The `branch` search params of the list the page was opened from. */
    branches?: string[];
    currentEnvironmentSlug?: string;
    /** Undefined lists every kind; `ignored`, the ignored reasons. */
    kind?: AttentionView;
    search?: string;
    page?: number;
    pageSize?: number;
    canRead?: (type: RuntimeEnvironmentType) => boolean;
    canWrite?: (type: RuntimeEnvironmentType) => boolean;
    /** The most values Empty decrypts in one request. */
    maxKeys?: number;
    isOidcEnabled?: (orgFeatureFlags: unknown) => Promise<boolean>;
  }) {
    const project = await this.#replicaClient.project.findFirst({
      select: { id: true, organization: { select: { featureFlags: true } } },
      where: { id: projectId, organization: { members: { some: { userId } } } },
    });
    if (!project) {
      throw new Error("Project not found");
    }

    const { environments, hasStaging } = await loadEnvironmentVariablesEnvironments(
      this.#replicaClient,
      { userId, projectId },
      { skipProjectAccessCheck: true }
    );
    const currentEnvironment = environments.find((e) => e.slug === currentEnvironmentSlug);
    // An archived branch isn't in the list, but its URL still opens the page.
    const missingCurrentEnvironment =
      currentEnvironmentSlug && !currentEnvironment
        ? await this.#replicaClient.runtimeEnvironment.findFirst({
            select: { type: true },
            where: { projectId, slug: currentEnvironmentSlug },
          })
        : null;
    const target = attentionTargetEnvironment({
      environments,
      env,
      branches,
      currentEnvironmentId: currentEnvironment?.id,
      currentEnvironmentType: missingCurrentEnvironment?.type,
    });

    const writableEnvironmentIds = environments.filter((e) => canWrite(e.type)).map((e) => e.id);
    const allowEmptyEnvironmentVariableValues = await emptyEnvironmentVariableValuesEnabled(
      project.organization.featureFlags,
      this.#prismaClient
    );
    // What the create dialog over the key panel reads, as from the list filtered to the target.
    const shared = {
      environments,
      hasStaging,
      writableEnvironmentIds,
      allowEmptyEnvironmentVariableValues,
      filter: target ? filterForEnvironmentType(target.type) : ("all" as const),
      filterEnvironmentIds: target ? [target.id] : [],
      filterBranchEnvironmentIds: [] as string[],
    };

    if (!target || !canRead(target.type)) {
      return { ...shared, target, isReadable: false as const };
    }

    // OIDC tokens aren't available in Development.
    const hasOidc =
      target.type !== "DEVELOPMENT" && (await isOidcEnabled(project.organization.featureFlags));
    const sources = missingAttentionSources(target, environments);

    // This page is opened on purpose, so Empty is read on load.
    const emptyValues = await findEmptyValues(this.#prismaClient, this.#replicaClient, {
      projectId,
      environmentId: target.id,
      search,
      maxKeys,
    });
    const emptyIds = emptyValues.kind === "ok" ? emptyValues.values.map((v) => v.id) : undefined;

    const conditions = {
      projectId,
      targetId: target.id,
      missingSourceIds: sources.map((source) => source.id),
      recentSince: new Date(Date.now() - RECENT_ATTENTION_WINDOW_MS),
      oidcKeys: hasOidc ? OIDC_REPLACEABLE_KEYS : undefined,
      emptyIds,
      search,
    };
    const counts: AttentionCounts = await countAttentionKeys(this.#replicaClient, conditions);
    // Kinds this environment doesn't have list nothing.
    const appliedKind = kind === "oidc" && !hasOidc ? undefined : kind;
    const totalCount = counts[appliedKind ?? "all"];
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const currentPage = Math.min(page, totalPages);

    const pageKeys = await attentionKeysPage(this.#replicaClient, {
      ...conditions,
      kind: appliedKind,
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
    });
    const rows = await this.#rows(
      projectId,
      target,
      sources,
      pageKeys,
      new Set(emptyIds),
      appliedKind === IGNORED_ATTENTION_VIEW
    );

    return {
      ...shared,
      target,
      isReadable: true as const,
      hasOidc,
      kind: appliedKind,
      counts,
      emptyProblem: emptyValues.kind === "ok" ? undefined : emptyValues,
      // The environments a Missing here key can be set in, and those the role can copy from.
      sources,
      readableSourceIds: sources.filter((source) => canRead(source.type)).map((s) => s.id),
      rows,
      pagination: { currentPage, totalPages, totalCount },
    };
  }

  async #rows(
    projectId: string,
    target: ListedEnvironment,
    sources: ListedEnvironment[],
    pageKeys: Awaited<ReturnType<typeof attentionKeysPage>>,
    emptyIds: Set<string>,
    withIgnoredBy: boolean
  ): Promise<AttentionRow[]> {
    if (pageKeys.length === 0) {
      return [];
    }
    const ignores = withIgnoredBy
      ? await this.#replicaClient.environmentVariableIgnore.findMany({
          select: {
            variableId: true,
            reason: true,
            createdAt: true,
            createdBy: { select: { name: true, displayName: true, avatarUrl: true } },
          },
          where: {
            environmentId: target.id,
            variableId: { in: boundedIn(pageKeys.map((row) => row.id)) },
          },
        })
      : [];
    const ignoredBy = new Map(
      ignores.map((ignore) => [`${ignore.variableId}:${ignore.reason.toLowerCase()}`, ignore])
    );
    const ignoredOf = (pageKey: (typeof pageKeys)[number]): AttentionRow["ignored"] =>
      IGNORABLE_ATTENTION_KINDS.filter((k) => pageKey[IGNORED_FLAGS[k]]).map((k) => {
        const ignore = ignoredBy.get(`${pageKey.id}:${k}`);
        return ignore
          ? {
              kind: k,
              createdAt: ignore.createdAt,
              createdBy: ignore.createdBy
                ? {
                    name: ignore.createdBy.displayName || ignore.createdBy.name || "Unknown",
                    avatarUrl: ignore.createdBy.avatarUrl,
                  }
                : null,
            }
          : { kind: k };
      });
    const variables = await this.#replicaClient.environmentVariable.findMany({
      select: {
        id: true,
        key: true,
        values: {
          select: {
            environmentId: true,
            version: true,
            lastUpdatedBy: true,
            updatedAt: true,
            isSecret: true,
          },
          where: {
            environmentId: { in: boundedIn([target.id, ...sources.map((source) => source.id)]) },
          },
        },
      },
      where: { projectId, id: { in: boundedIn(pageKeys.map((row) => row.id)) } },
    });
    const byId = new Map(variables.map((variable) => [variable.id, variable]));

    const userIds = new Set<string>();
    for (const variable of variables) {
      for (const value of variable.values) {
        const updater = value.lastUpdatedBy as EnvironmentVariableUpdater | null;
        if (value.environmentId === target.id && updater?.type === "user") {
          userIds.add(updater.userId);
        }
      }
    }
    const users =
      userIds.size > 0
        ? await this.#replicaClient.user.findMany({
            where: { id: { in: boundedIn([...userIds]) } },
            select: { id: true, name: true, displayName: true, avatarUrl: true },
          })
        : [];
    const usersById = new Map(users.map((user) => [user.id, user]));

    const repository = new EnvironmentVariablesRepository(this.#prismaClient, this.#replicaClient);
    const { values, unavailableEnvironments } = await getReadableVariableValues(
      repository,
      projectId,
      variables
        .filter((variable) =>
          variable.values.some((v) => v.environmentId === target.id && !v.isSecret)
        )
        .map((variable) => ({ environmentId: target.id, key: variable.key }))
    );
    const valueUnavailable = unavailableEnvironments.has(target.id);
    const environment = { type: target.type, id: target.id, branchName: target.branchName };

    return pageKeys.flatMap((pageKey): AttentionRow[] => {
      const variable = byId.get(pageKey.id);
      if (!variable) {
        return [];
      }
      const kinds = ATTENTION_KINDS.filter((k) => pageKey[k]);
      const record = variable.values.find((v) => v.environmentId === target.id);
      if (!record) {
        return [
          {
            id: variable.id,
            key: variable.key,
            environment,
            value: "",
            isSecret: false,
            version: 0,
            lastUpdatedBy: null,
            updatedByUser: null,
            updatedAt: new Date(0),
            kinds,
            ignored: ignoredOf(pageKey),
            notSetHere: {
              setIn: sources
                .filter((source) => variable.values.some((v) => v.environmentId === source.id))
                .map((source) => ({
                  type: source.type,
                  id: source.id,
                  branchName: source.branchName,
                })),
            },
          },
        ];
      }

      const value = record.isSecret ? undefined : values.get(`${target.id}:${variable.key}`);
      // A plain value the read didn't return (a proxy-only secret) isn't shown, as on the list.
      if (!record.isSecret && !valueUnavailable && value === undefined) {
        return [];
      }
      const lastUpdatedBy = record.lastUpdatedBy as EnvironmentVariableUpdater | null;
      const user = lastUpdatedBy?.type === "user" ? usersById.get(lastUpdatedBy.userId) : undefined;
      return [
        {
          id: variable.id,
          key: variable.key,
          environment,
          value: record.isSecret || valueUnavailable ? "" : value!,
          ...(valueUnavailable ? { valueUnavailable: true as const } : {}),
          ...(record.isSecret && emptyIds.has(variable.id) ? { emptySecret: true as const } : {}),
          isSecret: record.isSecret,
          version: record.version,
          lastUpdatedBy,
          updatedByUser: user
            ? {
                id: user.id,
                name: user.displayName || user.name || "Unknown",
                avatarUrl: user.avatarUrl,
              }
            : null,
          updatedAt: record.updatedAt,
          kinds,
          ignored: ignoredOf(pageKey),
        },
      ];
    });
  }
}
