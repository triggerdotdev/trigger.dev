import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";
import {
  environmentTypeForFilter,
  filterForEnvironmentType,
  listViewSearch,
  parseEnvironmentVariablesFilter,
} from "./environmentFilter";
import { EnvironmentVariableKey } from "./repository";

// The compare view's own search params, next to `search` and `page`.
export const COMPARE_LEFT_PARAM = "left";
export const COMPARE_RIGHT_PARAM = "right";
export const COMPARE_KIND_PARAM = "kind";
// Repeated, one per key: limits the comparison to those keys.
export const COMPARE_KEY_PARAM = "key";

/** The most keys a comparison can be limited to: the list's selection limit. */
const COMPARE_SELECTED_KEYS_LIMIT = 100;

const CompareSelectedKeys = z
  .array(z.string())
  .transform((keys) =>
    [...new Set(keys.filter((key) => EnvironmentVariableKey.safeParse(key).success))].slice(
      0,
      COMPARE_SELECTED_KEYS_LIMIT
    )
  );

/**
 * The keys a comparison is limited to, from the repeated `key` param: well-formed keys only,
 * without repeats, the first 100. Undefined when none are asked for (every key is compared).
 */
export function parseCompareSelectedKeys(values: string[]): string[] | undefined {
  const keys = CompareSelectedKeys.parse(values);
  return keys.length > 0 ? keys : undefined;
}

// Well under Node's 16 KB limit on a request's headers, which the URL and the cookies share.
const COMPARE_LINK_MAX_LENGTH = 8_000;

/**
 * The list's Compare for the ticked keys, which go into the URL: a link, or disabled with why
 * when the URL would be too long for a request (keys have no length limit).
 */
export function compareSelectedLink(
  path: string
): { to: string } | { disabled: true; disabledReason: string } {
  return path.length <= COMPARE_LINK_MAX_LENGTH
    ? { to: path }
    : {
        disabled: true,
        disabledReason: "These keys are too long to compare together. Tick fewer keys.",
      };
}

/**
 * The compare view's search params from a URL (or its search params), as a query string ("?..."
 * or ""): the sides, the kind, the selected keys, the search and the page, and the list's filter to go
 * back to. Other params (the key panel's own) are dropped.
 */
export function compareViewSearch(url: string | URL | URLSearchParams): string {
  return listViewSearch(url, [
    COMPARE_LEFT_PARAM,
    COMPARE_RIGHT_PARAM,
    COMPARE_KIND_PARAM,
    COMPARE_KEY_PARAM,
  ]);
}

type CompareEnvironment = {
  id: string;
  type: RuntimeEnvironmentType;
  parentEnvironmentId: string | null;
  branchName: string | null;
};

const BRANCH_SIDE_PREFIX = "branch:";

function isPreviewBranch(environment: CompareEnvironment): boolean {
  return (
    environment.type === "PREVIEW" &&
    environment.parentEnvironmentId !== null &&
    environment.branchName !== null
  );
}

/** The environments a side can be: every one that isn't a branch, and each Preview branch. */
export function compareSideEnvironments<T extends CompareEnvironment>(environments: T[]): T[] {
  return environments.filter(
    (environment) => environment.parentEnvironmentId === null || isPreviewBranch(environment)
  );
}

/**
 * An environment as a `left` or `right` value: the list's `env` values (dev, stg, prod, and
 * preview for the Preview base), or `branch:<name>` for a Preview branch.
 */
export function compareSideValue(environment: CompareEnvironment): string {
  return isPreviewBranch(environment)
    ? `${BRANCH_SIDE_PREFIX}${environment.branchName}`
    : filterForEnvironmentType(environment.type);
}

function findCompareSide<T extends CompareEnvironment>(
  environments: T[],
  value: string | null | undefined
): T | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith(BRANCH_SIDE_PREFIX)) {
    const name = value.slice(BRANCH_SIDE_PREFIX.length);
    return environments.find(
      (environment) => isPreviewBranch(environment) && environment.branchName === name
    );
  }
  const filter = parseEnvironmentVariablesFilter(value);
  if (!filter || filter === "all") {
    return undefined;
  }
  const type = environmentTypeForFilter(filter);
  return environments.find(
    (environment) => environment.type === type && environment.parentEnvironmentId === null
  );
}

