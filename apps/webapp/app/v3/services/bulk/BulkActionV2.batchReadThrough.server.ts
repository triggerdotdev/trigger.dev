/**
 * Batch adapter over the per-id `readThroughRun` (see
 * `~/v3/runOpsMigration/readThrough.server.ts`). A bulk action processes a PAGE of
 * member run ids at once, so instead of N per-id round trips this reproduces the
 * per-id read-through ordering as SET reads:
 *
 *   1. single-DB passthrough (splitEnabled === false): ONE read against the collapsed
 *      store, no residency classification, no legacy probe.
 *   2. split on: classify each id's residency via `ownerEngine`, read NEW for every id
 *      that could be on new (residency NEW *and* legacy-candidates — read-through is
 *      new-FIRST for legacy too), then probe the LEGACY READ REPLICA ONLY for the
 *      legacy-candidates the new read missed.
 *
 * Like the per-id layer this NEVER touches a legacy primary/writer — there is no such
 * handle. An id is read from new OR legacy, never both: legacy is only probed for ids
 * new missed, so the returned set needs no dedupe.
 */
import type { PrismaReplicaClient } from "~/db.server";
import {
  runOpsLegacyReplica as defaultLegacyReplica,
  runOpsNewReplica as defaultNewClient,
} from "~/db.server";
import { ownerEngine, UnclassifiableRunId } from "@trigger.dev/core/v3/isomorphic";

export type SeamReadDeps = {
  /**
   * Resolved boot constant. REQUIRED here — the caller resolves it once per
   * request via `isSplitEnabled()`; this adapter never awaits it itself.
   */
  splitEnabled: boolean;
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  logger?: { warn: (m: string, meta?: unknown) => void };
};

type HydrateRunsAcrossSeamInput<T> = {
  runIds: string[];
  readNew: (client: PrismaReplicaClient, ids: string[]) => Promise<T[]>;
  readLegacyReplica: (replica: PrismaReplicaClient, ids: string[]) => Promise<T[]>;
  deps: SeamReadDeps;
};

/** Every row shape we hydrate carries an `id` (CANCEL select includes it; REPLAY is a full row). */
function getId(row: unknown): string {
  return (row as { id: string }).id;
}

export async function hydrateRunsAcrossSeam<T>(input: HydrateRunsAcrossSeamInput<T>): Promise<T[]> {
  const { runIds, deps } = input;

  if (runIds.length === 0) {
    return [];
  }

  const newClient = deps.newClient ?? defaultNewClient;

  // Passthrough: one plain read against the single collapsed store. No residency
  // classification, no legacy probe, no second connection. When the caller passes its
  // own `_replica` as `newClient`, this is byte-identical to the pre-migration single-DB read.
  if (deps.splitEnabled === false) {
    return input.readNew(newClient, runIds);
  }

  // Split is on. Classify residency; unclassifiable → LEGACY (probe rather than drop).
  const newIds: string[] = [];
  const legacyCandidateIds: string[] = [];
  for (const runId of runIds) {
    let residency: "LEGACY" | "NEW";
    try {
      residency = ownerEngine(runId);
    } catch (e) {
      if (e instanceof UnclassifiableRunId) {
        deps.logger?.warn("hydrateRunsAcrossSeam: UnclassifiableRunId, treating as LEGACY", {
          runId,
          valueLength: e.valueLength,
        });
        residency = "LEGACY";
      } else {
        throw e;
      }
    }
    if (residency === "NEW") {
      newIds.push(runId);
    } else {
      legacyCandidateIds.push(runId);
    }
  }

  // Read NEW for everything that could be on new — NEW-residency ids AND legacy-candidates
  // (read-through is new-FIRST for legacy too) — in one read.
  const legacyReplica = deps.legacyReplica ?? defaultLegacyReplica;
  const newRows = await input.readNew(newClient, [...newIds, ...legacyCandidateIds]);
  const foundOnNew = new Set(newRows.map(getId));

  // Legacy-candidates the new read missed are probed on the legacy read replica.
  const legacyToProbe = legacyCandidateIds.filter((id) => !foundOnNew.has(id));

  // Legacy READ REPLICA only — never a legacy writer/primary (no such handle exists).
  // A member absent from both DBs is simply not hydrated (matching today's `findMany`,
  // where a missing id yields no row).
  let legacyRows: T[] = [];
  if (legacyToProbe.length > 0) {
    legacyRows = await input.readLegacyReplica(legacyReplica, legacyToProbe);
  }

  // Order within the page is irrelevant (downstream pMap does not depend on it).
  return [...newRows, ...legacyRows];
}
