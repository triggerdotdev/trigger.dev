import { Prisma, type RuntimeEnvironmentType } from "@trigger.dev/database";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { $replica, prisma, sqlDatabaseSchema } from "~/db.server";
import type { Project } from "~/models/project.server";
import type { User } from "~/models/user.server";
import {
  compareEnvironmentVariables,
  compareSideValue,
  isCompareRowListed,
  resolveCompareSides,
  type CompareKind,
  type CompareSideInput,
} from "~/v3/environmentVariables/compare";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { emptyEnvironmentVariableValuesEnabled } from "~/v3/environmentVariables/emptyValuesFlag.server";
import {
  loadEnvironmentVariablesEnvironments,
  type EnvironmentVariablesEnvironment,
} from "./environmentVariablesEnvironments.server";
import { getReadableVariableValues } from "./readableVariableValues.server";

const DEFAULT_COMPARE_PAGE_SIZE = 50;

export type EnvironmentVariablesComparison = NonNullable<
  Awaited<ReturnType<EnvironmentVariablesComparePresenter["call"]>>
>;

export type EnvironmentVariablesCompareSide = EnvironmentVariablesComparison["left"];

/**
 * Compares the environment variables of two environments of a project, key by key.
 *
 * The comparison happens here, so a secret never leaves the server: the page gets whether it
 * differs from the other side and nothing else. A side the role can't read isn't read at all.
 */
export class EnvironmentVariablesComparePresenter {
  #prismaClient: PrismaClient;
  #replicaClient: PrismaReplicaClient;

  constructor(prismaClient: PrismaClient = prisma, replicaClient: PrismaReplicaClient = $replica) {
    this.#prismaClient = prismaClient;
    this.#replicaClient = replicaClient;
  }

