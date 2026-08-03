import type { EntryPoint } from "./types.js";

export type ExportName = "loader" | "action";

/**
 * One export of a route file, carrying that export's own evidence and nothing from the other one.
 *
 * Every field here has an entry-point-wide twin on `EntryPoint`, and reaching for the twin is the
 * mistake this type exists to make hard. `calleeNames` is the union of both bodies, `hasTryCatch`
 * is true if either has one, and `statementCount` counts both.
 */
export type RouteExport = {
  name: ExportName;
  /** Callee of the initializer call this export is assigned from, if any. */
  initializerCallee: string | null;
  /** Top-level keys of the object literal passed to that call. */
  builderOptions: string[];
  /** Callees inside this export's handlers, and inside same-file helpers they call. */
  calleeNames: string[];
  /** The same calls as whole dotted paths, so `prisma.thing.findFirst` keeps its receiver. */
  calleeTexts: string[];
  /** Callees whose answer those handlers demonstrably read. */
  checkedCallees: string[];
  /** Whether those handlers narrow a query by the caller's own id. */
  scopesByCaller: boolean;
  statementCount: number;
  hasTryCatch: boolean;
};

/**
 * The exports this route file declares, in `loader`, `action` order.
 *
 * One enumeration for the whole package, because two checks asking the same per-export question
 * each grew their own. `auth-scope`'s `builderExports` and `auth-boundary`'s `guardedExports` were
 * hand-maintained `[loader, action]` literals in adjacent files, reading the same six
 * `loaderX`/`actionX` field pairs, with different tests for whether an export was there at all:
 * one used `hasLoader`/`hasAction` and the other inferred it from a non-null initializer callee.
 * Adding a seventh per-export fact meant editing both, and this whole branch is a record of what
 * happens when a rule lives in two places and only one gets the fix.
 *
 * Absent exports are not returned, so a caller never has to remember to filter them: the shape of
 * the bug in `auth-boundary` was crediting an export for something the other one did, and a list
 * that only contains real exports is one fewer way to write it.
 */
export function routeExports(ep: EntryPoint): RouteExport[] {
  const all: RouteExport[] = [
    {
      name: "loader",
      initializerCallee: ep.loaderInitializerCallee,
      builderOptions: ep.loaderBuilderOptions,
      calleeNames: ep.loaderCalleeNames,
      calleeTexts: ep.loaderCalleeTexts,
      checkedCallees: ep.loaderCheckedCallees,
      scopesByCaller: ep.loaderScopesByCaller,
      statementCount: ep.loaderStatementCount,
      hasTryCatch: ep.loaderHasTryCatch,
    },
    {
      name: "action",
      initializerCallee: ep.actionInitializerCallee,
      builderOptions: ep.actionBuilderOptions,
      calleeNames: ep.actionCalleeNames,
      calleeTexts: ep.actionCalleeTexts,
      checkedCallees: ep.actionCheckedCallees,
      scopesByCaller: ep.actionScopesByCaller,
      statementCount: ep.actionStatementCount,
      hasTryCatch: ep.actionHasTryCatch,
    },
  ];
  return all.filter((e) => (e.name === "loader" ? ep.hasLoader : ep.hasAction));
}
