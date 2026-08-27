import type { Meter, Counter } from "@internal/tracing";
import type { RunStore } from "@internal/run-store";
import type { Logger } from "@trigger.dev/core/logger";
import { tryCatch } from "@trigger.dev/core/v3";
import {
  deriveWaitpointIdFromAnchor,
  generateWaitpointId,
  parseWaitpointId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import type { Waitpoint } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import type {
  BlockEdge,
  WaitpointCompletion,
  WaitpointRecordInput,
  WaitpointStoreCoordinator,
} from "./storeCoordinator.js";
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
} from "./types.js";
import { toPrismaWaitpoint } from "./waitpointShape.js";

export type StoreWaitpointCoordinatorArmOptions = {
  store: WaitpointStoreCoordinator;
  /** MANUAL projection writes only. Never read for coordination (I6). */
  runStore: RunStore;
  logger: Logger;
  meter: Meter;
};

/**
 * Waitpoint coordination against the Redis store.
 *
 * The store is the system of record. Postgres keeps one derived artefact — the MANUAL
 * projection row, written after the store commit so the dashboard and token API keep
 * working — and no coordination path ever reads it back.
 */
export class StoreWaitpointCoordinatorArm implements WaitpointCoordinator {
  private readonly store: WaitpointStoreCoordinator;
  private readonly runStore: RunStore;
  private readonly logger: Logger;

  private readonly resumeCrossCheckViolations: Counter;
  private readonly batchGuardViolations: Counter;
  private readonly projectionWriteFailures: Counter;

  constructor(options: StoreWaitpointCoordinatorArmOptions) {
    this.store = options.store;
    this.runStore = options.runStore;
    this.logger = options.logger;

    this.resumeCrossCheckViolations = options.meter.createCounter(
      "waitpoint.resume_crosscheck_violations",
      { description: "Block edges found in neither the pending nor the delivered set" }
    );
    this.batchGuardViolations = options.meter.createCounter("waitpoint.batch_guard_violations", {
      description: "Lockless absorbs attempted without a pending parent BATCH waitpoint",
    });
    this.projectionWriteFailures = options.meter.createCounter(
      "waitpoint.projection_write_failures",
      { description: "MANUAL projection rows that failed to write after the store commit" }
    );
  }

  /**
   * The store reports an outcome, not a delete count, and the seam's only consumer of the
   * count is a debug log in the run-completion path. So this reports what was asked to
   * drain rather than paying a read to confirm it.
   */
  async clearRunBlockState({ runId, edgeIds }: ClearRunBlockStateParams): Promise<{
    count: number;
  }> {
    await this.store.clearBlockState({ runId, edgeIds });
    return { count: edgeIds?.length ?? 0 };
  }

  async readRunBlockState(runId: string): Promise<RunBlockEdge[]> {
    const state = await this.store.readBlockState(runId);
    const pending = new Set(state.pendingIds);
    const delivered = new Set(state.deliveredIds);

    return state.edges.map((edge) => ({
      id: edge.edgeId,
      batchId: edge.batchId ?? null,
      batchIndex: edge.batchIndex ?? null,
      waitpoint: {
        id: edge.waitpointId,
        status: this.#deriveStatus(runId, edge.waitpointId, pending, delivered),
        type: edge.type,
        completedAfter: edge.completedAfter ? new Date(edge.completedAfter) : null,
      },
    }));
  }

