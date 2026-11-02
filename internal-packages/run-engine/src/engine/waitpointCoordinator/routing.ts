import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";

/** Which coordinator owns an id. Derived purely from the id's shape — never from org config or a store probe. */
export type WaitpointCoordinatorKind = "legacy" | "store";

/**
 * Map the shared parser's verdict to a coordinator. A store-format ("b32hexW") id is owned by the
 * MemoryDB store; everything else — a legacy cuid, a foreign-prefixed id, or garbage — is legacy, and
 * the legacy Postgres path is where a genuinely unclassifiable id fails loud. This adds no
 * classification of its own, so the parser stays the single authority.
 */
export function classifyWaitpointCoordinator(id: string): WaitpointCoordinatorKind {
  return parseWaitpointId(id).format === "b32hexW" ? "store" : "legacy";
}

/** One item tagged with its position in the original, undivided collection. */
type PartitionedItem<T> = { item: T; index: number };

export type WaitpointPartition<T> = {
  legacy: PartitionedItem<T>[];
  store: PartitionedItem<T>[];
};

/**
 * Split a mixed collection into its owning coordinators. Each item keeps its ORIGINAL index, and
 * order and duplicates are preserved within each group.
 */
export function partitionByResidency<T>(
  items: readonly T[],
  getId: (item: T) => string
): WaitpointPartition<T> {
  const legacy: PartitionedItem<T>[] = [];
  const store: PartitionedItem<T>[] = [];

  items.forEach((item, index) => {
    if (classifyWaitpointCoordinator(getId(item)) === "store") {
      store.push({ item, index });
    } else {
      legacy.push({ item, index });
    }
  });

  return { legacy, store };
}
