import { Logger } from "@trigger.dev/core/logger";
import { Redis } from "ioredis";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { MarQS, marqs as marqsv3 } from "./index.server";
import { env } from "~/env.server";

export type MarqsConcurrencyMonitorOptions = {
  dryRun?: boolean;
  abortSignal?: AbortSignal;
};

export interface MarqsConcurrencyResolveCompletedRunsCallback {
  (candidateRunIds: string[]): Promise<Array<{ id: string }>>;
}

export class MarqsConcurrencyMonitor {
  private _logger: Logger;

  constructor(
    private marqs: MarQS,
    private callback: MarqsConcurrencyResolveCompletedRunsCallback,
    private options: MarqsConcurrencyMonitorOptions = {}
  ) {
    this._logger = logger.child({
      component: "marqs",
      operation: "concurrencyMonitor",
      dryRun: this.dryRun,
      marqs: marqs.name,
    });
  }

  get dryRun() {
    return typeof this.options.dryRun === "boolean" ? this.options.dryRun : false;
  }

  get keys() {
    return this.marqs.keys;
  }

  get signal() {
    return this.options.abortSignal;
  }

  public async call() {
    this._logger.debug("[MarqsConcurrencyMonitor] Initiating monitoring");

    const stats = {
      streamCallbacks: 0,
      processedKeys: 0,
    };

    const { stream, redis } = this.marqs.queueConcurrencyScanStream(
      10,
      () => {
        this._logger.debug("[MarqsConcurrencyMonitor] stream closed", {
          stats,
        });
      },
      (error) => {
        this._logger.debug("[MarqsConcurrencyMonitor] stream error", {
          stats,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });
      }
    );

    stream.on("data", async (keys) => {
      stream.pause();

      if (this.signal?.aborted) {
        stream.destroy();
        return;
      }

      stats.streamCallbacks++;

      const uniqueKeys = Array.from(new Set<string>(keys));

      if (uniqueKeys.length === 0) {
        stream.resume();
        return;
      }

      this._logger.debug("[MarqsConcurrencyMonitor] correcting queues concurrency", {
        keys: uniqueKeys,
      });

      stats.processedKeys += uniqueKeys.length;

      await Promise.allSettled(uniqueKeys.map((key) => this.#processKey(key, redis))).finally(
        () => {
          stream.resume();
        }
      );
    });
  }

  async #processKey(key: string, redis: Redis) {
    key = this.keys.stripKeyPrefix(key);
    const envKey = this.keys.envCurrentConcurrencyKeyFromQueue(key);

    let runIds: string[] = [];

    try {
      // Next, we need to get all the items from the key, and any parent keys (org, env, queue) using sunion.
      runIds = await redis.sunion(envKey, key);
    } catch (e) {
      this._logger.error("[MarqsConcurrencyMonitor] error during sunion", {
        key,
        envKey,
        runIds,
        error: e,
      });
    }

    if (runIds.length === 0) {
      return;
    }

    const perfNow = performance.now();

    const completeRuns = await this.callback(runIds);

    const durationMs = performance.now() - perfNow;

    const completedRunIds = completeRuns.map((run) => run.id);

    if (completedRunIds.length === 0) {
      this._logger.debug("[MarqsConcurrencyMonitor] no completed runs found", {
        key,
        envKey,
        runIds,
        durationMs,
      });

      return;
    }

    this._logger.debug("[MarqsConcurrencyMonitor] removing completed runs from queue", {
      key,
      envKey,
      completedRunIds,
      durationMs,
    });

    if (this.dryRun) {
      return;
    }

    const pipeline = redis.pipeline();

    pipeline.srem(key, ...completedRunIds);
    pipeline.srem(envKey, ...completedRunIds);

    try {
      await pipeline.exec();
    } catch (e) {
      this._logger.error("[MarqsConcurrencyMonitor] error removing completed runs from queue", {
        key,
        envKey,
        completedRunIds,
        error: e,
      });
    }
  }

  static async initiateV3Monitoring(abortSignal?: AbortSignal) {
    if (!marqsv3) {
      return;
    }

    const instance = new MarqsConcurrencyMonitor(
      marqsv3,
      (runIds) =>
        prisma.taskRun.findMany({
          select: { id: true },
          where: {
            id: {
              in: runIds,
            },
            status: {
              in: [
                "CANCELED",
                "COMPLETED_SUCCESSFULLY",
                "COMPLETED_WITH_ERRORS",
                "CRASHED",
                "SYSTEM_FAILURE",
                "INTERRUPTED",
              ],
            },
          },
        }),
      { dryRun: env.V3_MARQS_CONCURRENCY_MONITOR_ENABLED === "0", abortSignal }
    );

    await instance.call();
  }
}
