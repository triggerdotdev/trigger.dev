import {
  applyMetadataOperations,
  IOPacket,
  parsePacket,
  RunMetadataChangeOperation,
  UpdateMetadataRequestBody,
} from "@trigger.dev/core/v3";
import { prisma, PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { handleMetadataPacket } from "~/utils/packets";
import { BaseService, ServiceValidationError } from "~/v3/services/baseService.server";

import { Effect, Schedule, Duration } from "effect";
import { type RuntimeFiber } from "effect/Fiber";
import { logger } from "../logger.server";
import { singleton } from "~/utils/singleton";
import { env } from "~/env.server";
import { setTimeout } from "timers/promises";

const RUN_UPDATABLE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

type BufferedRunMetadataChangeOperation = {
  runId: string;
  timestamp: number;
  operation: RunMetadataChangeOperation;
};

export class UpdateMetadataService extends BaseService {
  private _bufferedOperations: Map<string, BufferedRunMetadataChangeOperation[]> = new Map();
  private _flushFiber: RuntimeFiber<void> | null = null;

  constructor(
    protected readonly _prisma: PrismaClientOrTransaction = prisma,
    private readonly flushIntervalMs: number = 5000,
    private readonly flushEnabled: boolean = true,
    private readonly flushLoggingEnabled: boolean = true
  ) {
    super();

    this._startFlushing();
  }

  // Start a loop that periodically flushes buffered operations
  private _startFlushing() {
    if (!this.flushEnabled) {
      logger.info("[UpdateMetadataService] 🚽 Flushing disabled");

      return;
    }

    logger.info("[UpdateMetadataService] 🚽 Flushing started");

    // Create a program that sleeps, then processes buffered ops
    const program = Effect.gen(this, function* (_) {
      while (true) {
        // Wait for flushIntervalMs before flushing again
        yield* _(Effect.sleep(Duration.millis(this.flushIntervalMs)));

        // Atomically get and clear current operations
        const currentOperations = new Map(this._bufferedOperations);
        this._bufferedOperations.clear();

        yield* Effect.sync(() => {
          if (this.flushLoggingEnabled) {
            logger.debug(`[UpdateMetadataService] Flushing operations`, {
              operations: Object.fromEntries(currentOperations),
            });
          }
        });

        // If we have operations, process them
        if (currentOperations.size > 0) {
          yield* _(this._processBufferedOperations(currentOperations));
        }
      }
    }).pipe(
      // Handle any unexpected errors, ensuring program does not fail
      Effect.catchAll((error) =>
        Effect.sync(() => {
          logger.error("Error in flushing program:", { error });
        })
      )
    );

    // Fork the program so it runs in the background
    this._flushFiber = Effect.runFork(program as Effect.Effect<void, never, never>);
  }

  private _processBufferedOperations = (
    operations: Map<string, BufferedRunMetadataChangeOperation[]>
  ) => {
    return Effect.gen(this, function* (_) {
      for (const [runId, ops] of operations) {
        // Process and cull operations
        const processedOps = this._cullOperations(ops);

        // If there are no operations to process, skip
        if (processedOps.length === 0) {
          continue;
        }

        yield* Effect.sync(() => {
          if (this.flushLoggingEnabled) {
            logger.debug(`[UpdateMetadataService] Processing operations for run`, {
              runId,
              operationsCount: processedOps.length,
            });
          }
        });

        // Update run with retry
        yield* _(
          this._updateRunWithOperations(runId, processedOps).pipe(
            Effect.retry(Schedule.exponential(Duration.millis(100), 1.4)),
            Effect.catchAll((error) =>
              Effect.sync(() => {
                // On complete failure, return ops to buffer
                const existingOps = this._bufferedOperations.get(runId) ?? [];
                this._bufferedOperations.set(runId, [...existingOps, ...ops]);
                console.error(`Failed to process run ${runId}:`, error);
              })
            )
          )
        );
      }
    });
  };

  private _updateRunWithOperations = (
    runId: string,
    operations: BufferedRunMetadataChangeOperation[]
  ) => {
    return Effect.gen(this, function* (_) {
      // Fetch current run
      const run = yield* _(
        Effect.tryPromise(() =>
          this._prisma.taskRun.findFirst({
            where: { id: runId },
            select: { id: true, metadata: true, metadataType: true, metadataVersion: true },
          })
        )
      );

      if (!run) {
        return yield* _(Effect.fail(new Error(`Run ${runId} not found`)));
      }

      const metadata = yield* _(
        Effect.tryPromise(() =>
          run.metadata
            ? parsePacket({ data: run.metadata, dataType: run.metadataType })
            : Promise.resolve({})
        )
      );

      // Apply operations and update
      const applyResult = applyMetadataOperations(
        metadata,
        operations.map((op) => op.operation)
      );

      if (applyResult.unappliedOperations.length === operations.length) {
        logger.warn(`No operations applied for run ${runId}`);
        // If no operations were applied, return
        return;
      }

      // Stringify the metadata
      const newMetadataPacket = yield* _(
        Effect.try(() => handleMetadataPacket(applyResult.newMetadata, run.metadataType))
      );

      if (!newMetadataPacket) {
        // Log and skip if metadata is invalid
        logger.warn(`Invalid metadata after operations, skipping update`);
        return;
      }

      const result = yield* _(
        Effect.tryPromise(() =>
          this._prisma.taskRun.updateMany({
            where: {
              id: runId,
              metadataVersion: run.metadataVersion,
            },
            data: {
              metadata: newMetadataPacket.data,
              metadataVersion: { increment: 1 },
            },
          })
        )
      );

      if (result.count === 0) {
        yield* Effect.sync(() => {
          logger.warn(`Optimistic lock failed for run ${runId}`, {
            metadataVersion: run.metadataVersion,
          });
        });

        return yield* _(Effect.fail(new Error("Optimistic lock failed")));
      }

      return result;
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

  public async call(
    runId: string,
    body: UpdateMetadataRequestBody,
    environment?: AuthenticatedEnvironment
  ) {
    const runIdType = runId.startsWith("run_") ? "friendly" : "internal";

    const taskRun = await this._prisma.taskRun.findFirst({
      where: environment
        ? {
            runtimeEnvironmentId: environment.id,
            ...(runIdType === "internal" ? { id: runId } : { friendlyId: runId }),
          }
        : {
            ...(runIdType === "internal" ? { id: runId } : { friendlyId: runId }),
          },
      select: {
        id: true,
        completedAt: true,
        status: true,
        metadata: true,
        metadataType: true,
        metadataVersion: true,
        parentTaskRun: {
          select: {
            id: true,
            status: true,
          },
        },
        rootTaskRun: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!taskRun) {
      return;
    }

    if (!this.#isRunUpdatable(taskRun)) {
      throw new ServiceValidationError("Cannot update metadata for a completed run");
    }

    if (body.parentOperations && body.parentOperations.length > 0 && taskRun.parentTaskRun) {
      this.#ingestRunOperations(taskRun.parentTaskRun.id, body.parentOperations);
    }

    if (body.rootOperations && body.rootOperations.length > 0 && taskRun.rootTaskRun) {
      this.#ingestRunOperations(taskRun.rootTaskRun.id, body.rootOperations);
    }

    const newMetadata = await this.#updateRunMetadata({
      runId: taskRun.id,
      body,
      existingMetadata: {
        data: taskRun.metadata ?? undefined,
        dataType: taskRun.metadataType,
      },
    });

    return {
      metadata: newMetadata,
    };
  }

  async #updateRunMetadata({
    runId,
    body,
    existingMetadata,
  }: {
    runId: string;
    body: UpdateMetadataRequestBody;
    existingMetadata: IOPacket;
  }) {
    if (Array.isArray(body.operations)) {
      return this.#updateRunMetadataWithOperations(runId, body.operations);
    } else {
      return this.#updateRunMetadataDirectly(runId, body, existingMetadata);
    }
  }

  async #updateRunMetadataWithOperations(runId: string, operations: RunMetadataChangeOperation[]) {
    const MAX_RETRIES = 3;
    let attempts = 0;

    while (attempts <= MAX_RETRIES) {
      // Fetch the latest run data
      const run = await this._prisma.taskRun.findFirst({
        where: { id: runId },
        select: { metadata: true, metadataType: true, metadataVersion: true },
      });

      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      // Parse the current metadata
      const currentMetadata = await (run.metadata
        ? parsePacket({ data: run.metadata, dataType: run.metadataType })
        : Promise.resolve({}));

      // Apply operations to the current metadata
      const applyResults = applyMetadataOperations(currentMetadata, operations);

      // If no operations were applied, return the current metadata
      if (applyResults.unappliedOperations.length === operations.length) {
        return currentMetadata;
      }

      // Update with optimistic locking
      const result = await this._prisma.taskRun.updateMany({
        where: {
          id: runId,
          metadataVersion: run.metadataVersion,
        },
        data: {
          metadata: JSON.stringify(applyResults.newMetadata),
          metadataType: run.metadataType,
          metadataVersion: {
            increment: 1,
          },
        },
      });

      if (result.count === 0) {
        if (this.flushLoggingEnabled) {
          logger.debug(
            `[UpdateMetadataService][updateRunMetadataWithOperations] Optimistic lock failed for run ${runId}`,
            {
              metadataVersion: run.metadataVersion,
            }
          );
        }

        // If this was our last attempt, buffer the operations and return optimistically
        if (attempts === MAX_RETRIES) {
          this.#ingestRunOperations(runId, operations);
          return applyResults.newMetadata;
        }

        // Otherwise sleep and try again
        await setTimeout(100 * Math.pow(1.4, attempts));
        attempts++;
        continue;
      }

      if (this.flushLoggingEnabled) {
        logger.debug(
          `[UpdateMetadataService][updateRunMetadataWithOperations] Updated metadata for run ${runId}`,
          {
            metadata: applyResults.newMetadata,
            operations: operations,
          }
        );
      }

      // Success! Return the new metadata
      return applyResults.newMetadata;
    }
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
  ) {
    const metadataPacket = handleMetadataPacket(body.metadata, "application/json");

    if (!metadataPacket) {
      throw new ServiceValidationError("Invalid metadata");
    }

    if (
      metadataPacket.data !== "{}" ||
      (existingMetadata.data && metadataPacket.data !== existingMetadata.data)
    ) {
      if (this.flushLoggingEnabled) {
        logger.debug(
          `[UpdateMetadataService][updateRunMetadataDirectly] Updating metadata directly for run`,
          {
            metadata: metadataPacket.data,
            runId,
          }
        );
      }

      // Update the metadata without version check
      await this._prisma.taskRun.update({
        where: {
          id: runId,
        },
        data: {
          metadata: metadataPacket?.data,
          metadataType: metadataPacket?.dataType,
          metadataVersion: {
            increment: 1,
          },
        },
      });
    }

    const newMetadata = await parsePacket(metadataPacket);
    return newMetadata;
  }

  #ingestRunOperations(runId: string, operations: RunMetadataChangeOperation[]) {
    const bufferedOperations: BufferedRunMetadataChangeOperation[] = operations.map((operation) => {
      return {
        runId,
        timestamp: Date.now(),
        operation,
      };
    });

    if (this.flushLoggingEnabled) {
      logger.debug(`[UpdateMetadataService] Ingesting operations for run`, {
        runId,
        bufferedOperations,
      });
    }

    const existingBufferedOperations = this._bufferedOperations.get(runId) ?? [];

    this._bufferedOperations.set(runId, [...existingBufferedOperations, ...bufferedOperations]);
  }
}

export const updateMetadataService = singleton(
  "update-metadata-service",
  () =>
    new UpdateMetadataService(
      prisma,
      env.BATCH_METADATA_OPERATIONS_FLUSH_INTERVAL_MS,
      env.BATCH_METADATA_OPERATIONS_FLUSH_ENABLED === "1",
      env.BATCH_METADATA_OPERATIONS_FLUSH_LOGGING_ENABLED === "1"
    )
);
