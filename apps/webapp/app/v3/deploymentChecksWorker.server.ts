import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { createDeploymentChecksWorker, enqueueDeploymentCheck } from "./deploymentChecks.server";

function initializeWorker() {
  const worker = createDeploymentChecksWorker({
    redisOptions: {
      keyPrefix: "deployment-checks:worker:",
      host: env.COMMON_WORKER_REDIS_HOST,
      port: env.COMMON_WORKER_REDIS_PORT,
      username: env.COMMON_WORKER_REDIS_USERNAME,
      password: env.COMMON_WORKER_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.COMMON_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    concurrency: {
      workers: env.DEPLOYMENT_CHECKS_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.DEPLOYMENT_CHECKS_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.DEPLOYMENT_CHECKS_WORKER_CONCURRENCY_LIMIT,
    },
    shutdownTimeoutMs: env.DEPLOYMENT_CHECKS_WORKER_SHUTDOWN_TIMEOUT_MS,
    logLevel: env.DEPLOYMENT_CHECKS_WORKER_LOG_LEVEL,
  });

  if (env.DEPLOYMENT_CHECKS_WORKER_ENABLED === "true") {
    worker.start();
  }

  return worker;
}

const deploymentChecksWorker = singleton("deploymentChecksWorker", initializeWorker);

/** Queues the check for a finished deployment. Never throws. */
export function queueDeploymentCheck(deploymentId: string): Promise<void> {
  return enqueueDeploymentCheck(deploymentChecksWorker, deploymentId);
}