  /** Undefined when the project has fewer than two environments the user can compare. */
  public async call({
    userId,
    projectId,
    left,
    right,
    currentEnvironmentSlug,
    canRead,
    canWrite = () => false,
    kind,
    search,
    selectedKeys,
    page = 1,
    pageSize = DEFAULT_COMPARE_PAGE_SIZE,
    maxKeys,
  }: {
    userId: User["id"];
    projectId: Project["id"];
    /** The requested sides: dev | stg | prod | preview | branch:<name>. */
    left?: string | null;
    right?: string | null;
    /** The environment the page is opened in: the left side when none is asked for. */
    currentEnvironmentSlug?: string;
    /** Whether the role can read the variables of an environment type. */
    canRead: (environmentType: RuntimeEnvironmentType) => boolean;
    /** Whether the role can write the variables of an environment type: values can be copied to it. */
    canWrite?: (environmentType: RuntimeEnvironmentType) => boolean;
    /** List only this kind. Without one, every key but the same ones is listed. */
    kind?: CompareKind;
    search?: string;
    /** Compare only these keys (at most 100). Without them, every key is compared. */
    selectedKeys?: string[];
    page?: number;
    pageSize?: number;
    /** The most keys compared at once. Above it nothing is read from the secret store. */
    maxKeys: number;
  }) {
    const project = await this.#replicaClient.project.findFirst({
      select: { id: true, organization: { select: { featureFlags: true } } },
      where: { id: projectId, organization: { members: { some: { userId } } } },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const { environments } = await loadEnvironmentVariablesEnvironments(
      this.#replicaClient,
      { userId, projectId: project.id },
      { skipProjectAccessCheck: true }
    );

    const sides = resolveCompareSides({
      environments,
      left,
      right,
      currentEnvironmentId: environments.find((env) => env.slug === currentEnvironmentSlug)?.id,
    });
    if (!sides) {
      return undefined;
    }

    const side = (environment: EnvironmentVariablesEnvironment) => ({
      value: compareSideValue(environment),
      environment,
      isReadable: canRead(environment.type),
      isWritable: canWrite(environment.type),
    });
    const leftSide = side(sides.left);
    const rightSide = side(sides.right);

    // Every value of both sides, with its key. The values are reached through the index on
    // their environment, and a value belongs to its environment's project, so the project
    // condition only narrows the search to this project's keys.
    const storedValues = await this.#replicaClient.$queryRaw<
      Array<{ id: string; key: string; environmentId: string; isSecret: boolean }>
    >`
      SELECT variable."id", variable."key", val."environmentId", val."isSecret"
      FROM ${sqlDatabaseSchema}."EnvironmentVariableValue" AS val
      JOIN ${sqlDatabaseSchema}."EnvironmentVariable" AS variable
        ON variable."id" = val."variableId"
      WHERE val."environmentId" IN (${leftSide.environment.id}, ${rightSide.environment.id})
        AND variable."projectId" = ${project.id}
        ${search ? Prisma.sql`AND variable."key" ILIKE ${`%${search}%`}` : Prisma.empty}
        ${selectedKeys ? Prisma.sql`AND variable."key" = ANY(${selectedKeys})` : Prisma.empty}
      ORDER BY variable."key" ASC
    `;

    // A key's stored values, one per side, before anything is read from the secret store.
    type StoredValue = (typeof storedValues)[number];
    type Entry = { id: string; key: string; left?: StoredValue; right?: StoredValue };
    const keys = new Map<string, Entry>();
    for (const stored of storedValues) {
      const entry = keys.get(stored.id) ?? { id: stored.id, key: stored.key };
      entry[stored.environmentId === leftSide.environment.id ? "left" : "right"] = stored;
      keys.set(stored.id, entry);
    }

    // The selected keys this project has. One set on neither side is still listed, so the user
    // sees it was asked for; a key the project doesn't have is ignored.
    const selectedVariables = selectedKeys
      ? await this.#replicaClient.$queryRaw<Array<{ id: string; key: string }>>`
          SELECT "id", "key" FROM ${sqlDatabaseSchema}."EnvironmentVariable"
          WHERE "projectId" = ${project.id} AND "key" = ANY(${selectedKeys})
        `
      : undefined;
    const lowerSearch = search?.toLowerCase();
    const unsetVariables = (selectedVariables ?? []).filter(
      (variable) =>
        !keys.has(variable.id) && (!lowerSearch || variable.key.toLowerCase().includes(lowerSearch))
    );
    for (const variable of unsetVariables) {
      keys.set(variable.id, { ...variable });
    }

    // A branch against the Preview environment it inherits from: a key set only on Preview is
    // one the branch takes unchanged, not a difference, so the comparison lists exactly the
    // branch's own values.
    const branchSide =
      leftSide.environment.parentEnvironmentId === rightSide.environment.id
        ? "left"
        : rightSide.environment.parentEnvironmentId === leftSide.environment.id
          ? "right"
          : undefined;
    const comparedKeys = [...keys.values()].filter(
      (entry) => !branchSide || entry[branchSide] || (!entry.left && !entry.right)
    );
    if (unsetVariables.length > 0) {
      comparedKeys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }

    const emptyValuesAllowed = await emptyEnvironmentVariableValuesEnabled(
      project.organization.featureFlags,
      this.#prismaClient
    );
    const base = {
      // Every environment the user can see, for the two pickers.
      environments,
      left: leftSide,
      right: rightSide,
      /** Keys left out because a branch side takes them from the other side, its Preview base. */
      inheritedCount: keys.size - comparedKeys.length,
      kind,
      search,
      /** How many of the selected keys the project has, when the comparison is limited to some. */
      selectedKeyCount: selectedVariables?.length,
      /** Whether copying an empty value is allowed: the copy dialog skips empty ones if not. */
      emptyValuesAllowed,
    };

    // Too many keys to compare at once: say so, and read no values at all.
    if (comparedKeys.length > maxKeys) {
      return {
        ...base,
        counts: { different: 0, left: 0, right: 0, empty: 0, same: 0, uncompared: 0, unset: 0 },
        mixedSecretCount: 0,
        rows: [],
        pagination: { currentPage: 1, totalPages: 1, totalCount: 0 },
        tooManyKeys: { count: comparedKeys.length, max: maxKeys },
      };
    }

    // Values are read, secrets included, only where they are needed: they are compared below
    // and go no further. Nothing is read for a side the role can't read.
    const repository = new EnvironmentVariablesRepository(this.#prismaClient, this.#replicaClient);
    const values = new Map<string, string>();
    const readItems = new Set<string>();
    const unavailableEnvironments = new Set<string>();
    const itemKey = (stored: StoredValue) => `${stored.environmentId}:${stored.key}`;
    const isReadable = (stored: StoredValue) =>
      stored.environmentId === leftSide.environment.id ? leftSide.isReadable : rightSide.isReadable;
    const readValues = async (stored: StoredValue[]) => {
      const items = stored
        .filter((s) => isReadable(s) && !readItems.has(itemKey(s)))
        .map((s) => ({ environmentId: s.environmentId, key: s.key }));
      if (items.length === 0) {
        return;
      }
      const read = await getReadableVariableValues(repository, project.id, items);
      for (const item of items) {
        readItems.add(`${item.environmentId}:${item.key}`);
      }
      for (const [key, value] of read.values) {
        values.set(key, value);
      }
      for (const environmentId of read.unavailableEnvironments) {
        unavailableEnvironments.add(environmentId);
      }
    };

    const sideInput = (
      stored: StoredValue | undefined,
      { environment, isReadable }: ReturnType<typeof side>,
      isSetOnBothSides: boolean
    ): CompareSideInput => {
      if (!stored) {
        return undefined;
      }
      if (!isReadable) {
        return { isSecret: false, permissionDenied: true };
      }
      if (unavailableEnvironments.has(environment.id)) {
        return { isSecret: stored.isSecret, valueUnavailable: true };
      }
      // Set on this side only and not read yet: its kind needs no value.
      if (!readItems.has(itemKey(stored))) {
        return { isSecret: stored.isSecret };
      }
      const value = values.get(itemKey(stored));
      if (value === undefined && !stored.isSecret) {
        // As on the list: a value that isn't a secret and can't be read back isn't listed. A
        // key set on one side was already counted under that side, so it says so instead.
        return isSetOnBothSides ? undefined : { isSecret: false, valueUnavailable: true };
      }
      if (value === undefined) {
        // A secret the read doesn't return (a proxy-only one): listed as a secret, never copied.
        return { isSecret: true, unreadable: true };
      }
      return { isSecret: stored.isSecret, value };
    };
    const compareInput = (entry: Entry) => {
      const isSetOnBothSides = entry.left !== undefined && entry.right !== undefined;
      return {
        id: entry.id,
        key: entry.key,
        left: sideInput(entry.left, leftSide, isSetOnBothSides),
        right: sideInput(entry.right, rightSide, isSetOnBothSides),
      };
    };

    // The keys set on both sides need their values to be classified; the others don't.
    await readValues(
      comparedKeys.flatMap((entry) => (entry.left && entry.right ? [entry.left, entry.right] : []))
    );
    const { rows, counts, mixedSecretCount } = compareEnvironmentVariables(
      comparedKeys.map(compareInput)
    );
    const listed = rows.filter((row) => isCompareRowListed(row, kind));
    const totalPages = Math.max(1, Math.ceil(listed.length / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);

    // Then the rest of this page's values, to show them.
    const pageKeys = listed
      .slice((currentPage - 1) * pageSize, currentPage * pageSize)
      .map((row) => keys.get(row.id)!);
    await readValues(
      pageKeys.flatMap((entry) => [entry.left, entry.right].filter((s) => s !== undefined))
    );
    const pageRows = compareEnvironmentVariables(pageKeys.map(compareInput)).rows;

    return {
      ...base,
      counts,
      /** Of the keys not compared, those with a secret on one side and a plain value on the other. */
      mixedSecretCount,
      rows: pageRows,
      pagination: { currentPage, totalPages, totalCount: listed.length },
      /** Set when there are more keys than can be compared at once; nothing is compared then. */
      tooManyKeys: undefined as { count: number; max: number } | undefined,
    };
  }
}
