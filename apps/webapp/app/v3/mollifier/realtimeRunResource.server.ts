import type { SyntheticRun } from "./readFallback.server";

// Shape `realtime.v1.runs.$runId.ts`'s findResource hands to the route's
// authorization callback + loader body. The PG-resident case is the
// canonical shape (a TaskRun row with the batch join); the buffered
// case below mirrors it from the synthetic run.
export type RealtimeRunResource = {
  id: string;
  friendlyId: string;
  taskIdentifier: string;
  runTags: string[];
  batch: { friendlyId: string } | null;
  // Present only when this resource was resolved from the mollifier
  // buffer (no PG row yet). Stamped at resolve time so the loader body
  // can emit observability for buffered-window subscriptions. The flag
  // doubles as the discriminant — PG-sourced resources never carry it.
  __bufferedDwellMs?: number;
};

export type RealtimeRunResourcePgRun = {
  id: string;
  friendlyId: string;
  taskIdentifier: string;
  runTags: string[];
  batch: { friendlyId: string } | null;
};

// Given the results of the PG and buffer lookups, produce the resource
// shape the realtime route returns from findResource. PG-first: if the
// run is PG-resident, return it unchanged (the buffered fallback only
// fires when no PG row exists yet). When only the buffer has the run,
// synthesise a matching shape whose `id` is the deterministic value
// engine.trigger will write when the drainer materialises this run —
// this is what lets the Electric subscription's `WHERE id=<id>` match
// the eventual INSERT.
export function resolveRealtimeRunResource(input: {
  pgRun: RealtimeRunResourcePgRun | null;
  bufferedSynthetic: Pick<
    SyntheticRun,
    "id" | "friendlyId" | "taskIdentifier" | "runTags" | "createdAt"
  > | null;
  now?: () => number;
}): RealtimeRunResource | null {
  if (input.pgRun) return input.pgRun;
  if (input.bufferedSynthetic) {
    const now = (input.now ?? Date.now)();
    return {
      id: input.bufferedSynthetic.id,
      friendlyId: input.bufferedSynthetic.friendlyId,
      taskIdentifier: input.bufferedSynthetic.taskIdentifier ?? "",
      runTags: input.bufferedSynthetic.runTags,
      batch: null,
      __bufferedDwellMs: now - input.bufferedSynthetic.createdAt.getTime(),
    };
  }
  return null;
}
