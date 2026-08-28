import { tryCatch } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { resolvePrivateApiKeyRateLimitScope } from "~/models/runtimeEnvironment.server";
import { batchStreamGrants } from "~/runEngine/concerns/batchStreamGrantsInstance.server";
import { authenticateAuthorizationHeader } from "./apiAuth.server";
import { authorizationRateLimitMiddleware } from "./authorizationRateLimitMiddleware.server";
import { deploymentApiPaths } from "./deploymentApiPaths.server";
import type { Duration } from "./rateLimiter.server";

const BATCH_STREAM_ITEMS_PATH = /^\/api\/v3\/batches\/([^/]+)\/items$/;

// Rate-limit key for a delegated (agent/PAT-minted) JWT. Its token value rotates every
// turn, so keying on the token would hand each turn a fresh bucket. Key on env+acting-user
// so the agent's traffic shares one bucket across turns. The `jwt-actor:` prefix keeps it
// off PRIVATE-key buckets, which key on the bare environment id.
export function jwtActorRateLimitIdentifier(environmentId: string, actorSub: string): string {
  return `jwt-actor:${environmentId}:${actorSub}`;
}

// The per-request bucket decision for the API limiter. Exported so the branch below
// (a delegated JWT keys on env+acting-user, everything else keeps its prior key) is
// testable without standing up the middleware and its Redis.
export async function resolveApiRateLimitOverride(
  authorizationValue: string
): Promise<{ config?: unknown; identifier?: string } | undefined> {
  const rawApiKey = authorizationValue.replace(/^Bearer /, "");

  if (rawApiKey.startsWith("tr_")) {
    const scope = await resolvePrivateApiKeyRateLimitScope(rawApiKey);

    if (!scope) {
      return;
    }

    return {
      config: scope.apiRateLimiterConfig,
      identifier: scope.environmentId,
    };
  }

  const authenticatedEnv = await authenticateAuthorizationHeader(authorizationValue, {
    allowPublicKey: true,
    allowJWT: true,
  });

  if (!authenticatedEnv || !authenticatedEnv.ok) {
    return;
  }

  if (authenticatedEnv.type === "PUBLIC_JWT") {
    const config = {
      type: "fixedWindow",
      window: env.API_RATE_LIMIT_JWT_WINDOW,
      tokens: env.API_RATE_LIMIT_JWT_TOKENS,
    } as const;

    // A delegated JWT (agent/PAT-minted) shares one bucket per env+acting-user across turns.
    // A browser realtime JWT carries no `act`, so it keeps the hashed-token fallback.
    if (authenticatedEnv.actor?.sub) {
      return {
        config,
        identifier: jwtActorRateLimitIdentifier(
          authenticatedEnv.environment.id,
          authenticatedEnv.actor.sub
        ),
      };
    }

    return { config };
  }

  return {
    config: authenticatedEnv.environment.organization.apiRateLimiterConfig,
    // Public keys are browser-distributed, so keep them on per-key buckets.
    identifier: authenticatedEnv.type === "PRIVATE" ? authenticatedEnv.environment.id : undefined,
  };
}

export const apiRateLimiter = authorizationRateLimitMiddleware({
  redis: {
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  },
  keyPrefix: "api",
  defaultLimiter: {
    type: "tokenBucket",
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  },
  limiterCache: {
    fresh: 60_000 * 10, // Data is fresh for 10 minutes
    stale: 60_000 * 20, // Date is stale after 20 minutes
    maxItems: 1000,
  },
  limiterConfigOverride: resolveApiRateLimitOverride,
  pathMatchers: [/^\/api/],
  // Allow /api/v1/tasks/:id/callback/:secret
  pathWhiteList: [
    "/api/internal/stripe_webhooks",
    // Keep allowlisted: these CLI endpoints are intentionally unauthenticated,
    // so this Authorization-header-keyed limiter would 401 them. They are
    // throttled separately by authCodeRateLimiter.server.ts.
    "/api/v1/authorization-code",
    "/api/v1/token",
    "/api/v1/usage/ingest",
    "/api/v1/plain/customer-cards",
    /^\/api\/v1\/tasks\/[^/]+\/callback\/[^/]+$/, // /api/v1/tasks/$id/callback/$secret
    /^\/api\/v1\/runs\/[^/]+\/tasks\/[^/]+\/callback\/[^/]+$/, // /api/v1/runs/$runId/tasks/$id/callback/$secret
    /^\/api\/v1\/http-endpoints\/[^/]+\/env\/[^/]+\/[^/]+$/, // /api/v1/http-endpoints/$httpEndpointId/env/$envType/$shortcode
    /^\/api\/v1\/sources\/http\/[^/]+$/, // /api/v1/sources/http/$id
    /^\/api\/v1\/endpoints\/[^/]+\/[^/]+\/index\/[^/]+$/, // /api/v1/endpoints/$environmentId/$endpointSlug/index/$indexHookIdentifier
    "/api/v1/timezones",
    "/api/v1/usage/ingest",
    "/api/v1/auth/jwt/claims",
    /^\/api\/v1\/runs\/[^/]+\/attempts$/, // /api/v1/runs/$runFriendlyId/attempts
    /^\/api\/v1\/waitpoints\/tokens\/[^/]+\/callback\/[^/]+$/, // /api/v1/waitpoints/tokens/$waitpointFriendlyId/callback/$hash
    ...deploymentApiPaths, // rate limited separately by deploymentRateLimiter
    /^\/api\/v\d+\/deployments\/current$/, // runtime SDK surface, exempt as before the deploy budget split
    // Internal SDK plumbing — packets are presigned-URL handshakes for
    // payload uploads (v2 PUT) and downloads (v1 GET), authenticated via
    // run-scoped JWT, called once per task/turn boundary by the runtime.
    // Same shape as `/api/v1/runs/$runFriendlyId/attempts` above; not a
    // customer-facing surface so customer rate limits shouldn't apply.
    /^\/api\/v1\/packets\//,
    /^\/api\/v2\/packets\//,
    /^\/api\/v1\/sessions\/[^/]+\/snapshot-url$/,
  ],
  bypass: async (req) => {
    const match = BATCH_STREAM_ITEMS_PATH.exec(req.path);

    if (!match) {
      return false;
    }

    const batchFriendlyId = match[1];
    const authorizationValue = req.headers.authorization;

    if (!batchFriendlyId || !authorizationValue) {
      return false;
    }

    const [authError, authenticated] = await tryCatch(
      authenticateAuthorizationHeader(authorizationValue, {
        allowPublicKey: true,
      })
    );

    if (authError || !authenticated || !authenticated.ok) {
      return false;
    }

    return batchStreamGrants.spend(authenticated.environment.id, batchFriendlyId);
  },
  log: {
    rejections: env.API_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.API_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
    limiter: env.API_RATE_LIMIT_LIMITER_LOGS_ENABLED === "1",
  },
});

export type RateLimitMiddleware = ReturnType<typeof authorizationRateLimitMiddleware>;