/** The right side a left side starts against: Prod, or Staging when the left is Prod. */
function defaultCompareRight<T extends CompareEnvironment>(
  environments: T[],
  left: T
): T | undefined {
  const order: RuntimeEnvironmentType[] = ["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"];
  for (const type of order) {
    const environment = environments.find(
      (candidate) =>
        candidate.type === type &&
        candidate.parentEnvironmentId === null &&
        candidate.id !== left.id
    );
    if (environment) {
      return environment;
    }
  }
  return undefined;
}

/**
 * The two environments to compare. An unknown left is the current environment (or, when that
 * can't be a side, the first one that can). An unknown right, or one equal to the left, is the
 * left's default. Undefined when the project has fewer than two environments to compare.
 */
export function resolveCompareSides<T extends CompareEnvironment>({
  environments,
  left,
  right,
  currentEnvironmentId,
}: {
  /** The environments the user can see. */
  environments: T[];
  left?: string | null;
  right?: string | null;
  currentEnvironmentId?: string;
}): { left: T; right: T } | undefined {
  const sides = compareSideEnvironments(environments);
  const resolvedLeft =
    findCompareSide(sides, left) ??
    sides.find((environment) => environment.id === currentEnvironmentId) ??
    sides[0];
  if (!resolvedLeft) {
    return undefined;
  }

  const requestedRight = findCompareSide(sides, right);
  const resolvedRight =
    requestedRight && requestedRight.id !== resolvedLeft.id
      ? requestedRight
      : defaultCompareRight(sides, resolvedLeft);
  if (!resolvedRight) {
    return undefined;
  }

  return { left: resolvedLeft, right: resolvedRight };
}

// The kinds a key can be listed under, which are also the values of the `kind` search param.
const COMPARE_KINDS = ["different", "left", "right", "empty", "same"] as const;

/**
 * How a key differs between the two sides. `left` and `right`: set on that side only. `empty`:
 * set on both, and one side is an empty string (secret or not) while the other has a value. `different`: any other
 * two values that aren't equal. `same`: two equal values.
 */
export type CompareKind = (typeof COMPARE_KINDS)[number];

/**
 * A key has exactly one of these. `uncompared`: set on both sides, but a side's value can't be
 * read (no permission, or its encryption key is unavailable), so nothing is said about it.
 * `unset`: a selected key set on neither side.
 */
export type CompareRowKind = CompareKind | "uncompared" | "unset";

export function parseCompareKind(value: unknown): CompareKind | undefined {
  return COMPARE_KINDS.find((kind) => kind === value);
}

/**
 * One side's stored value for a key, as the server read it. `value` is undefined when it
 * couldn't be read. Undefined altogether when the key isn't set on that side.
 */
export type CompareSideInput =
  | {
      isSecret: boolean;
      value?: string;
      /** The role can't read this side's environment: nothing about the value is known. */
      permissionDenied?: boolean;
      /** The environment's encryption key is unavailable. */
      valueUnavailable?: boolean;
      /** A secret that was read but has no value to give (a proxy-only secret). */
      unreadable?: boolean;
    }
  | undefined;

/**
 * One side of a row as the page gets it. A secret's value is never in it, only whether it
 * differs from the other side: no length and nothing derived from the value.
 */
export type CompareCell =
  | { isSet: false }
  | {
      isSet: true;
      /** Empty for a secret and for a value that couldn't be read. */
      value: string;
      isSecret: boolean;
      permissionDenied?: true;
      valueUnavailable?: true;
      /** A secret that isn't equal to the other side's value. */
      differs?: true;
      /** A secret set to an empty string. Nothing else about a secret's value is sent. */
      emptySecret?: true;
      /** A secret whose value can't be read (a proxy-only secret), so it can't be copied. */
      unreadable?: true;
    };

export type CompareRow = {
  id: string;
  key: string;
  kind: CompareRowKind;
  left: CompareCell;
  right: CompareCell;
};

