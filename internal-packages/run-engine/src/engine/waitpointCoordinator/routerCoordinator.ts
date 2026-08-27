import type { Logger } from "@trigger.dev/core/logger";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { Waitpoint } from "@trigger.dev/database";
import { UnclassifiableWaitpointId } from "../errors.js";
import { waitpointIdFromEdgeField } from "./keys.js";
import type {
  AssociatedWaitpointData,
  ClearRunBlockStateParams,
  CompleteParams,
  CompleteResult,
  CompletionEnvelopeSource,
  CreateBatchWaitpointParams,
  CreateDateTimeWaitpointParams,
  CreateManualWaitpointParams,
  CreateWaitpointResult,
  ReadCompletionEnvelopesParams,
  RegisterBlocksLocklessParams,
  RegisterBlocksParams,
  RunBlockEdge,
  WaitpointCoordinator,
  WaitpointMintKind,
} from "./types.js";

export type WaitpointRouterCoordinatorOptions = {
  legacy: WaitpointCoordinator;
  /** Absent when no waitpoint store is configured, which makes the store path unreachable. */
  store?: WaitpointCoordinator;
  logger: Logger;
};

/**
 * Chooses which arm owns a waitpoint, and nothing else.
 *
 * Every method here is a partition followed by delegation. It holds no store client and no
 * Prisma client of its own, so a branch that is not about ownership does not belong here.
 *
 * Two different rules, deliberately:
 *
 *  - An OPERATION routes on the id's shape. The id already exists, so its residency is a
 *    fact. A store-shaped id with no store arm configured throws, because guessing would
 *    silently operate on the wrong system.
 *  - A CREATE routes on the caller's mint kind. There is no id yet, so nothing can be
 *    misrouted. A store mint with no store arm falls back to legacy and says so: refusing
 *    would turn one process with a bad configuration into a trigger outage for every
 *    organization that has the flag set.
 */
export class WaitpointRouterCoordinator implements WaitpointCoordinator {
  private readonly legacy: WaitpointCoordinator;
  private readonly store?: WaitpointCoordinator;
  private readonly logger: Logger;

  constructor(options: WaitpointRouterCoordinatorOptions) {
    this.legacy = options.legacy;
    this.store = options.store;
    this.logger = options.logger;
  }

  async clearRunBlockState(params: ClearRunBlockStateParams): Promise<{ count: number }> {
    // An omitted edgeIds is the terminal "clear the whole run", so it must reach both arms
    // as an omission. A partition, by contrast, must send [] to the arm with nothing to
    // drain: omitting there would clear that arm's remaining edges for the run.
    if (!params.edgeIds) {
      const [legacy, store] = await Promise.all([
        this.legacy.clearRunBlockState(params),
        this.store?.clearRunBlockState(params),
      ]);

      return { count: legacy.count + (store?.count ?? 0) };
    }

    const split = this.#partitionEdgeIds(params.edgeIds);
    const [legacy, store] = await Promise.all([
      this.legacy.clearRunBlockState({ ...params, edgeIds: split.legacy }),
      this.store?.clearRunBlockState({ ...params, edgeIds: split.store }),
    ]);

    return { count: legacy.count + (store?.count ?? 0) };
  }

  /**
   * Both arms, always, because a run can be blocked by one of each and the pending set is
   * only correct as the union. The store read is one round trip against possibly-absent
   * keys, which answers empty for a run that never touched the store.
   */
  async readRunBlockState(runId: string): Promise<RunBlockEdge[]> {
    const [legacy, store] = await Promise.all([
      this.legacy.readRunBlockState(runId),
      this.store?.readRunBlockState(runId),
    ]);

    return [...legacy, ...(store ?? [])];
  }

