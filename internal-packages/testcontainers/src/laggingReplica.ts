// A read-replica that has NOT caught up to its primary, for reproducing read-your-writes hazards the
// zero-lag single-DB test harness can't surface. Wraps a real Prisma client; for the configured
// models it serves STALE reads instead of live ones. Other models and all writes forward untouched.
// Modes: "missing" (row not replicated yet -> null/[]/0, *OrThrow throws); "frozen" (row out of date
// -> returns the provided pre-write snapshot rows, matched on top-level scalar `where` equality).
// `wasHit` asserts the stale replica was actually consulted.

const READ_METHODS = new Set([
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "findMany",
  "count",
]);

export type LaggingModel =
  | { model: string; mode: "missing" }
  | { model: string; mode: "frozen"; rows: readonly Record<string, unknown>[] };

// Match a frozen row against a Prisma `where` using top-level scalar equality only (enough for the
// friendlyId / id / environmentId lookups these reads use); nested filters are treated as "matches".
function whereMatches(row: Record<string, unknown>, where: unknown): boolean {
  if (where == null || typeof where !== "object") return true;
  return Object.entries(where as Record<string, unknown>).every(([key, val]) => {
    if (val !== null && typeof val === "object") return true;
    return row[key] === val;
  });
}

export function laggingReplica<C extends object>(
  real: C,
  configs: readonly LaggingModel[]
): { client: C; wasHit: (model?: string) => boolean } {
  const byModel = new Map(configs.map((c) => [c.model, c]));
  const hits = new Set<string>();

  const makeModelProxy = (modelName: string, realModel: object, cfg: LaggingModel) =>
    new Proxy(realModel, {
      get(target, prop) {
        if (typeof prop === "string" && READ_METHODS.has(prop)) {
          return async (args?: { where?: unknown }) => {
            hits.add(modelName);
            if (cfg.mode === "missing") {
              if (prop === "findMany") return [];
              if (prop === "count") return 0;
              if (prop === "findFirstOrThrow" || prop === "findUniqueOrThrow") {
                throw new Error(
                  `laggingReplica: ${modelName}.${prop} - row not visible on replica yet`
                );
              }
              return null;
            }
            const matched = cfg.rows.filter((r) => whereMatches(r, args?.where));
            if (prop === "findMany") return matched;
            if (prop === "count") return matched.length;
            const first = matched[0] ?? null;
            if ((prop === "findFirstOrThrow" || prop === "findUniqueOrThrow") && !first) {
              throw new Error(`laggingReplica: ${modelName}.${prop} - no frozen row matched`);
            }
            return first;
          };
        }
        const value = (target as Record<string | symbol, unknown>)[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });

  const client = new Proxy(real, {
    get(target, prop) {
      const cfg = typeof prop === "string" ? byModel.get(prop) : undefined;
      const delegate = cfg ? (target as Record<string, unknown>)[prop as string] : undefined;
      if (cfg && delegate && typeof delegate === "object") {
        return makeModelProxy(prop as string, delegate, cfg);
      }
      const value = (target as Record<string | symbol, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as C;

  return { client, wasHit: (model) => (model ? hits.has(model) : hits.size > 0) };
}