function compareKind(
  left: NonNullable<CompareSideInput> | undefined,
  right: NonNullable<CompareSideInput> | undefined
): CompareRowKind {
  if (!left && !right) {
    return "unset";
  }
  if (!right) {
    return "left";
  }
  if (!left) {
    return "right";
  }
  if (left.value === undefined || right.value === undefined) {
    return "uncompared";
  }
  // A secret against a plain value is never same or different: the plain value is on the page,
  // so either answer would tell the secret. Only emptiness is said, which the cells already say.
  if (left.isSecret !== right.isSecret) {
    return (left.value === "") !== (right.value === "") ? "empty" : "uncompared";
  }
  if (left.value === right.value) {
    return "same";
  }
  // A secret counts too: an empty secret is flagged as Empty, the one thing said about its value.
  if (left.value === "" || right.value === "") {
    return "empty";
  }
  return "different";
}

/** A key that isn't compared because one side is a secret and the other isn't. */
function isMixedSecretRow(kind: CompareRowKind, left: CompareSideInput, right: CompareSideInput) {
  return (
    kind === "uncompared" &&
    left?.value !== undefined &&
    right?.value !== undefined &&
    left.isSecret !== right.isSecret
  );
}

function compareCell(side: CompareSideInput, kind: CompareRowKind): CompareCell {
  if (!side) {
    return { isSet: false };
  }
  // As the list masks a value the role can't read: not even whether it is a secret.
  if (side.permissionDenied) {
    return { isSet: true, value: "", isSecret: false, permissionDenied: true };
  }
  return {
    isSet: true,
    value: side.isSecret || side.value === undefined ? "" : side.value,
    isSecret: side.isSecret,
    ...(side.valueUnavailable ? { valueUnavailable: true as const } : {}),
    ...(side.isSecret && kind === "different" ? { differs: true as const } : {}),
    ...(side.isSecret && side.value === "" ? { emptySecret: true as const } : {}),
    ...(side.unreadable ? { unreadable: true as const } : {}),
  };
}

/**
 * Classifies every key and counts each kind, in one pass. Every key is counted once, so the
 * counts add up to the number of rows. A key set on neither side is only passed in when it was
 * selected, and is listed as `unset`.
 */
export function compareEnvironmentVariables(
  keys: Array<{ id: string; key: string; left: CompareSideInput; right: CompareSideInput }>
): {
  rows: CompareRow[];
  counts: Record<CompareRowKind, number>;
  /** Of the `uncompared` keys, those with a secret on one side and a plain value on the other. */
  mixedSecretCount: number;
} {
  let mixedSecretCount = 0;
  const counts: Record<CompareRowKind, number> = {
    different: 0,
    left: 0,
    right: 0,
    empty: 0,
    same: 0,
    uncompared: 0,
    unset: 0,
  };
  const rows: CompareRow[] = [];

  for (const { id, key, left, right } of keys) {
    const kind = compareKind(left, right);
    counts[kind] += 1;
    if (isMixedSecretRow(kind, left, right)) {
      mixedSecretCount += 1;
    }
    rows.push({ id, key, kind, left: compareCell(left, kind), right: compareCell(right, kind) });
  }

  return { rows, counts, mixedSecretCount };
}

/**
 * Whether a row is listed. Without a kind: every key but the same ones (every difference, and
 * the keys that couldn't be compared). With one: only that kind.
 */
export function isCompareRowListed(row: Pick<CompareRow, "kind">, kind?: CompareKind): boolean {
  return kind ? row.kind === kind : row.kind !== "same";
}

export type CompareSideName = "left" | "right";

type CompareSideAccess = { isReadable: boolean; isWritable: boolean };

/** Whether values can be copied from a side to the other: read the source, write the target. */
export function canCopyFrom(
  sides: Record<CompareSideName, CompareSideAccess>,
  from: CompareSideName
): boolean {
  return sides[from].isReadable && sides[from === "left" ? "right" : "left"].isWritable;
}

/**
 * Whether the rows get checkboxes: only where ticking can lead to a copy. Not on the Same tab,
 * where every key already matches, nor when the role can copy neither way.
 */
export function canTickCompareRows(
  sides: Record<CompareSideName, CompareSideAccess>,
  kind: CompareKind | undefined
): boolean {
  return kind !== "same" && (canCopyFrom(sides, "left") || canCopyFrom(sides, "right"));
}

/** Why a ticked row isn't copied from a side. */
export type CopySkipReason = "notSet" | "unreadable" | "matching" | "empty";

/**
 * What copying the rows from one side to the other would do: the rows copied, as new or
 * replacing a value in the target, and the rows skipped with why. A row isn't copied when its
 * source isn't set (copying an absence would be a delete), can't be read, already matches, or is
 * empty where the organization doesn't allow empty values.
 */
