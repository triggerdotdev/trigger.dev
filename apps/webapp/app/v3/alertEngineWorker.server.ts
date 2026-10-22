import { Logger } from "@trigger.dev/core/logger";
import { CronSchema, Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { isOrganizationAlertsEnabled } from "./canUseAlertsList.server";
import { isAlertsConfigured } from "./services/alerts/alertsConfigured.server";
import {
  alertEvaluationJobs,
  EVALUATION_LEASE_GRACE_MS,
  runEvaluateAlertJob,
} from "./services/alerts/engine/evaluateAlertJob.server";
import { gateAlertJob } from "./services/alerts/engine/gateAlertJob";
import { createProductionEvaluateBinding } from "./services/alerts/engine/productionEvaluateBinding.server";
import {
  enqueueBootReconcile,
  RECONCILE_CRON,
  reconcileAlertJobs,
  redisReconcileCursorStore,
} from "./services/alerts/engine/reconcileAlertJobs.server";

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "alerts:engine:",
    host: env.ALERT_ENGINE_WORKER_REDIS_HOST,
    port: env.ALERT_ENGINE_WORKER_REDIS_PORT,
    username: env.ALERT_ENGINE_WORKER_REDIS_USERNAME,
    password: env.ALERT_ENGINE_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.ALERT_ENGINE_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  const alertsConfigured = isAlertsConfigured({
    alertsEnabled: env.ALERTS_ENABLED,
  });

  const reconcileCursorStore = redisReconcileCursorStore(
    createRedisClient("alerts:engine:reconcile", {
      keyPrefix: redisOptions.keyPrefix,
      host: redisOptions.host,
      port: redisOptions.port,
      username: redisOptions.username,
      password: redisOptions.password,
      tlsDisabled: env.ALERT_ENGINE_WORKER_REDIS_TLS_DISABLED === "true",
    })
  );

  logger.debug(`👨‍🏭 Initializing alert engine worker at host ${env.ALERT_ENGINE_WORKER_REDIS_HOST}`);

  const worker = new RedisWorker({
    name: "alert-engine-worker",
    redisOptions,
    catalog: {
      "alerts.evaluate": {
        schema: z.object({ alertId: z.string() }),
        visibilityTimeoutMs: env.ALERT_ENGINE_WORKER_EVAL_VISIBILITY_TIMEOUT_MS,
        retry: {
          maxAttempts: 2,
        },
      },
      "alerts.reconcile": {
        schema: CronSchema,
        visibilityTimeoutMs: 300_000,
        ...(alertsConfigured ? { cron: RECONCILE_CRON, jitterInMs: 300_000 } : {}),
        retry: {
          maxAttempts: 1,
        },
      },
    },
    concurrency: {
      workers: env.ALERT_ENGINE_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.ALERT_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.ALERT_ENGINE_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.ALERT_ENGINE_WORKER_POLL_INTERVAL_MS,
    immediatePollIntervalMs: env.ALERT_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL_MS,
    shutdownTimeoutMs: env.ALERT_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("AlertEngineWorker", env.ALERT_ENGINE_WORKER_LOG_LEVEL),
    jobs: {
      "alerts.evaluate": gateAlertJob(alertsConfigured, async ({ payload }) => {
        await runEvaluateAlertJob(
          { alertId: payload.alertId, now: new Date() },
          {
            db: prisma,
            evaluateBinding: createProductionEvaluateBinding({
              queryConcurrency: env.ALERT_QUERY_CONCURRENCY,
              checkpointLookbackSec: env.ALERT_CHECKPOINT_LOOKBACK_SEC,
              queryEvaluatorConfig: {
                failureRateMinVolume: env.ALERT_FAILURE_RATE_MIN_VOLUME,
                snapshotRangeSec: env.ALERT_SNAPSHOT_RANGE_SEC,
              },
            }),
            windowSec: env.ALERT_ENGINE_WORKER_DISTRIBUTION_WINDOW_SECONDS,
            leaseMs: env.ALERT_ENGINE_WORKER_EVAL_VISIBILITY_TIMEOUT_MS + EVALUATION_LEASE_GRACE_MS,
            enqueue: enqueueAlertEvaluation,
            isOrganizationEnabled: isOrganizationAlertsEnabled,
            logger,
          }
        );
      }),
      "alerts.reconcile": gateAlertJob(alertsConfigured, async () => {
        const result = await reconcileAlertJobs(
          { now: new Date() },
          {
            db: prisma,
            enqueueOnce: enqueueAlertEvaluationOnce,
            cursorStore: reconcileCursorStore,
            logger,
          }
        );
        logger.info("alerts.reconcile", result);
      }),
    },
  });

  if (env.ALERT_ENGINE_WORKER_ENABLED === "true") {
    logger.debug(
      `👨‍🏭 Starting alert engine worker at host ${env.ALERT_ENGINE_WORKER_REDIS_HOST}, pollInterval = ${env.ALERT_ENGINE_WORKER_POLL_INTERVAL_MS}, immediatePollInterval = ${env.ALERT_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL_MS}, workers = ${env.ALERT_ENGINE_WORKER_CONCURRENCY_WORKERS}, tasksPerWorker = ${env.ALERT_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER}, concurrencyLimit = ${env.ALERT_ENGINE_WORKER_CONCURRENCY_LIMIT}`
    );

    worker.start();

    if (alertsConfigured) {
      enqueueBootReconcile(worker, new Date()).catch((error) => {
        logger.error("alerts.reconcile.boot_enqueue_failed", { error });
      });
    }
  }

  return worker;
}

const alertEngineWorker = singleton("alertEngineWorker", initializeWorker);

export function initAlertEngineWorker() {
  return alertEngineWorker;
}

export function enqueueAlertEvaluation(alertId: string, availableAt: Date) {
  return alertEvaluationJobs(alertEngineWorker).enqueue(alertId, availableAt);
}

/** @knipignore Used by alert lifecycle actions. */
export function enqueueAlertEvaluationOnce(alertId: string, availableAt: Date) {
  return alertEvaluationJobs(alertEngineWorker).enqueueOnce(alertId, availableAt);
}

export function ackAlertEvaluation(alertId: string) {
  return alertEvaluationJobs(alertEngineWorker).ack(alertId);
}