  async readCompletionEnvelopes(
    params: ReadCompletionEnvelopesParams
  ): Promise<CompletionEnvelopeSource[]> {
    const split = this.#partitionWaitpointIds(params.waitpointIds);

    const [legacy, store] = await Promise.all([
      split.legacy.length
        ? this.legacy.readCompletionEnvelopes({ ...params, waitpointIds: split.legacy })
        : [],
      split.store.length
        ? this.#requireStore(split.store[0]!).readCompletionEnvelopes({
            ...params,
            waitpointIds: split.store,
          })
        : [],
    ]);

    return [...legacy, ...store];
  }

  /**
   * The dual pending check. Each arm counts only the ids it owns, and the sum is the run's
   * whole pending set, so a run blocked by one waitpoint of each kind stays blocked until
   * both complete.
   */
  async registerBlocks(params: RegisterBlocksParams): Promise<{ pendingCount: number }> {
    const split = this.#partitionWaitpointIds(params.waitpointIds);

    const [legacy, store] = await Promise.all([
      split.legacy.length
        ? this.legacy.registerBlocks({ ...params, waitpointIds: split.legacy })
        : undefined,
      split.store.length
        ? this.#requireStore(split.store[0]!).registerBlocks({
            ...params,
            waitpointIds: split.store,
          })
        : undefined,
    ]);

    return { pendingCount: (legacy?.pendingCount ?? 0) + (store?.pendingCount ?? 0) };
  }

  async registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void> {
    const split = this.#partitionWaitpointIds(params.waitpointIds);

    await Promise.all([
      split.legacy.length
        ? this.legacy.registerBlocksLockless({ ...params, waitpointIds: split.legacy })
        : undefined,
      split.store.length
        ? this.#requireStore(split.store[0]!).registerBlocksLockless({
            ...params,
            waitpointIds: split.store,
          })
        : undefined,
    ]);
  }

  async complete(params: CompleteParams): Promise<CompleteResult> {
    return this.#armFor(params.waitpointId).complete(params);
  }

  async createDateTimeWaitpoint(
    params: CreateDateTimeWaitpointParams
  ): Promise<CreateWaitpointResult> {
    return this.#armForMint(params.mintKind).createDateTimeWaitpoint(params);
  }

  async createManualWaitpoint(params: CreateManualWaitpointParams): Promise<CreateWaitpointResult> {
    return this.#armForMint(params.mintKind).createManualWaitpoint(params);
  }

  async createBatchWaitpoint(params: CreateBatchWaitpointParams): Promise<Waitpoint | null> {
    return this.#armForMint(params.mintKind).createBatchWaitpoint(params);
  }

  mintAssociatedWaitpointData(params: {
    projectId: string;
    environmentId: string;
    anchorRunId?: string;
    mintKind?: WaitpointMintKind;
  }): AssociatedWaitpointData {
    return this.#armForMint(params.mintKind ?? "legacy").mintAssociatedWaitpointData(params);
  }

  /** Routes on the minted id, so it lands wherever mintAssociatedWaitpointData put it. */
  async createAssociatedWaitpoint(params: {
    runId: string;
    data: AssociatedWaitpointData;
  }): Promise<Waitpoint> {
    return this.#armFor(params.data.id).createAssociatedWaitpoint(params);
  }

  #armFor(waitpointId: string): WaitpointCoordinator {
    return parseWaitpointId(waitpointId).format === "b32hexW"
      ? this.#requireStore(waitpointId)
      : this.legacy;
  }

  #armForMint(mintKind: WaitpointMintKind): WaitpointCoordinator {
    if (mintKind !== "store") {
      return this.legacy;
    }

    if (!this.store) {
      this.logger.error(
        "waitpoint mint asked for the store with no store configured; minting legacy",
        { mintKind }
      );
      return this.legacy;
    }

    return this.store;
  }

  #requireStore(waitpointId: string): WaitpointCoordinator {
    if (!this.store) {
      throw new UnclassifiableWaitpointId(waitpointId);
    }

    return this.store;
  }

  #partitionWaitpointIds(waitpointIds: string[]): { legacy: string[]; store: string[] } {
    const legacy: string[] = [];
    const store: string[] = [];

    for (const waitpointId of waitpointIds) {
      (parseWaitpointId(waitpointId).format === "b32hexW" ? store : legacy).push(waitpointId);
    }

    return { legacy, store };
  }

  /**
   * A store edge id is `<waitpointId>#<batchIndex>`; a legacy edge id is a Postgres row id
   * with no separator, so the helper reports undefined for it and it partitions legacy.
   */
  #partitionEdgeIds(edgeIds: string[]): { legacy: string[]; store: string[] } {
    const legacy: string[] = [];
    const store: string[] = [];

    for (const edgeId of edgeIds) {
      const waitpointId = waitpointIdFromEdgeField(edgeId);
      const isStore =
        waitpointId !== undefined && parseWaitpointId(waitpointId).format === "b32hexW";
      (isStore ? store : legacy).push(edgeId);
    }

    return { legacy, store };
  }
}
