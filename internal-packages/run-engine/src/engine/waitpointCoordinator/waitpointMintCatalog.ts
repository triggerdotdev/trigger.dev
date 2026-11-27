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
  /** The MemoryDB-anchor refusal: `call` verbatim, or `via` the entry whose mint gives this id. */
  refusal: { call: string } | { via: string };
};

const COORDINATOR =
  "internal-packages/run-engine/src/engine/waitpointCoordinator/legacyPostgresCoordinator.ts";
const ENGINE = "internal-packages/run-engine/src/engine/index.ts";
const RUN_STORE = "internal-packages/run-store/src/PostgresRunStore.ts";

export const WAITPOINT_MINT_SITES: readonly WaitpointMintSite[] = [
  {
    id: "coordinator.datetime",
    refusal: { call: "refusePostgresWaitpointOnMemoryDbAnchor(runId)" },
    mints: ["mintWaitpointIdFor(runId)"],
    type: "DATETIME",
    site: COORDINATOR,
    symbol: "createDateTimeWaitpoint",
  },
  {
    id: "coordinator.manual",
    refusal: { call: "refusePostgresWaitpointOnMemoryDbAnchor(runId)" },
    mints: ["mintWaitpointIdForShard(standaloneShard)", "mintWaitpointIdFor(runId)"],
    type: "MANUAL",
    site: COORDINATOR,
    symbol: "createManualWaitpoint",
  },
  {
    id: "coordinator.associated.mint",
    refusal: { call: "refusePostgresWaitpointOnMemoryDbAnchor(anchorRunId)" },
    mints: ["mintWaitpointIdFor(anchorRunId)"],
    type: "RUN",
    site: COORDINATOR,
    symbol: "mintAssociatedWaitpointData",
  },
  {
    id: "coordinator.associated.create",
    refusal: { via: "coordinator.associated.mint" },
    mints: [],
    type: "RUN",
    site: COORDINATOR,
    symbol: "createAssociatedWaitpoint",
  },
  {
    id: "coordinator.batch",
    refusal: { call: "refusePostgresWaitpointOnMemoryDbAnchor(batchId)" },
    mints: ["mintWaitpointIdFor(batchId)"],
    type: "BATCH",
    site: COORDINATOR,
    symbol: "createBatchWaitpoint",
  },
  {
    id: "engine.batch",
    refusal: { call: "refusePostgresWaitpointOnMemoryDbAnchor(batchId)" },
    mints: ["mintWaitpointIdFor(batchId)"],
    type: "BATCH",
    site: ENGINE,
    symbol: "blockRunWithCreatedBatch",
  },
  // These bypass the routing store's stamp check, so a new writer here must be seen.
  {
    id: "runStore.createRun.nested",
    refusal: { via: "coordinator.associated.mint" },
    mints: [],
    type: "RUN",
    site: RUN_STORE,
    symbol: "createRun (nested associatedWaitpoint create)",
  },
  {
    id: "runStore.createRun.dedicated",
    refusal: { via: "coordinator.associated.mint" },
    mints: [],
    type: "RUN",
    site: RUN_STORE,
    symbol: "#createAssociatedWaitpoint",
  },
];
