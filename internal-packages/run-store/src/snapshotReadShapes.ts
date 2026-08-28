// Shape matchers for the two generic Prisma-args snapshot reads.
//
// `findExecutionSnapshot` and `findManyExecutionSnapshots` take arbitrary Prisma arguments, and a
// key-value store cannot answer an arbitrary query. Only three production call sites exist, all in
// the engine's executionSnapshotSystem, and both generic ones send a single fixed shape. So these
// matchers recognise exactly those shapes and return undefined for anything else, which sends the
// call to Postgres.
//
// Each matcher rejects an argument object carrying any key it does not know about. A query that has
// drifted must fall through and be answered correctly by Postgres, never answered approximately
// from Redis.

type Unknown = Record<string, unknown>;

function isPlainObject(value: unknown): value is Unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has exactly `allowed` keys, ignoring keys explicitly set to undefined. */
function hasOnlyKeys(value: Unknown, allowed: string[]): boolean {
  const present = Object.keys(value).filter((k) => value[k] !== undefined);
  return present.every((k) => allowed.includes(k));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export type SinceCursorLookup = { id: string; runId: string; environmentId?: string };

/**
 * Step 1 of `getExecutionSnapshotsSince`: resolve a known snapshot id to its createdAt.
 *
 *   { where: { id, runId, environmentId? }, select: { createdAt: true } }
 */
export function matchSinceCursorLookup(args: unknown): SinceCursorLookup | undefined {
  if (!isPlainObject(args) || !hasOnlyKeys(args, ["where", "select"])) return undefined;

  const { where, select } = args;
  if (!isPlainObject(where) || !isPlainObject(select)) return undefined;
  if (!hasOnlyKeys(where, ["id", "runId", "environmentId"])) return undefined;
  if (!hasOnlyKeys(select, ["createdAt"]) || select.createdAt !== true) return undefined;
  if (!isString(where.id) || !isString(where.runId)) return undefined;
  if (where.environmentId !== undefined && !isString(where.environmentId)) return undefined;

  return {
    id: where.id,
    runId: where.runId,
    ...(isString(where.environmentId) && { environmentId: where.environmentId }),
  };
}

export type SinceWindow = {
  runId: string;
  createdAt: Date;
  take: number;
  environmentId?: string;
};

/**
 * Step 2 of `getExecutionSnapshotsSince`: the capped window after a createdAt cursor.
 *
 *   { where: { runId, isValid: true, createdAt: { gt }, environmentId? },
 *     include: { checkpoint: true }, orderBy: { createdAt: "desc" }, take: N }
 *
 * The engine deliberately omits completedWaitpoints from the include to avoid an N x M read, so an
 * include asking for them is a different query and is not matched.
 */
export function matchSinceWindow(args: unknown): SinceWindow | undefined {
  if (!isPlainObject(args) || !hasOnlyKeys(args, ["where", "include", "orderBy", "take"])) {
    return undefined;
  }

  const { where, include, orderBy, take } = args;
  if (!isPlainObject(where) || !isPlainObject(include) || !isPlainObject(orderBy)) return undefined;
  if (typeof take !== "number") return undefined;

  if (!hasOnlyKeys(where, ["runId", "isValid", "createdAt", "environmentId"])) return undefined;
  if (!isString(where.runId) || where.isValid !== true) return undefined;
  if (where.environmentId !== undefined && !isString(where.environmentId)) return undefined;

  if (!hasOnlyKeys(include, ["checkpoint"]) || include.checkpoint !== true) return undefined;
  if (!hasOnlyKeys(orderBy, ["createdAt"]) || orderBy.createdAt !== "desc") return undefined;

  const cursor = where.createdAt;
  if (!isPlainObject(cursor) || !hasOnlyKeys(cursor, ["gt"])) return undefined;
  if (!(cursor.gt instanceof Date)) return undefined;

  return {
    runId: where.runId,
    createdAt: cursor.gt,
    take,
    ...(isString(where.environmentId) && { environmentId: where.environmentId }),
  };
}
