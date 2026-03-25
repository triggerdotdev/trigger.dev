import { singleton } from "~/utils/singleton";
import { RequestIdempotencyService } from "./requestIdempotency.server";
import { env } from "~/env.server";

export const requestIdempotency = singleton("requestIdempotency", createRequestIdempotencyInstance);

function createRequestIdempotencyInstance() {
  return new RequestIdempotencyService({
    redis: {
      keyPrefix: "request-idempotency:",
      port: env.REQUEST_IDEMPOTENCY_REDIS_PORT ?? undefined,
      host: env.REQUEST_IDEMPOTENCY_REDIS_HOST ?? undefined,
      username: env.REQUEST_IDEMPOTENCY_REDIS_USERNAME ?? undefined,
      password: env.REQUEST_IDEMPOTENCY_REDIS_PASSWORD ?? undefined,
      tlsDisabled: env.REQUEST_IDEMPOTENCY_REDIS_TLS_DISABLED === "true",
      clusterMode: false,
    },
    logLevel: env.REQUEST_IDEMPOTENCY_LOG_LEVEL,
    ttlInMs: env.REQUEST_IDEMPOTENCY_TTL_IN_MS,
    types: ["batch-trigger", "trigger", "create-batch"],
  });
}
