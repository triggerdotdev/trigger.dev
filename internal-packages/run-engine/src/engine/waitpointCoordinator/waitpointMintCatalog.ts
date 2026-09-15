// A site creating a Postgres `Waitpoint` row needs an entry here or `waitpointMint.proof.test.ts`
// fails. Most unstamped mints fail loudly at the router, but `createRun` writes inside the run
// store, which has no stamp check.
export type WaitpointMintSite = {
  id: string;
  type: "DATETIME" | "MANUAL" | "RUN" | "BATCH";
  site: string;
  /** Never a line number. */
  symbol: string;
  /** Verbatim, counted per file, so a swapped anchor fails too. Empty if minted elsewhere. */
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
  // These bypass the routing store's stamp check, so a new writer here must be seen.
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