export function compareCopyPlan(rows: CompareRow[], from: CompareSideName, emptyAllowed: boolean) {
  const to: CompareSideName = from === "left" ? "right" : "left";
  const copied: Array<{ row: CompareRow; replaces: boolean }> = [];
  const skipped: Record<CopySkipReason, number> = {
    notSet: 0,
    unreadable: 0,
    matching: 0,
    empty: 0,
  };
  for (const row of rows) {
    const reason = copySkipReason(row, from, emptyAllowed);
    if (reason) {
      skipped[reason] += 1;
    } else {
      copied.push({ row, replaces: row[to].isSet });
    }
  }
  return { from, to, copied, skipped };
}

export type CompareCopyPlan = ReturnType<typeof compareCopyPlan>;

export function copySkipReason(
  row: CompareRow,
  from: CompareSideName,
  emptyAllowed: boolean
): CopySkipReason | undefined {
  const source = row[from];
  if (!source.isSet) {
    return "notSet";
  }
  if (source.permissionDenied || source.valueUnavailable || source.unreadable) {
    return "unreadable";
  }
  if (row.kind === "same") {
    return "matching";
  }
  // Whitespace counts as empty, as when a value is saved. A secret is only known to be empty
  // when it is exactly "": the copy refuses the rest.
  if (!emptyAllowed && (source.isSecret ? source.emptySecret : source.value.trim() === "")) {
    return "empty";
  }
  return undefined;
}

function countLabel(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function keysLabel(count: number) {
  return count === 1 ? "key" : "keys";
}

/** What the copy does to the target, in one sentence. */
export function copyEffectSentence({
  count,
  replaceCount,
  newCount,
  onlyKey,
  from,
  to,
}: {
  count: number;
  replaceCount: number;
  newCount: number;
  onlyKey: string | undefined;
  from: string;
  to: string;
}): string {
  if (replaceCount === count) {
    return onlyKey
      ? `The ${to} value of ${onlyKey} will be replaced by its ${from} value.`
      : `The ${to} values of these ${count} keys will be replaced by their ${from} values.`;
  }
  if (newCount === count) {
    return onlyKey
      ? `${onlyKey} will be added to ${to} with its ${from} value.`
      : `These ${count} keys will be added to ${to} with their ${from} values.`;
  }
  return `${newCount} ${keysLabel(newCount)} will be added to ${to} and ${replaceCount} existing ${to} ${countLabel(replaceCount, "value", "values")} will be replaced.`;
}

/** Why some ticked rows aren't copied, in one sentence. Undefined when none are skipped. */
export function copySkippedSentence(
  skipped: CompareCopyPlan["skipped"],
  from: string,
  to: string
): string | undefined {
  // Empty values have their own line: `copyEmptySkippedSentence`.
  const total = skipped.notSet + skipped.unreadable + skipped.matching;
  if (total === 0) {
    return undefined;
  }
  const reasons = [
    skipped.notSet > 0 && {
      count: skipped.notSet,
      one: `isn't set in ${from}`,
      many: `aren't set in ${from}`,
    },
    skipped.unreadable > 0 && {
      count: skipped.unreadable,
      one: `can't be read in ${from}`,
      many: `can't be read in ${from}`,
    },
    skipped.matching > 0 && {
      count: skipped.matching,
      one: `already matches ${to}`,
      many: `already match ${to}`,
    },
  ].filter((reason) => reason !== false);
  const head = `${total} ${keysLabel(total)} ${total === 1 ? "is" : "are"} skipped: `;
  if (reasons.length === 1) {
    const reason = reasons[0]!;
    return `${head}${total === 1 ? `it ${reason.one}` : `they ${reason.many}`}.`;
  }
  return `${head}${reasons
    .map((reason) => `${reason.count} ${reason.count === 1 ? reason.one : reason.many}`)
    .join(", ")}.`;
}

/** The rows skipped because they're empty and the organization doesn't allow empty values. */
export function copyEmptySkippedSentence(count: number): string | undefined {
  if (count === 0) {
    return undefined;
  }
  return `${count} ${keysLabel(count)} ${count === 1 ? "is" : "are"} skipped: empty values aren't allowed in this organization.`;
}
