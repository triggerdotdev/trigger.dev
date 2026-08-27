// Add a site that creates a Postgres `Waitpoint` row and add an entry here, or
// `waitpointMint.proof.test.ts` fails. One entry per site, anchored by symbol, never by line.
//
// A site that mints a cuid for a gen-2 run writes a row the completion path cannot find. Most
// fail loudly, because the router refuses an unstamped id on a gen-2 shard. The RUN row written
// through `createRun` does not: that write is inside the run store, which has no such check.
//
// Pure module: no engine import, no env, no Prisma.
export type WaitpointMintSite = {
  id: string;
  type: "DATETIME" | "MANUAL" | "RUN" | "BATCH";
  site: string;
  /** Enclosing method or symbol name — NEVER a line number. */
  symbol: string;
  /**
   * Mint expressions this site contains, verbatim, counted per file, so a new mint and a swapped
   * anchor both fail until reconciled. Empty for a site writing an id minted elsewhere.
   */
  mints: readonly string[];
};

const COORDINATOR =
  "internal-packages/run-engine/src/engine/waitpointCoordinator/legacyPostgresCoordinator.ts";
const ENGINE = "internal-packages/run-engine/src/engine/index.ts";
const RUN_STORE = "internal-packages/run-store/src/PostgresRunStore.ts";

export const WAITPOINT_MINT_SITES: readonly WaitpointMintSite[] = [
  {
    id: "coordinator.datetime",
    mints: ["mintWaitpointIdFor(runId)"],
    type: "DATETIME",
    site: COORDINATOR,
    symbol: "createDateTimeWaitpoint",
  },
  {
    id: "coordinator.manual",
    mints: ["mintWaitpointIdForShard(standaloneShard)", "mintWaitpointIdFor(runId)"],
    type: "MANUAL",
    site: COORDINATOR,
    symbol: "createManualWaitpoint",
  },
  {
    id: "coordinator.associated.mint",
    mints: ["mintWaitpointIdFor(anchorRunId)"],
    type: "RUN",
    site: COORDINATOR,
    symbol: "mintAssociatedWaitpointData",
  },
  {
    id: "coordinator.associated.create",
    mints: [],
    type: "RUN",
    site: COORDINATOR,
    symbol: "createAssociatedWaitpoint",
  },
  {
    id: "engine.batch",
    mints: ["mintWaitpointIdFor(batchId)"],
    type: "BATCH",
    site: ENGINE,
    symbol: "blockRunWithCreatedBatch",
  },
  // The physical writers of the RUN row. They take an already-minted id rather than
  // minting one, but they are the writes that bypass the routing store's stamp check, so a
  // new writer here must be seen.
  {
    id: "runStore.createRun.nested",
    mints: [],
    type: "RUN",
    site: RUN_STORE,
    symbol: "createRun (nested associatedWaitpoint create)",
  },
  {
    id: "runStore.createRun.dedicated",
    mints: [],
    type: "RUN",
    site: RUN_STORE,
    symbol: "#createAssociatedWaitpoint",
  },
];