  /**
   * I10. `runAbsorbBlockers` keeps every edge in exactly one of the pending or delivered
   * sets. A run-shard data loss breaks that: the edge survives while its pending entry is
   * gone. Reading "not pending, therefore complete" then resumes a run whose waitpoint
   * never completed, which is the only premature-resume counterexample either TLA+
   * campaign produced. So an edge in neither set reports PENDING and is counted; the run
   * stays blocked and a later sweep heals it.
   */
  #deriveStatus(
    runId: string,
    waitpointId: string,
    pending: Set<string>,
    delivered: Set<string>
  ): "PENDING" | "COMPLETED" {
    if (delivered.has(waitpointId)) {
      return "COMPLETED";
    }

    if (!pending.has(waitpointId)) {
      this.resumeCrossCheckViolations.add(1);
      this.logger.error("waitpoint edge is in neither the pending nor the delivered set", {
        runId,
        waitpointId,
      });
    }

    return "PENDING";
  }

  readCompletionEnvelopes(
    params: ReadCompletionEnvelopesParams
  ): Promise<CompletionEnvelopeSource[]> {
    return this.store.readCompletionEnvelopes(params);
  }

  async registerBlocks(params: RegisterBlocksParams): Promise<{ pendingCount: number }> {
    const edges = await this.#buildEdges(params);
    const { pendingOfRequested } = await this.store.registerBlocks({
      runId: params.runId,
      edges,
    });

    return { pendingCount: pendingOfRequested };
  }

  async registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void> {
    await this.#assertBatchWaitpointPending(params);

    const edges = await this.#buildEdges(params);
    await this.store.registerBlocks({ runId: params.runId, edges });
  }

  /**
   * §5.4's guard invariant. A lockless absorb writes item edges one at a time without the
   * run lock, which is only safe while the parent's BATCH waitpoint holds the pending set
   * open. If it is absent or already complete, a concurrent completion could see an empty
   * pending set mid-absorb and resume the parent early.
   *
   * Scope, stated precisely: this is a PREFLIGHT DETECTOR, not a barrier. It reads the run
   * shard, then the absorb writes in a separate operation, so a completion landing between
   * the two is detected on the next call, not prevented. Closing that window means moving
   * the pending-set assertion inside the absorb script, so check and write share one
   * atomic action.
   *
   * Neither TLA+ campaign models this variant, so until the race harness covers it this
   * detector plus the fail-loud on a missing id is the whole protection.
   */
  async #assertBatchWaitpointPending(params: RegisterBlocksLocklessParams): Promise<void> {
    if (!params.batchWaitpointId) {
      // Never silently skip. An unwired caller would disable the guard rather than fail,
      // which is the failure mode the guard exists to prevent.
      this.batchGuardViolations.add(1);
      throw new Error(
        `Lockless absorb for run ${params.runId} reached the store arm with no parent ` +
          `BATCH waitpoint id, so the pending-set guard has nothing to assert on`
      );
    }

    const state = await this.store.readBlockState(params.runId);
    if (state.pendingIds.includes(params.batchWaitpointId)) {
      return;
    }

    this.batchGuardViolations.add(1);
    throw new Error(
      `Lockless absorb for run ${params.runId} requires the parent BATCH waitpoint ` +
        `${params.batchWaitpointId} to be present and pending on the run shard`
    );
  }

  /**
   * The edge blobs the run shard stores.
   *
   * `type` comes free from the id, which is what the positional id layout buys. Only
   * DATETIME needs a record read, because its `completedAfter` rides the edge so the
   * block-state read never has to touch each waitpoint's own key. RUN, BATCH and MANUAL
   * skip it, which keeps `triggerAndWait` at one round trip per waitpoint.
   */
  async #buildEdges(params: RegisterBlocksLocklessParams): Promise<BlockEdge[]> {
    const createdAt = new Date().toISOString();
    const dateTimeIds = params.waitpointIds.filter((id) => {
      const parsed = parseWaitpointId(id);
      return parsed.format === "b32hexW" && parsed.type === "DATETIME";
    });
    const completedAfterById = await this.#readCompletedAfter(dateTimeIds);

    return params.waitpointIds.map((waitpointId) => {
      const parsed = parseWaitpointId(waitpointId);
      if (parsed.format !== "b32hexW") {
        throw new Error(`Waitpoint ${waitpointId} is not a store-format id`);
      }

      return {
        waitpointId,
        batchIndex: params.batchIndex ?? null,
        batchId: params.batchId,
        spanIdToComplete: params.spanIdToComplete,
        createdAt,
        type: parsed.type,
        completedAfter: completedAfterById.get(waitpointId),
      };
    });
  }

  async #readCompletedAfter(waitpointIds: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();

    for (const waitpointId of waitpointIds) {
      const held = await this.store.readWaitpoint(waitpointId);
      if (held?.record.completedAfter) {
        found.set(waitpointId, held.record.completedAfter);
      }
    }

    return found;
  }

  async complete({ waitpointId, output }: CompleteParams): Promise<CompleteResult> {
    const completion: WaitpointCompletion = {
      completedAt: new Date().toISOString(),
      outputType: output?.type ?? "application/json",
      outputIsError: output?.isError ?? false,
      output: output ? { inline: output.value } : null,
    };

    const result = await this.store.complete({ waitpointId, completion });

    // Deliver onto each watcher's own shard. The complete script returned the watchers
    // atomically, so a watcher registered before the flip is always in this list.
    for (const watcher of result.watchers) {
      await this.store.deliverCompletion({
        runId: watcher.runId,
        waitpointId,
        completion: result.completion ?? completion,
      });
    }

    const held = await this.store.readWaitpoint(waitpointId);
    if (!held) {
      throw new Error(`Waitpoint ${waitpointId} is not present in the store`);
    }

    if (held.record.type === "MANUAL") {
      await this.#completeManualProjection(waitpointId, held.completion ?? completion);
    }

    return {
      waitpoint: toPrismaWaitpoint(held.record, held.status, held.completion),
      blockedRuns: result.watchers.map((watcher) => ({
        taskRunId: watcher.runId,
        spanIdToComplete: watcher.spanIdToComplete ?? null,
        createdAt: new Date(watcher.createdAt),
      })),
    };
  }

  async createDateTimeWaitpoint(
    params: CreateDateTimeWaitpointParams
  ): Promise<CreateWaitpointResult> {
    return this.#createStandalone({
      type: "DATETIME",
      environmentId: params.environmentId,
      projectId: params.projectId,
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt,
      completedAfter: params.completedAfter,
    });
  }

  async createManualWaitpoint(params: CreateManualWaitpointParams): Promise<CreateWaitpointResult> {
    const result = await this.#createStandalone({
      type: "MANUAL",
      environmentId: params.environmentId,
      projectId: params.projectId,
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt,
      completedAfter: params.timeout,
      tags: params.tags,
    });

    // Only the call that actually created the waitpoint writes the projection. A cached
    // idempotency hit returns a waitpoint that already has its row, and inserting it again
    // violates the primary key.
    if (result.kind === "created") {
      await this.#writeManualProjection(result.waitpoint);
    }

    return result;
  }

  async createBatchWaitpoint({
    batchId,
    environmentId,
    projectId,
  }: CreateBatchWaitpointParams): Promise<Waitpoint | null> {
    const waitpointId = deriveWaitpointIdFromAnchor(batchId, "BATCH");
    if (!waitpointId) {
      throw new Error(`Batch ${batchId} is not a run-ops id, so no BATCH waitpoint derives`);
    }

    const record = this.#record({
      id: waitpointId,
      type: "BATCH",
      environmentId,
      projectId,
      idempotencyKey: batchId,
      completedByBatchId: batchId,
    });

    const created = await this.store.createIfAbsent({ record, status: "PENDING" });

    // The duplicate-batch contract. NX reports the second call, where the legacy arm gets
    // a unique-index violation.
    if (created.outcome === "exists") {
      return null;
    }

    return toPrismaWaitpoint(record, "PENDING");
  }

  mintAssociatedWaitpointData({
    projectId,
    environmentId,
    anchorRunId,
  }: {
    projectId: string;
    environmentId: string;
    anchorRunId?: string;
  }): AssociatedWaitpointData {
    const derived = anchorRunId ? deriveWaitpointIdFromAnchor(anchorRunId, "RUN") : undefined;
    if (!derived) {
      throw new Error(
        `Run ${anchorRunId ?? "(none)"} is not a run-ops id, so no RUN waitpoint derives`
      );
    }

    return {
      id: derived,
      friendlyId: WaitpointId.toFriendlyId(derived),
      type: "RUN",
      status: "PENDING",
      idempotencyKey: nanoid(24),
      userProvidedIdempotencyKey: false,
      projectId,
      environmentId,
    };
  }

  /**
   * Create-if-absent on the anchor-derived id.
   *
   * The lock and double-check the legacy arm needs are gone: the id is a pure function of
   * the run id, so two racing callers compute the same id and NX settles it. A caller that
   * finds it already present takes the existing record, which is what makes the crash
   * window between the run commit and this call recoverable by retry.
   */
  async createAssociatedWaitpoint({
    runId,
    data,
  }: {
    runId: string;
    data: AssociatedWaitpointData;
  }): Promise<Waitpoint> {
    const record = this.#record({
      id: data.id,
      friendlyId: data.friendlyId,
      type: "RUN",
      environmentId: data.environmentId,
      projectId: data.projectId,
      idempotencyKey: data.idempotencyKey,
      completedByTaskRunId: runId,
    });

    const created = await this.store.createIfAbsent({ record, status: "PENDING" });
    if (created.outcome === "exists") {
      return toPrismaWaitpoint(created.record, created.status, created.completion);
    }

    return toPrismaWaitpoint(record, "PENDING");
  }

  async #createStandalone(params: {
    type: "DATETIME" | "MANUAL";
    environmentId: string;
    projectId: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    completedAfter?: Date;
    tags?: string[];
  }): Promise<CreateWaitpointResult> {
    const userProvidedIdempotencyKey = params.idempotencyKey !== undefined;
    const record = this.#record({
      id: generateWaitpointId(params.type),
      type: params.type,
      environmentId: params.environmentId,
      projectId: params.projectId,
      idempotencyKey: params.idempotencyKey ?? nanoid(24),
      userProvidedIdempotencyKey,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt?.toISOString(),
      completedAfter: params.completedAfter?.toISOString(),
      tags: params.tags,
    });

    // Without a user key there is nothing to dedupe against, so the reservation round trip
    // is skipped entirely rather than reserved against a random key nobody will present.
    if (!userProvidedIdempotencyKey) {
      await this.store.createIfAbsent({ record, status: "PENDING" });
      return { kind: "created", waitpoint: toPrismaWaitpoint(record, "PENDING") };
    }

    const reserved = await this.store.createWithIdempotencyKey({
      record,
      environmentId: params.environmentId,
      idempotencyKey: params.idempotencyKey!,
    });

    if (reserved.created) {
      return { kind: "created", waitpoint: toPrismaWaitpoint(record, "PENDING") };
    }

    const held = await this.store.readWaitpoint(reserved.waitpointId);
    if (!held) {
      throw new Error(`Waitpoint ${reserved.waitpointId} won the reservation but is absent`);
    }

    return {
      kind: "cached",
      waitpoint: toPrismaWaitpoint(held.record, held.status, held.completion),
    };
  }

  /**
   * The MANUAL projection (I6). Written after the store commit, read by the dashboard and
   * the token API, and never consulted for coordination.
   *
   * A failure here must not fail the create: the waitpoint already exists in the store and
   * is already coordinating, so throwing would report failure for work that succeeded.
   */
  async #writeManualProjection(waitpoint: Waitpoint): Promise<void> {
    const [error] = await tryCatch(
      this.runStore.createWaitpoint({
        data: {
          id: waitpoint.id,
          friendlyId: waitpoint.friendlyId,
          type: "MANUAL",
          status: waitpoint.status,
          idempotencyKey: waitpoint.idempotencyKey,
          userProvidedIdempotencyKey: waitpoint.userProvidedIdempotencyKey,
          idempotencyKeyExpiresAt: waitpoint.idempotencyKeyExpiresAt ?? undefined,
          completedAfter: waitpoint.completedAfter ?? undefined,
          environmentId: waitpoint.environmentId,
          projectId: waitpoint.projectId,
          tags: waitpoint.tags,
        },
      })
    );

    if (error) {
      this.projectionWriteFailures.add(1);
      this.logger.error("failed to write the MANUAL waitpoint projection row", {
        waitpointId: waitpoint.id,
        error,
      });
    }
  }

  /**
   * Reflect a MANUAL completion onto the projection row.
   *
   * The token API and the dashboard read status, output and completedAt from this row, so
   * leaving it PENDING would report a completed token as still waiting. Best effort, for
   * the same reason as the create-time write: the store already completed the waitpoint.
   */
  async #completeManualProjection(
    waitpointId: string,
    completion: WaitpointCompletion
  ): Promise<void> {
    const output = completion.output;

    const [error] = await tryCatch(
      this.runStore.updateManyWaitpoints({
        where: { id: waitpointId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(completion.completedAt),
          output: output ? ("inline" in output ? output.inline : output.ref) : null,
          outputType: completion.outputType,
          outputIsError: completion.outputIsError,
        },
      })
    );

    if (error) {
      this.projectionWriteFailures.add(1);
      this.logger.error("failed to complete the MANUAL waitpoint projection row", {
        waitpointId,
        error,
      });
    }
  }

  #record(params: {
    id: string;
    friendlyId?: string;
    type: WaitpointRecordInput["type"];
    environmentId: string;
    projectId: string;
    idempotencyKey: string;
    userProvidedIdempotencyKey?: boolean;
    idempotencyKeyExpiresAt?: string;
    completedAfter?: string;
    completedByTaskRunId?: string;
    completedByBatchId?: string;
    tags?: string[];
  }): WaitpointRecordInput {
    const now = new Date().toISOString();

    return {
      id: params.id,
      friendlyId: params.friendlyId ?? WaitpointId.toFriendlyId(params.id),
      type: params.type,
      environmentId: params.environmentId,
      projectId: params.projectId,
      createdAt: now,
      updatedAt: now,
      userProvidedIdempotencyKey: params.userProvidedIdempotencyKey ?? false,
      tags: params.tags ?? [],
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt,
      completedAfter: params.completedAfter,
      completedByTaskRunId: params.completedByTaskRunId,
      completedByBatchId: params.completedByBatchId,
    };
  }
}
