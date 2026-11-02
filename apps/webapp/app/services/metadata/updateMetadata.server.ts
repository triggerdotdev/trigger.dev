import type {
  IOPacket,
  RunMetadataChangeOperation,
  UpdateMetadataRequestBody,
} from "@trigger.dev/core/v3";
import { applyMetadataOperations, parsePacket } from "@trigger.dev/core/v3";
import type { PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  handleMetadataPacket,
  handleMetadataPacketWithByteLength,
  MetadataTooLargeError,
} from "~/utils/packets";
import { ServiceValidationError } from "~/v3/services/common.server";
import { Cause, Effect, Either, Option, Schedule, Duration, Fiber } from "effect";
import { type RuntimeFiber } from "effect/Fiber";
import { setTimeout } from "timers/promises";
import type { LogLevel } from "@trigger.dev/core/logger";
import { Logger } from "@trigger.dev/core/logger";
import type { RunStore } from "@internal/run-store";
import type { RbacAbility } from "@trigger.dev/plugins";
import { authorizeMetadataTargets } from "./metadataAuthorization.server";
import { getMeter, type Counter, type Meter } from "@internal/tracing";
import {
  InMemoryMetadataOperationBuffer,
  MetadataBufferFullError,
  type BufferedRunMetadataChangeOperation,
  type MetadataBufferClaim,
  type MetadataOperationBuffer,
} from "./operationBuffer.server";

const RUN_UPDATABLE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const MAX_DRAIN_BATCHES_PER_TICK = 100;
const MAX_DROPS_LOGGED = 20;
const MAX_LOGGED_CHARS = 200;

class MetadataClaimLostError extends Error {
  constructor(runId: string) {
    super(`Lost the buffer claim for run ${runId}`);
  }
}

class MetadataWriteNotSentError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`Metadata write for run ${runId} never reached the database`, { cause });
  }
}

class MetadataWriteOutcomeUnknownError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`Metadata write for run ${runId} failed with an unknown outcome`, { cause });
  }
}

type DroppedOperation = { operation: RunMetadataChangeOperation; error: unknown };

// A dropped operation may not be well formed.
function loggedKey(operation: RunMetadataChangeOperation): string | undefined {
  const key = (operation as { key?: unknown }).key;
  return typeof key === "string" ? key.slice(0, MAX_LOGGED_CHARS) : undefined;
}

function applyOrSalvage(
  metadata: Record<string, unknown>,
  operations: RunMetadataChangeOperation[],
  budgetMs: number
): { newMetadata: Record<string, unknown>; applied: number; dropped: DroppedOperation[] } {
  let newMetadata = metadata;
  let applied = 0;
  let deadline: number | undefined;
  const dropped: DroppedOperation[] = [];
  const apply = (segment: RunMetadataChangeOperation[]): void => {
    try {
      // Copies: a value enters the metadata by reference, so a failed attempt may have mutated it.
      const result = applyMetadataOperations(newMetadata, structuredClone(segment));
      newMetadata = result.newMetadata;
      applied += segment.length - result.unappliedOperations.length;
    } catch (error) {
      deadline ??= performance.now() + budgetMs;
      if (segment.length <= 1 || performance.now() >= deadline) {
        dropped.push(...segment.map((operation) => ({ operation, error })));
        return;
      }
      const half = Math.ceil(segment.length / 2);
      apply(segment.slice(0, half));
      apply(segment.slice(half));
    }
  };
  apply(operations);
  return { newMetadata, applied, dropped };
}

function isClaimLost(error: unknown): boolean {
  return error instanceof MetadataClaimLostError;
}

function isWriteOutcomeUnknown(error: unknown): boolean {
  return error instanceof MetadataWriteOutcomeUnknownError;
}

function isWriteNotSent(error: unknown): boolean {
  return error instanceof MetadataWriteNotSentError;
}

/**
 * True when the query never reached the database (pool exhaustion or engine initialization), so it
 * cannot have committed. A dropped connection (P1001, P1017) can follow a commit, so it is not here.
 */
