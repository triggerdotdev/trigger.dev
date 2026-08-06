import type { EntryPoint } from "./types.js";

export type ExportName = "loader" | "action";

/**
 * One export of a route file, carrying that export's own evidence and nothing from the other one.
 * Every field has an entry-point-wide twin on `EntryPoint`, and reaching for the twin is the mistake
 * this type exists to make hard.
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
 * The exports this route file declares, in `loader`, `action` order. One enumeration for the whole
 * package, because the two per-export checks each grew their own hand-maintained `[loader, action]`
 * literal, disagreeing about how to tell whether an export was there at all.
 *
 * Absent exports are not returned, so a caller never has to remember to filter them.
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
