// If you add a site that creates a Postgres `Waitpoint` row, add a matching entry here or
// `waitpointMint.proof.test.ts` fails. Entries are one per site, anchored by symbol name,
// never by line number.
//
// Why: a site that mints a cuid for a gen-2 run writes a row the completion path cannot
// find. Three of the sites below fail loudly, because the routing store refuses an
// unstamped id on a gen-2 shard. The RUN row written through `createRun` does NOT — that
// write happens inside the run store, which has no such check — so a missed site there
// strands a parent run with no error.
//
// PURE module — no engine import, no env, no Prisma.
export type WaitpointMintSite = {
  id: string;
  type: "DATETIME" | "MANUAL" | "RUN" | "BATCH";
  /** Repo-relative source path. */
  site: string;
  /** Enclosing method or symbol name — NEVER a line number. */
  symbol: string;
};

const COORDINATOR =
  "internal-packages/run-engine/src/engine/waitpointCoordinator/legacyPostgresCoordinator.ts";
const ENGINE = "internal-packages/run-engine/src/engine/index.ts";
const RUN_STORE = "internal-packages/run-store/src/PostgresRunStore.ts";

export const WAITPOINT_MINT_SITES: readonly WaitpointMintSite[] = [
  {
    id: "coordinator.datetime",
    type: "DATETIME",
    site: COORDINATOR,
    symbol: "createDateTimeWaitpoint",
  },
  { id: "coordinator.manual", type: "MANUAL", site: COORDINATOR, symbol: "createManualWaitpoint" },
  {
    id: "coordinator.associated.mint",
    type: "RUN",
    site: COORDINATOR,
    symbol: "mintAssociatedWaitpointData",
  },
  {
    id: "coordinator.associated.create",
    type: "RUN",
    site: COORDINATOR,
    symbol: "createAssociatedWaitpoint",
  },
  { id: "engine.batch", type: "BATCH", site: ENGINE, symbol: "blockRunWithCreatedBatch" },
  // The physical writers of the RUN row. They take an already-minted id rather than
  // minting one, but they are the writes that bypass the routing store's stamp check, so a
  // new writer here must be seen.
  {
    id: "runStore.createRun.nested",
    type: "RUN",
    site: RUN_STORE,
    symbol: "createRun (nested associatedWaitpoint create)",
  },
  {
    id: "runStore.createRun.dedicated",
    type: "RUN",
    site: RUN_STORE,
    symbol: "#createAssociatedWaitpoint",
  },
];