function writeNeverReachedDatabase(error: unknown): boolean {
  const { name, code, message } = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (name === "PrismaClientInitializationError") return true;
  if (code === "P2024") return true;
  return typeof message === "string" && /timed out fetching a new connection/i.test(message);
}

export type UpdateMetadataServiceOptions = {
  prisma: PrismaClientOrTransaction;
  runStore: RunStore;
  /** Where buffered parent/root operations wait between flushes. Defaults to an in-process buffer. */
  buffer?: MetadataOperationBuffer;
  flushIntervalMs?: number;
  flushEnabled?: boolean;
  flushLoggingEnabled?: boolean;
  /** Runs claimed per drain batch. */
  drainBatchSize?: number;
  /** Retries of one run's flush before its operations go back to the buffer for a later tick. */
  flushMaxRetries?: number;
  maximumSize?: number;
  /** How long after a batch's first throw the flusher keeps splitting it; after that a failing segment is dropped whole. */
  salvageBudgetMs?: number;
  logger?: Logger;
  logLevel?: LogLevel;
  /** Called after the batched flusher writes a run's buffered operations, with everything
   * a realtime change record needs — buffered (parent/root) updates otherwise never wake
   * live feeds. */
  onRunFlushed?: (run: {
    runId: string;
    environmentId: string;
    tags: string[];
    batchId: string | null;
    updatedAtMs: number;
  }) => void;
  meter?: Meter;
  // Testing hooks
  onBeforeUpdate?: (runId: string) => Promise<void>;
  onAfterRead?: (runId: string, metadataVersion: number) => Promise<void>;
};

type RequeueReason =
  | "retries_exhausted"
  | "unknown_outcome"
  | "not_sent"
  | "claim_lost"
  | "read_failed";

type DropReason = "apply_failed" | "too_large" | "run_missing" | "invalid_packet" | "defect";

export class UpdateMetadataService {
  private readonly _buffer: MetadataOperationBuffer;
  private _flushFiber: RuntimeFiber<void> | null = null;
  private readonly _prisma: PrismaClientOrTransaction;
  private readonly _runStore: RunStore;
  private readonly flushIntervalMs: number;
  private readonly flushEnabled: boolean;
  private readonly flushLoggingEnabled: boolean;
  private readonly drainBatchSize: number;
  private readonly flushMaxRetries: number;
  private readonly maximumSize: number;
  private readonly salvageBudgetMs: number;
  private readonly logger: Logger;
  private readonly requeueCounter: Counter;
  private readonly dropCounter: Counter;
  private runsPending: number | undefined;

  constructor(private readonly options: UpdateMetadataServiceOptions) {
    this._prisma = options.prisma;
    this._runStore = options.runStore;
    this._buffer = options.buffer ?? new InMemoryMetadataOperationBuffer();
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.flushEnabled = options.flushEnabled ?? true;
    this.flushLoggingEnabled = options.flushLoggingEnabled ?? true;
    this.drainBatchSize = options.drainBatchSize ?? 10;
    this.flushMaxRetries = options.flushMaxRetries ?? 5;
    this.maximumSize = options.maximumSize ?? 1024 * 1024 * 1; // 1MB
    this.salvageBudgetMs = options.salvageBudgetMs ?? 50;
    this.logger = options.logger ?? new Logger("UpdateMetadataService", options.logLevel ?? "info");

    const meter = options.meter ?? getMeter("metadata-flush");
    this.requeueCounter = meter.createCounter("metadata.buffer.requeues", {
      description:
        "Runs whose buffered metadata operations were not written on this attempt, by reason",
      unit: "runs",
    });
    this.dropCounter = meter.createCounter("metadata.buffer.drops", {
      description: "Buffered metadata operations the flusher dropped, by reason",
      unit: "operations",
    });
    meter
      .createObservableGauge("metadata.buffer.runs_pending", {
        description:
          "Runs with buffered metadata operations after the last drain. With the redis backend every process reports the shared total.",
        unit: "runs",
      })
      .addCallback((result) => {
        if (this.runsPending !== undefined) result.observe(this.runsPending);
      });

    this._startFlushing();
  }

