import { createCookieSessionStorage, type Session } from "@remix-run/node";
import { SignJWT, jwtVerify, errors } from "jose";
import { singleton } from "~/utils/singleton";
import { createRedisClient, type RedisClient } from "~/redis.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

export const impersonationSessionStorage = createCookieSessionStorage({
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

export function getImpersonationSession(request: Request) {
  return impersonationSessionStorage.getSession(request.headers.get("Cookie"));
}

export function commitImpersonationSession(session: Session) {
  return impersonationSessionStorage.commitSession(session);
}

export async function getImpersonationId(request: Request) {
  const session = await getImpersonationSession(request);

  return session.get("impersonatedUserId") as string | undefined;
}

export async function setImpersonationId(userId: string, request: Request) {
  const session = await getImpersonationSession(request);

  session.set("impersonatedUserId", userId);

  return session;
}

export async function clearImpersonationId(request: Request) {
  const session = await getImpersonationSession(request);

  session.unset("impersonatedUserId");

  return session;
}

// Impersonation token utilities for CSRF protection
const IMPERSONATION_TOKEN_EXPIRY_SECONDS = 5 * 60; // 5 minutes

function getImpersonationTokenSecret(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET);
}

function getImpersonationTokenRedisClient(): RedisClient {
  return singleton(
    "impersonationTokenRedis",
    () =>
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

    // Check if token has already been used (prevent replay attacks)
    const redis = getImpersonationTokenRedisClient();
    const tokenKey = token;

    // Try to set the key with NX (only if not exists) and expiration
    // This atomically marks the token as used
    const result = await redis.set(tokenKey, "1", "EX", IMPERSONATION_TOKEN_EXPIRY_SECONDS, "NX");

    if (result !== "OK") {
      // Token was already used
      return undefined;
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
