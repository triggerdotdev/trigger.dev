import { Ratelimit } from "@upstash/ratelimit";
import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { getUserId } from "~/services/session.server";
import { singleton } from "~/utils/singleton";

// The docs site reads the signed-in reader from these routes with `credentials: "include"`. Only
// the configured docs origins get CORS headers, so no other site can read the response.

export function isDocsOrigin(origin: string | null): origin is string {
  return origin !== null && env.DOCS_ORIGINS.includes(origin);
}

/** The docs site's origin, for links from the dashboard to the docs. */
export function docsOrigin() {
  return env.DOCS_ORIGINS[0] ?? "https://trigger.dev";
}

const DOCS_HINT_COOKIE = "docs_signed_in";
// As long as the session cookie: the root loader clears it once the session ends.
const DOCS_HINT_MAX_AGE = 31_556_952;

/**
 * The docs only ask `/resources/docs/me` who is reading when this cookie says someone is signed in,
 * so anonymous docs views make no dashboard request. A hint, not a credential: it holds no session
 * data and `me` still checks the session. Returns the Set-Cookie that brings it in line with
 * `signedIn`, or undefined when it already is.
 */
export function docsHintCookie(request: Request, signedIn: boolean): string | undefined {
  const cookies = request.headers.get("Cookie") ?? "";
  const present = /(?:^|;\s*)docs_signed_in=1(?:;|$)/.test(cookies);
  if (present === signedIn) return undefined;

  // Shared with the docs when the dashboard is on a subdomain of a docs host (cloud.trigger.dev and
  // trigger.dev), whichever DOCS_ORIGINS entry that is. On one host (localhost on two ports) a
  // host-only cookie is already shared.
  const app = new URL(env.APP_ORIGIN).hostname;
  const parent = env.DOCS_ORIGINS.map((origin) => new URL(origin).hostname).find((docs) =>
    app.endsWith(`.${docs}`)
  );
  return [
    `${DOCS_HINT_COOKIE}=${signedIn ? "1" : ""}`,
    "Path=/",
    `Max-Age=${signedIn ? DOCS_HINT_MAX_AGE : 0}`,
    "SameSite=Lax",
    ...(parent ? [`Domain=${parent}`] : []),
    ...(env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

function withDocsHeaders(request: Request, headers: Headers) {
  headers.set("Cache-Control", "private, no-store");
  headers.append("Vary", "Origin");
  const origin = request.headers.get("Origin");
  if (isDocsOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    // The docs tell readers when they can create a key again.
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return headers;
}

export function docsJson(request: Request, data: unknown, status = 200) {
  return json(data, { status, headers: withDocsHeaders(request, new Headers()) });
}

/** The answer to a CORS preflight. Plain GETs with cookies don't send one, but a docs fetch with
 * custom headers would. */
export function docsPreflight(request: Request) {
  const headers = withDocsHeaders(request, new Headers());
  if (headers.has("Access-Control-Allow-Origin")) {
    headers.set("Access-Control-Allow-Methods", "GET, POST");
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(null, { status: 204, headers });
}

const docsReaderRateLimiter = singleton(
  "docsReaderRateLimiter",
  () =>
    new RateLimiter({
      redisClient: createRedisRateLimitClient({
        port: env.RATE_LIMIT_REDIS_PORT,
        host: env.RATE_LIMIT_REDIS_HOST,
        username: env.RATE_LIMIT_REDIS_USERNAME,
        password: env.RATE_LIMIT_REDIS_PASSWORD,
        tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
        clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
      }),
      keyPrefix: "docs:reader",
      // A docs page asks once for the reader and once for a key; this covers fast page switching.
      limiter: Ratelimit.slidingWindow(60, "1 m"),
      logSuccess: false,
      logFailure: true,
    })
);

/** Creating a key from the docs: a few per hour is plenty; the dashboard has the full keys page. */
const docsCreateKeyRateLimiter = singleton(
  "docsCreateKeyRateLimiter",
  () =>
    new RateLimiter({
      redisClient: createRedisRateLimitClient({
        port: env.RATE_LIMIT_REDIS_PORT,
        host: env.RATE_LIMIT_REDIS_HOST,
        username: env.RATE_LIMIT_REDIS_USERNAME,
        password: env.RATE_LIMIT_REDIS_PASSWORD,
        tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
        clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
      }),
      keyPrefix: "docs:create-key",
      limiter: Ratelimit.slidingWindow(10, "1 h"),
      logSuccess: false,
      logFailure: true,
    })
);

function tooManyRequests(request: Request, reset: number) {
  const response = docsJson(request, { error: "Too many requests" }, 429);
  response.headers.set("Retry-After", String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))));
  return response;
}

/** The 429 to send when this user has created too many keys from the docs, else undefined. */
export async function docsCreateKeyRateLimited(request: Request, userId: string) {
  const limit = await docsCreateKeyRateLimiter.limit(userId);
  return limit.success ? undefined : tooManyRequests(request, limit.reset);
}

/** The signed-in user id, or the docs response to send instead (401 or 429). */
export async function docsReaderUserId(
  request: Request
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  let userId: string | undefined;
  try {
    userId = await getUserId(request);
  } catch (error) {
    // An ended session throws a redirect to /logout; to the docs that's just signed out.
    if (!(error instanceof Response)) throw error;
  }
  if (!userId) {
    return { ok: false, response: docsJson(request, { error: "Unauthenticated" }, 401) };
  }

  const limit = await docsReaderRateLimiter.limit(userId);
  if (!limit.success) return { ok: false, response: tooManyRequests(request, limit.reset) };

  return { ok: true, userId };
}