  // Start a loop that periodically flushes buffered operations
  private _startFlushing() {
    if (!this.flushEnabled) {
      this.logger.info("[UpdateMetadataService] 🚽 Flushing disabled");

      return;
    }

    this.logger.info("[UpdateMetadataService] 🚽 Flushing started");

    // Create a program that sleeps, then processes buffered ops
    const program = Effect.gen(this, function* (_) {
      while (true) {
        // Wait for flushIntervalMs before flushing again
        yield* _(Effect.sleep(Duration.millis(this.flushIntervalMs)));

        yield* _(
          this._drainBufferedOperations().pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                this.logger.error("[UpdateMetadataService] Failed to drain buffered operations", {
                  error: Cause.squash(cause),
                });
              })
            )
          )
        );
      }
    }).pipe(
      // Handle any unexpected errors, ensuring program does not fail
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.logger.error("Error in flushing program:", { error });
        })
      )
    );

    // Fork the program so it runs in the background
    this._flushFiber = Effect.runFork(program as Effect.Effect<void, never, never>);
  }

  stopFlushing() {
    if (this._flushFiber) {
      Effect.runFork(Fiber.interrupt(this._flushFiber));
    }
  }

  private _drainBufferedOperations = (includeNotYetDue = false) => {
    return Effect.gen(this, function* (_) {
      for (let i = 0; i < MAX_DRAIN_BATCHES_PER_TICK; i++) {
        const claims = yield* _(
          Effect.tryPromise(() => this._buffer.claimDue(this.drainBatchSize, { includeNotYetDue }))
        );

        if (claims.length === 0) {
          break;
        }

        for (const claim of claims) {
          yield* _(
            this._processClaim(claim).pipe(
              Effect.catchAllDefect((defect) => {
                this.logger.error(
                  "[UpdateMetadataService] Dropping a claim whose processing threw",
                  {
                    runId: claim.runId,
                    error: defect,
                  }
                );
                return this.#ackWithDrops(claim, "defect");
              })
            )
          );
        }

        if (claims.length < this.drainBatchSize) {
          break;
        }
      }

      const pending = yield* _(Effect.tryPromise(() => this._buffer.size()).pipe(Effect.option));
      if (Option.isSome(pending)) {
        this.runsPending = pending.value;
      }
    });
  };

  private _processClaim = (claim: MetadataBufferClaim) => {
    return Effect.gen(this, function* (_) {
      const runId = claim.runId;
      const processedOps = this._cullOperations(claim.operations);

      if (processedOps.length === 0) {
        yield* _(this._ackClaim(claim));
        return;
      }

      yield* Effect.sync(() => {
        if (this.flushLoggingEnabled) {
          this.logger.debug(`[UpdateMetadataService] Processing operations for run`, {
            runId,
            operationsCount: processedOps.length,
          });
        }
      });

      if (claim.pendingWrite) {
        const pendingWrite = claim.pendingWrite;
        const current = yield* _(
          Effect.tryPromise(() =>
            this._runStore.findRun(
              { id: runId },
              { select: { metadataVersion: true } },
              this._prisma
            )
          ).pipe(Effect.either)
        );

        if (Either.isLeft(current)) {
          this.#recordRequeue("read_failed");
          yield* _(this._requeueClaim(claim, { keepPendingWrite: true }));
          return;
        }

        if (!current.right) {
          yield* _(this.#ackWithDrops(claim, "run_missing"));
          return;
        }

        if (current.right.metadataVersion > pendingWrite.metadataVersion) {
          yield* Effect.sync(() => {
            this.logger.info(
              `[UpdateMetadataService] Skipping operations already written for run`,
              {
                runId,
                operationsCount: pendingWrite.count,
                metadataVersion: pendingWrite.metadataVersion,
              }
            );
          });
          yield* _(this._ackClaim(claim, { count: pendingWrite.count }));
          return;
        }
      }

      const dropped: DroppedOperation[] = [];
      yield* _(
        this._updateRunWithOperations(claim, processedOps, dropped).pipe(
          // Catch MetadataTooLargeError before retry logic
          Effect.catchIf(
            (error) => error instanceof MetadataTooLargeError,
            (error) =>
              Effect.sync(() => {
                console.error(
                  `[UpdateMetadataService] Dropping operations for run ${runId} due to metadata size limit:`,
                  error.message
                );
                if (this.flushLoggingEnabled) {
                  this.logger.warn(`[UpdateMetadataService] Metadata too large for run`, {
                    runId,
                    operationsCount: claim.operations.length,
                    error: error.message,
                  });
                }
                return "too_large" as const;
              })
          ),
          Effect.retry({
            schedule: Schedule.exponential(Duration.millis(100), 1.4).pipe(
              Schedule.intersect(Schedule.recurs(this.flushMaxRetries))
            ),
            while: (error) =>
              !isClaimLost(error) && !isWriteOutcomeUnknown(error) && !isWriteNotSent(error),
          }),
          Effect.matchEffect({
            onSuccess: (wholeReason) => this.#ackWithDrops(claim, wholeReason, dropped),
            onFailure: (error) =>
              Effect.gen(this, function* (__) {
                if (isClaimLost(error)) {
                  yield* __(
                    Effect.sync(() => {
                      this.#recordRequeue("claim_lost");
                      this.logger.warn(`[UpdateMetadataService] Lost the claim for run`, {
                        runId,
                      });
                      this._buffer.abandon(claim);
                    })
                  );
                  return;
                }

                yield* __(
                  Effect.sync(() => {
                    this.#recordRequeue(
                      isWriteOutcomeUnknown(error)
                        ? "unknown_outcome"
                        : isWriteNotSent(error)
                          ? "not_sent"
                          : "retries_exhausted"
                    );
                    this.logger.warn(`[UpdateMetadataService] Requeueing operations for run`, {
                      runId,
                      operationsCount: claim.operations.length,
                      error,
                    });
                  })
                );
                yield* __(
                  this._requeueClaim(claim, {
                    keepPendingWrite: isWriteOutcomeUnknown(error),
                  })
                );
              }),
          })
        )
      );
    });
  };

  #recordRequeue(reason: RequeueReason) {
    this.requeueCounter.add(1, { reason });
  }

  #recordDrop(reason: DropReason, count: number) {
    this.dropCounter.add(count, { reason });
  }

  #ackWithDrops(
    claim: MetadataBufferClaim,
    wholeReason?: DropReason,
    dropped: DroppedOperation[] = []
  ) {
    if (wholeReason) {
      this.#recordDrop(wholeReason, claim.operations.length - dropped.length);
    }
    if (dropped.length > 0) {
      this.#recordDrop("apply_failed", dropped.length);
      this.logger.warn(`[UpdateMetadataService] Dropped operations that could not be applied`, {
        runId: claim.runId,
        droppedCount: dropped.length,
        dropped: dropped.slice(0, MAX_DROPS_LOGGED).map(({ operation, error }) => ({
          type: operation.type,
          key: loggedKey(operation),
          error: String(error).slice(0, MAX_LOGGED_CHARS),
        })),
      });
    }
    return this._ackClaim(claim);
  }

  private _ackClaim = (claim: MetadataBufferClaim, options?: { count?: number }) =>
    Effect.tryPromise(() => this._buffer.ack(claim, options)).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.logger.error(`[UpdateMetadataService] Failed to ack buffered operations`, {
            runId: claim.runId,
            error,
          });
        })
      )
    );

  private _requeueClaim = (claim: MetadataBufferClaim, options?: { keepPendingWrite?: boolean }) =>
    Effect.tryPromise(() => this._buffer.requeue(claim, options)).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.logger.error(`[UpdateMetadataService] Failed to requeue buffered operations`, {
            runId: claim.runId,
            error,
          });
        })
      )
    );

  private _updateRunWithOperations = (
    claim: MetadataBufferClaim,
    operations: BufferedRunMetadataChangeOperation[],
    dropped: DroppedOperation[]
  ) => {
    const runId = claim.runId;
    return Effect.gen(this, function* (_) {
      // Fetch current run (+ the realtime membership keys, so a flush can publish)
      const run = yield* _(
        Effect.tryPromise(() =>
          this._runStore.findRun(
            { id: runId },
            {
              select: {
                id: true,
                metadata: true,
                metadataType: true,
                metadataVersion: true,
                runtimeEnvironmentId: true,
                runTags: true,
                batchId: true,
              },
            },
            this._prisma
          )
        )
      );

      if (!run) {
        this.logger.warn(`[UpdateMetadataService] Dropping operations for missing run`, {
          runId,
          operationsCount: claim.operations.length,
        });
        return "run_missing" as const;
      }

      // Testing hook after read
      if (this.options.onAfterRead) {
        yield* _(Effect.tryPromise(() => this.options.onAfterRead!(runId, run.metadataVersion)));
      }

      const metadata = yield* _(
        Effect.tryPromise(() =>
          run.metadata
            ? parsePacket({ data: run.metadata, dataType: run.metadataType })
            : Promise.resolve({})
        )
      );

      const skip = new Set(dropped.map(({ operation }) => operation));
      const attempted = operations
        .map((op) => op.operation)
        .filter((operation) => !skip.has(operation));
      const applyResult = applyOrSalvage(metadata, attempted, this.salvageBudgetMs);
      dropped.push(...applyResult.dropped);
      if (applyResult.applied === 0) {
        this.logger.warn(`No operations applied for run ${runId}`);
        return;
      }

      // Stringify the metadata
      const newMetadataPacket = yield* _(
        Effect.try(() =>
          handleMetadataPacket(applyResult.newMetadata, run.metadataType, this.maximumSize)
        ).pipe(
          Effect.mapError((error) => {
            // Preserve the original error if it's MetadataTooLargeError
            if ("cause" in error && error.cause instanceof MetadataTooLargeError) {
              return error.cause;
            }
            return error;
          })
        )
      );

      if (!newMetadataPacket) {
        // Log and skip if metadata is invalid
        this.logger.warn(`Invalid metadata after operations, skipping update`);
        return "invalid_packet" as const;
      }

      // Testing hook before update
      if (this.options.onBeforeUpdate) {
        yield* _(Effect.tryPromise(() => this.options.onBeforeUpdate!(runId)));
      }

      // Stamp updatedAt explicitly so the realtime publish can carry the exact committed
      // value without a follow-up read (updateMany can't RETURNING).
      const stillClaimed = yield* _(
        Effect.tryPromise(() => this._buffer.recordPendingWrite(claim, run.metadataVersion))
      );

      if (!stillClaimed) {
        return yield* _(Effect.fail(new MetadataClaimLostError(runId)));
      }

      const writeTime = new Date();
      const result = yield* _(
        Effect.tryPromise({
          try: () =>
            this._runStore.updateMetadata(
              runId,
              {
                metadata: newMetadataPacket.data!,
                metadataVersion: { increment: 1 },
                updatedAt: writeTime,
              },
              { expectedMetadataVersion: run.metadataVersion },
              this._prisma
            ),
          catch: (cause) =>
            writeNeverReachedDatabase(cause)
              ? new MetadataWriteNotSentError(runId, cause)
              : new MetadataWriteOutcomeUnknownError(runId, cause),
        })
      );

      if (result.count === 0) {
        yield* Effect.sync(() => {
          this.logger.warn(`Optimistic lock failed for run ${runId}`, {
            metadataVersion: run.metadataVersion,
          });
        });

        return yield* _(Effect.fail(new Error("Optimistic lock failed")));
      }

      yield* Effect.sync(() => {
        try {
          this.options.onRunFlushed?.({
            runId,
            environmentId: run.runtimeEnvironmentId,
            tags: run.runTags,
            batchId: run.batchId,
            updatedAtMs: writeTime.getTime(),
          });
        } catch (error) {
          this.logger.error("[UpdateMetadataService] onRunFlushed threw after the write", {
            runId,
            error,
          });
        }
      });
    });
  };

  private _cullOperations(
    operations: BufferedRunMetadataChangeOperation[]
  ): BufferedRunMetadataChangeOperation[] {
    // Sort by timestamp
    const sortedOps = [...operations].sort((a, b) => a.timestamp - b.timestamp);

    // Track latest set operations by key
    const latestSetOps = new Map<string, BufferedRunMetadataChangeOperation>();
    const resultOps: BufferedRunMetadataChangeOperation[] = [];

    for (const op of sortedOps) {
      if (op.operation.type === "set") {
        latestSetOps.set(op.operation.key, op);
      } else {
        resultOps.push(op);
      }
    }

    // Add winning set operations
    resultOps.push(...latestSetOps.values());

    return resultOps;
  }

  /**
   * `requestIdempotencyKey` is the SDK's per-request key, reused across its automatic retries.
   * Buffered operations ingested under it are recorded once, so a retried request is not buffered twice.
   */
  public async call(
    runId: string,
    body: UpdateMetadataRequestBody,
    environment?: AuthenticatedEnvironment,
    options?: { requestIdempotencyKey?: string; ability?: RbacAbility }
  ) {
    const ingestId = (kind: "parent" | "root" | "self", targetRunId: string) =>
      options?.requestIdempotencyKey
        ? `${options.requestIdempotencyKey}:${kind}:${targetRunId}`
        : undefined;

    const runIdType = runId.startsWith("run_") ? "friendly" : "internal";

    const taskRun = await this._runStore.findRun(
      environment
        ? {
            runtimeEnvironmentId: environment.id,
            ...(runIdType === "internal" ? { id: runId } : { friendlyId: runId }),
          }
        : {
            ...(runIdType === "internal" ? { id: runId } : { friendlyId: runId }),
          },
      {
        select: {
          id: true,
          friendlyId: true,
          batchId: true,
          runTags: true,
          completedAt: true,
          status: true,
          metadata: true,
          metadataType: true,
          metadataVersion: true,
          parentTaskRun: {
            select: {
              id: true,
              friendlyId: true,
              runtimeEnvironmentId: true,
              status: true,
            },
          },
          rootTaskRun: {
            select: {
              id: true,
              friendlyId: true,
              runtimeEnvironmentId: true,
              status: true,
            },
          },
        },
      },
      this._prisma
    );

    if (!taskRun) {
      return;
    }

    if (options?.ability) {
      authorizeMetadataTargets(options.ability, body, {
        runId: taskRun.friendlyId,
        parentRunId: taskRun.parentTaskRun?.friendlyId,
        rootRunId: taskRun.rootTaskRun?.friendlyId,
      });
    }
    if (environment) {
      const targets = [
        ...(body.parentOperations?.length ? [taskRun.parentTaskRun] : []),
        ...(body.rootOperations?.length ? [taskRun.rootTaskRun] : []),
      ];
      if (targets.some((target) => target && target.runtimeEnvironmentId !== environment.id)) {
        throw new ServiceValidationError("Task Run not found", 404);
      }
    }

    if (!this.#isRunUpdatable(taskRun)) {
      throw new ServiceValidationError("Cannot update metadata for a completed run");
    }

    if (body.parentOperations && body.parentOperations.length > 0) {
      const parentRunId = taskRun.parentTaskRun?.id ?? taskRun.id;
      await this.#ingestRunOperations(
        parentRunId,
        body.parentOperations,
        ingestId("parent", parentRunId)
      );
    }

    if (body.rootOperations && body.rootOperations.length > 0) {
      const rootRunId = taskRun.rootTaskRun?.id ?? taskRun.id;
      await this.#ingestRunOperations(rootRunId, body.rootOperations, ingestId("root", rootRunId));
    }

    const result = await this.#updateRunMetadata({
      runId: taskRun.id,
      body,
      ingestId: ingestId("self", taskRun.id),
      existingMetadata: {
        data: taskRun.metadata ?? undefined,
        dataType: taskRun.metadataType,
      },
    });

    return {
      metadata: result?.metadata,
      // Internal id + membership keys, so callers can publish full realtime records the router routes by index.
      runId: taskRun.id,
      batchId: taskRun.batchId,
      runTags: taskRun.runTags,
      // The committed row's updatedAt — the realtime watermark. Undefined when nothing was
      // written here (no-op, or buffered for the flusher, which publishes itself).
      updatedAtMs: result?.updatedAtMs,
    };
  }

  async #updateRunMetadata({
    runId,
    body,
    ingestId,
    existingMetadata,
  }: {
    runId: string;
    body: UpdateMetadataRequestBody;
    ingestId?: string;
    existingMetadata: IOPacket;
  }): Promise<{ metadata: Record<string, unknown> | undefined; updatedAtMs?: number }> {
    if (Array.isArray(body.operations)) {
      return this.#updateRunMetadataWithOperations(runId, body.operations, ingestId);
    } else {
      return this.#updateRunMetadataDirectly(runId, body, existingMetadata);
    }
  }

  async #updateRunMetadataWithOperations(
    runId: string,
    operations: RunMetadataChangeOperation[],
    ingestId?: string
  ): Promise<{ metadata: Record<string, unknown> | undefined; updatedAtMs?: number }> {
    const MAX_RETRIES = 3;
    let attempts = 0;

    while (attempts <= MAX_RETRIES) {
      // Fetch the latest run data
      const run = await this._runStore.findRun(
        { id: runId },
        {
          select: { metadata: true, metadataType: true, metadataVersion: true },
        },
        this._prisma
      );

      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      // Testing hook after read
      if (this.options.onAfterRead) {
        await this.options.onAfterRead(runId, run.metadataVersion);
      }

      // Parse the current metadata
      const currentMetadata = await (run.metadata
        ? parsePacket({ data: run.metadata, dataType: run.metadataType })
        : Promise.resolve({}));

      // Apply operations to the current metadata
      const applyResults = applyMetadataOperations(currentMetadata, operations);

      // If no operations were applied, return the current metadata (nothing written)
      if (applyResults.unappliedOperations.length === operations.length) {
        return { metadata: currentMetadata };
      }

      const newMetadataPacket = handleMetadataPacket(
        applyResults.newMetadata,
        run.metadataType,
        this.maximumSize
      );

      if (!newMetadataPacket) {
        throw new ServiceValidationError("Unable to update metadata");
      }

      // Testing hook before update
      if (this.options.onBeforeUpdate) {
        await this.options.onBeforeUpdate(runId);
      }

      // Update with optimistic locking; updatedAt stamped explicitly so the caller can
      // publish the exact committed watermark without a follow-up read.
      const writeTime = new Date();
      const result = await this._runStore.updateMetadata(
        runId,
        {
          metadata: newMetadataPacket.data!,
          metadataType: newMetadataPacket.dataType,
          metadataVersion: {
            increment: 1,
          },
          updatedAt: writeTime,
        },
        { expectedMetadataVersion: run.metadataVersion },
        this._prisma
      );

      if (result.count === 0) {
        if (this.flushLoggingEnabled) {
          this.logger.debug(
            `[updateRunMetadataWithOperations] Optimistic lock failed for run ${runId}`,
            {
              metadataVersion: run.metadataVersion,
            }
          );
        }

        // If this was our last attempt, buffer the operations and return optimistically
        // (no watermark — the flusher writes later and publishes itself).
        if (attempts === MAX_RETRIES) {
          await this.#ingestRunOperations(runId, operations, ingestId);
          return { metadata: applyResults.newMetadata };
        }

        // Otherwise sleep and try again
        await setTimeout(100 * Math.pow(1.4, attempts));
        attempts++;
        continue;
      }

      if (this.flushLoggingEnabled) {
        this.logger.debug(`[updateRunMetadataWithOperations] Updated metadata for run`, {
          runId,
          metadataKeyCount: Object.keys(applyResults.newMetadata).length,
          operationCount: operations.length,
        });
      }

      // Success! Return the new metadata
      return { metadata: applyResults.newMetadata, updatedAtMs: writeTime.getTime() };
    }

    return { metadata: undefined };
  }

  // Checks to see if a run is updatable
  // if there is no completedAt, the run is updatable
  // if the run is completed, but the completedAt is within the last 10 minutes, the run is updatable
  #isRunUpdatable(run: { completedAt: Date | null }) {
    if (!run.completedAt) {
      return true;
    }

    return run.completedAt.getTime() > Date.now() - RUN_UPDATABLE_WINDOW_MS;
  }

  async #updateRunMetadataDirectly(
    runId: string,
    body: UpdateMetadataRequestBody,
    existingMetadata: IOPacket
  ): Promise<{ metadata: Record<string, unknown> | undefined; updatedAtMs?: number }> {
    const metadataPacketWithByteLength = handleMetadataPacketWithByteLength(
      body.metadata,
      "application/json",
      this.maximumSize
    );

    if (!metadataPacketWithByteLength) {
      return { metadata: {} };
    }

    const { packet: metadataPacket, byteLength: metadataSizeBytes } = metadataPacketWithByteLength;

    let updatedAtMs: number | undefined;

    if (
      metadataPacket.data !== "{}" ||
      (existingMetadata.data && metadataPacket.data !== existingMetadata.data)
    ) {
      if (this.flushLoggingEnabled) {
        this.logger.debug(`[updateRunMetadataDirectly] Updating metadata directly for run`, {
          runId,
          metadataSizeBytes,
        });
      }

      // Update the metadata without version check; updatedAt stamped explicitly so the
      // caller can publish the exact committed watermark.
      const writeTime = new Date();
      await this._runStore.updateMetadata(
        runId,
        {
          metadata: metadataPacket.data!,
          metadataType: metadataPacket?.dataType,
          metadataVersion: {
            increment: 1,
          },
          updatedAt: writeTime,
        },
        {},
        this._prisma
      );
      updatedAtMs = writeTime.getTime();
    }

    const newMetadata = await parsePacket(metadataPacket);
    return { metadata: newMetadata, updatedAtMs };
  }

  async #ingestRunOperations(
    runId: string,
    operations: RunMetadataChangeOperation[],
    ingestId?: string
  ) {
    const fitting = operations.filter((operation) => {
      const value = (operation as { value?: unknown }).value;
      return value === undefined || Buffer.byteLength(JSON.stringify(value)) <= this.maximumSize;
    });

    if (fitting.length < operations.length) {
      this.logger.warn(
        `[UpdateMetadataService] Dropping metadata operations larger than the limit`,
        {
          runId,
          droppedCount: operations.length - fitting.length,
          maximumSize: this.maximumSize,
        }
      );
    }

    if (fitting.length === 0) return;
    operations = fitting;

    const bufferedOperations: BufferedRunMetadataChangeOperation[] = operations.map((operation) => {
      return {
        runId,
        timestamp: Date.now(),
        operation,
      };
    });

    if (this.flushLoggingEnabled) {
      this.logger.debug(`[ingestRunOperations] Ingesting operations for run`, {
        runId,
        operationCount: bufferedOperations.length,
      });
    }

    try {
      await this._buffer.ingest(runId, bufferedOperations, { ingestId });
    } catch (error) {
      if (error instanceof MetadataBufferFullError) {
        throw new ServiceValidationError(error.message, 429);
      }
      throw error;
    }
  }

  /** Drains every buffered run now, ignoring the flush schedule. */
  async flushOperations() {
    await Effect.runPromise(this._drainBufferedOperations(true));
  }
}
