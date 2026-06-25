import { json, redirect } from "@remix-run/node";
import { tryCatch } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { ssoSessionExpiredLogoutPath } from "~/utils/ssoSession";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";
import { ssoController } from "./sso.server";

// Dedicated Redis client for the single-flight throttle. Reuses the
// shared REDIS_* connection (same wiring the other simple shared-state
// services use).
const redis = singleton("ssoRevalidationRedis", () =>
  createRedisClient("trigger:ssoRevalidation", {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    tlsDisabled: env.REDIS_TLS_DISABLED === "true",
  })
);

function revalidationKey(userId: string): string {
  return `sso:reval:${userId}`;
}

// Module-scoped so it's a unique symbol — lets the Promise.race result be
// narrowed cleanly between "timed out" and the plugin's Result.
const REVALIDATION_TIMEOUT = Symbol("sso-revalidation-timeout");

/**
 * Periodically re-validate an SSO-established session against the IdP.
 *
 * Called from the session read path on every authenticated request, but:
 *  - returns immediately unless the SSO feature is enabled AND the
 *    session carries the `sso` marker (non-SSO sessions pay nothing — no
 *    Redis round-trip);
 *  - is single-flight via a Redis `SET key 1 NX EX <interval>`: only the
 *    first request per interval window actually calls the SSO plugin,
 *    concurrent requests see the key and skip;
 *  - fails OPEN — any error (Redis or the plugin) keeps the session
 *    alive. Only an explicit `{ valid: false }` triggers logout.
 *
 * Throws `redirect("/logout")` when the session is confirmed invalid,
 * mirroring how `maybeAutoLogout` terminates a session from this path.
 */
export async function revalidateSsoSession(
  request: Request,
  authUser: AuthUser | null | undefined
): Promise<void> {
  // Deploy gate + SSO-session gate.
  if (!env.SSO_ENABLED) return;
  if (!authUser?.sso) return;

  // Never revalidate on /logout itself — the loader there must be allowed
  // to destroy the cookie rather than redirect in a loop.
  if (new URL(request.url).pathname === "/logout") return;

  const interval = env.SSO_SESSION_REVALIDATION_INTERVAL_SECONDS;
  const key = revalidationKey(authUser.userId);

  // Single-flight: acquire the window. Only the request that sets the
  // key (NX) proceeds to the actual check; everyone else this window
  // treats the session as valid.
  const [setError, acquired] = await tryCatch(redis.set(key, "1", "EX", interval, "NX"));
  if (setError) {
    // Redis unavailable → fail-open, don't block the request.
    logger.warn("SSO revalidation: redis SET NX failed; skipping", { error: setError });
    return;
  }
  if (acquired !== "OK") return;

  // Hard 2s (env-configurable) timeout on the plugin round-trip so a slow
  // or hung SSO dependency can never block the request. On timeout we fail
  // OPEN (keep the session + the throttle key) and emit a stable
  // `sso.revalidation.timeout` warn for alerting.
  const timeoutMs = env.SSO_SESSION_REVALIDATION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<typeof ssoController.validateSession>> | typeof REVALIDATION_TIMEOUT;
  try {
    result = await Promise.race([
      // ResultAsync is a PromiseLike; Promise.resolve unwraps it to a Result.
      Promise.resolve(
        ssoController.validateSession({
          userId: authUser.userId,
          idpOrgId: authUser.sso.idpOrgId,
          connectionId: authUser.sso.connectionId,
        })
      ),
      new Promise<typeof REVALIDATION_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(REVALIDATION_TIMEOUT), timeoutMs);
      }),
    ]);
  } catch (error) {
    // A ResultAsync resolves to an Err rather than rejecting, but guard
    // against a synchronous throw / rejected promise from the plugin all
    // the same — fail OPEN (keep the session + the throttle key) exactly
    // like the Err branch below.
    if (timer) clearTimeout(timer);
    logger.warn("SSO revalidation threw; failing open (session kept alive)", {
      userId: authUser.userId,
      error,
    });
    return;
  }
  if (timer) clearTimeout(timer);

  if (result === REVALIDATION_TIMEOUT) {
    logger.warn("SSO revalidation timed out; failing open (session kept alive)", {
      event: "sso.revalidation.timeout",
      userId: authUser.userId,
      timeoutMs,
    });
    return;
  }

  if (result.isErr()) {
    // Fail-open: keep the session, and keep the throttle key so we don't
    // hammer the plugin while the dependency is unhealthy.
    logger.warn("SSO revalidation errored; failing open (session kept alive)", {
      userId: authUser.userId,
      reason: result.error,
    });
    return;
  }

  if (result.value.valid) return; // still valid — TTL governs the next check

  // Confirmed invalid. Clear the throttle so other tabs/requests for this
  // user re-check (and log out) on their next request instead of waiting
  // for the TTL, then terminate this session.
  try {
    await redis.del(key);
  } catch {
    // best-effort; the key expires on its own anyway
  }
  logger.info("SSO revalidation: session invalid, logging out", {
    userId: authUser.userId,
  });

  // Navigations (and Remix data requests, which the client follows) get the
  // logout redirect. Programmatic/API fetches can't follow a 302-to-HTML, so
  // they get a plain 401; the session is re-checked and the user is redirected
  // on their next navigation/refresh.
  const url = new URL(request.url);
  const isRemixDataRequest = url.searchParams.has("_data");
  const dest = request.headers.get("sec-fetch-dest");
  const isDocumentRequest = dest
    ? dest === "document"
    : (request.headers.get("accept") ?? "").includes("text/html");
  if (isRemixDataRequest || isDocumentRequest) {
    throw redirect(ssoSessionExpiredLogoutPath());
  }
  throw json({ error: "sso_session_invalidated" }, { status: 401 });
}
