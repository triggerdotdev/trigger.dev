import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { ssoController } from "~/services/sso.server";

// Dedicated worker for inbound account-management webhooks. The webhook
// proxy route verifies the signature via the plugin and enqueues the
// parsed event here; this worker calls back into the plugin to apply the
// DB writes. The plugin owns the vendor-specific logic; the webapp owns
// the queue runtime (this file), mirroring `commonWorker.server.ts`.
//
// Vendor-neutral by design: the catalog/job names and payload shape carry
// no provider identity.
const PayloadSchema = z.object({
  id: z.string(),
  event: z.string(),
  data: z.unknown(),
});

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "accounts-webhook:worker:",
    host: env.COMMON_WORKER_REDIS_HOST,
    port: env.COMMON_WORKER_REDIS_PORT,
    username: env.COMMON_WORKER_REDIS_USERNAME,
    password: env.COMMON_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.COMMON_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  const worker = new RedisWorker({
    name: "accounts-webhook-worker",
    redisOptions,
    catalog: {
      "account.webhook.event": {
        schema: PayloadSchema,
        visibilityTimeoutMs: 30_000,
        retry: { maxAttempts: 5 },
      },
    },
    concurrency: {
      workers: 2,
      tasksPerWorker: 4,
      limit: 8,
    },
    pollIntervalMs: 1_000,
    immediatePollIntervalMs: 50,
    shutdownTimeoutMs: 30_000,
    jobs: {
      "account.webhook.event": async ({ payload }) => {
        // The plugin returns a Result; throw on error so the worker
        // retries (a resolved err would otherwise be silently dropped).
        const result = await ssoController.processWebhookEvent(payload);
        if (result.isErr()) {
          throw new Error(`account webhook processing failed: ${result.error}`);
        }
      },
    },
  });

  // Only poll on worker-role instances (same gate as commonWorker) and
  // only when the feature is enabled (no plugin loaded otherwise).
  if (env.COMMON_WORKER_ENABLED === "true" && env.SSO_ENABLED) {
    logger.debug(
      `👨‍🏭 Starting accounts webhook worker at host ${env.COMMON_WORKER_REDIS_HOST}`
    );
    worker.start();
  }

  return worker;
}

export const accountsWebhookWorker = singleton("accountsWebhookWorker", initializeWorker);
