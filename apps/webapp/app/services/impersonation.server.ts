import { createCookieSessionStorage, type Session } from "@remix-run/node";
import { SignJWT, jwtVerify, errors } from "jose";
import { randomUUID } from "node:crypto";
import { singleton } from "~/utils/singleton";
import { createRedisClient, type RedisClient } from "~/redis.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { resolveImpersonationState, type ImpersonationState } from "~/utils/impersonationState";

const impersonationSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__impersonate", // use any name you want here
    sameSite: "lax", // this helps with CSRF
    path: "/", // remember to add this so the cookie will work in all routes
    httpOnly: true, // for security reasons, make this cookie http only
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production", // enable this in prod only
    maxAge: 60 * 60 * 24, // 1 day
  },
});

const IMPERSONATED_USER_ID_KEY = "impersonatedUserId";

/**
 * Display-only "view as user" flag. It lives on the impersonation cookie so it
 * is scoped to the impersonation session by construction: stop impersonating
 * and the flag goes with it.
 */
const VIEWING_AS_USER_KEY = "viewingAsUser";

function getImpersonationSession(request: Request) {
  return impersonationSessionStorage.getSession(request.headers.get("Cookie"));
}

export function commitImpersonationSession(session: Session) {
  return impersonationSessionStorage.commitSession(session);
}

export async function getImpersonationId(request: Request) {
  const session = await getImpersonationSession(request);

  return session.get(IMPERSONATED_USER_ID_KEY) as string | undefined;
}

export async function setImpersonationId(userId: string, request: Request) {
  const session = await getImpersonationSession(request);

  // Switching straight to a different target begins a new impersonation session, so the view-as-user
  // flag must not carry over from the previous one — it's scoped to a single impersonation, which is
  // why `clearImpersonationId` drops it too. Reachable only since switching stopped requiring a stop
  // first; before that, every second target arrived via `clearImpersonationId`.
  if (session.get(IMPERSONATED_USER_ID_KEY) !== userId) {
    session.unset(VIEWING_AS_USER_KEY);
  }

  session.set(IMPERSONATED_USER_ID_KEY, userId);

  return session;
}

export async function clearImpersonationId(request: Request) {
  const session = await getImpersonationSession(request);

  session.unset(IMPERSONATED_USER_ID_KEY);
  // The view-as-user flag only means anything inside an impersonation session,
  // so it never outlives one.
  session.unset(VIEWING_AS_USER_KEY);

  return session;
}

/**
 * The impersonation state for a request, resolved against `resolvedUserId` — the
 * id the request actually authenticated as (what `getUser`/`getUserId` return).
 *
 * This is the one place the impersonation flags come from, so the values the
 * server computes for a route and the value the root loader publishes to the
 * client cannot disagree. See `resolveImpersonationState` for why the
 * impersonated id has to match the resolved user rather than merely be present.
 */
export async function getImpersonationState(
  request: Request,
  resolvedUserId: string | undefined
): Promise<ImpersonationState> {
  const session = await getImpersonationSession(request);

  return resolveImpersonationState({
    impersonatedUserId: session.get(IMPERSONATED_USER_ID_KEY),
    viewingAsUser: session.get(VIEWING_AS_USER_KEY),
    resolvedUserId,
  });
}

export async function setViewingAsUser(value: boolean, request: Request) {
  const session = await getImpersonationSession(request);

  if (value) {
    session.set(VIEWING_AS_USER_KEY, true);
  } else {
    session.unset(VIEWING_AS_USER_KEY);
  }

  return session;
}

// Impersonation token utilities for CSRF protection
const IMPERSONATION_TOKEN_EXPIRY_SECONDS = 5 * 60; // 5 minutes

function getImpersonationTokenSecret(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET);
}

function getImpersonationTokenRedisClient(): RedisClient {
  return singleton("impersonationTokenRedis", () =>
    createRedisClient("impersonation:token", {
      host: env.CACHE_REDIS_HOST,
      port: env.CACHE_REDIS_PORT,
      username: env.CACHE_REDIS_USERNAME,
      password: env.CACHE_REDIS_PASSWORD,
      tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
      clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
      keyPrefix: "impersonation:token:",
    })
  );
}

/**
 * Generate a signed one-time impersonation token for a user
 */
export async function generateImpersonationToken(userId: string): Promise<string> {
  const secret = getImpersonationTokenSecret();
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + IMPERSONATION_TOKEN_EXPIRY_SECONDS)
    .setIssuer("https://trigger.dev")
    .setAudience("https://trigger.dev/admin")
    .setJti(randomUUID())
    .sign(secret);

  return token;
}

/**
 * Validate and consume an impersonation token (prevents replay attacks)
 */
export async function validateAndConsumeImpersonationToken(
  token: string
): Promise<string | undefined> {
  try {
    const secret = getImpersonationTokenSecret();

    // Verify the token signature and expiration
    const { payload } = await jwtVerify(token, secret, {
      issuer: "https://trigger.dev",
      audience: "https://trigger.dev/admin",
    });

    const userId = payload.userId as string | undefined;
    if (!userId || typeof userId !== "string") {
      return undefined;
    }

    // Atomically mark the token as used to prevent replay attacks.
    // Use the jti (a short UUID) as the Redis key rather than the full JWT string.
    // If Redis is unavailable, fall back to JWT expiry as the only protection.
    if (env.CACHE_REDIS_HOST) {
      // Defensively reject tokens without a jti (e.g. issued before this change)
      if (!payload.jti) {
        logger.warn("Impersonation token missing jti claim, rejecting for safety");
        return undefined;
      }

      try {
        const redis = getImpersonationTokenRedisClient();
        const result = await redis.set(
          payload.jti,
          "1",
          "EX",
          IMPERSONATION_TOKEN_EXPIRY_SECONDS,
          "NX"
        );
        if (result !== "OK") {
          // Token was already used
          return undefined;
        }
      } catch (redisError) {
        logger.warn(
          "Redis unavailable for impersonation token tracking, relying on JWT expiry only",
          {
            error: redisError instanceof Error ? redisError.message : String(redisError),
          }
        );
      }
    }

    return userId;
  } catch (error) {
    if (error instanceof errors.JWTExpired || error instanceof errors.JWTInvalid) {
      return undefined;
    }
    logger.error("Error validating impersonation token", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
