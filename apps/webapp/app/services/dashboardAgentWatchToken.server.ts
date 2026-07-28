import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { env } from "~/env.server";

/**
 * Watch tokens — the credential the watcher task presents to the private check
 * endpoint (`POST /api/v1/dashboard-agent/watches/:watchId/check`).
 *
 * Deliberately NOT a user-actor token. A UAT authenticates as its user with a
 * read cap and is accepted by several `api.v1` routes; a watch token authorizes
 * exactly one thing — "ask about this one watch" — and is accepted nowhere else.
 * Both are HS256-signed with `SESSION_SECRET`, so the separation has to be
 * structural, and it is, twice over:
 *
 *   - a disjoint routing prefix (`tr_daw_` vs `tr_uat_`), so each verifier
 *     rejects the other's tokens before doing any crypto, and
 *   - a disjoint `kind` claim inside the JWT (`dashboard_agent_watch` vs
 *     `user_actor`), so re-prefixing a token by hand doesn't help either.
 *
 * The token carries NO authority of its own beyond naming the watch: the check
 * endpoint re-authorizes the watch's initiating user against the watch's
 * immutable project/environment on every call. So a leaked token can't read
 * anything the user has since lost access to.
 *
 * ## Store vs re-mint
 *
 * The token is NOT persisted. `expirationTime` is absolute (`expiresAt` + grace)
 * and `omitIssuedAt` drops the only non-deterministic claim, so signing is a pure
 * function of `(SESSION_SECRET, watchId, expiresAt)` — the same inputs mint the
 * byte-identical token every time. Anything that needs the token (the creation
 * path, or a future sweeper re-scheduling a tick) re-mints it from the watch row
 * instead of reading a stored secret, which keeps a long-lived bearer token out
 * of the database entirely.
 */

export const WATCH_TOKEN_PREFIX = "tr_daw_";

/** Distinguishes a watch token from every other SESSION_SECRET-signed JWT. */
const WATCH_TOKEN_KIND = "dashboard_agent_watch";

/**
 * Mirrors the UAT's `act.client`, with a value no UAT ever uses. Verified, so a
 * token minted for some other purpose can't be replayed here.
 */
const WATCH_TOKEN_CLIENT = "dashboard-agent-watch";

/**
 * How long past `expiresAt` the token stays valid. The expiry evaluation (the
 * `final` check) happens after the watch is already past its deadline, so the
 * token has to outlive the watch by enough to cover a late tick.
 */
export const WATCH_TOKEN_GRACE_MS = 60 * 60 * 1000;

export type WatchTokenClaims = {
  watchId: string;
  /** Token expiry (seconds since epoch), i.e. `expiresAt` + grace. */
  expiresAtSeconds: number;
};

export function isDashboardAgentWatchToken(token: string): boolean {
  return token.startsWith(WATCH_TOKEN_PREFIX);
}

/**
 * Sign a watch token. Deterministic: same secret + watchId + expiresAt produce
 * the same string (see the store-vs-re-mint note above).
 */
export async function signDashboardAgentWatchToken(
  secret: string,
  opts: { watchId: string; expiresAt: Date; graceMs?: number }
): Promise<string> {
  const expirationTime = Math.floor(
    (opts.expiresAt.getTime() + (opts.graceMs ?? WATCH_TOKEN_GRACE_MS)) / 1000
  );

  const jwt = await generateJWT({
    secretKey: secret,
    payload: {
      kind: WATCH_TOKEN_KIND,
      // `sub` is the watch, not a user — a watch token never authenticates a user.
      sub: opts.watchId,
      act: { client: WATCH_TOKEN_CLIENT },
    },
    expirationTime,
    omitIssuedAt: true,
  });

  return `${WATCH_TOKEN_PREFIX}${jwt}`;
}

/**
 * `undefined` for anything that isn't a valid, unexpired, correctly-signed watch
 * token — including a perfectly valid user-actor token.
 */
export async function verifyDashboardAgentWatchToken(
  secret: string,
  token: string
): Promise<WatchTokenClaims | undefined> {
  if (!isDashboardAgentWatchToken(token)) return;

  const result = await validateJWT(token.slice(WATCH_TOKEN_PREFIX.length), secret);
  if (!result.ok) return;

  const payload = result.payload;
  if (payload.kind !== WATCH_TOKEN_KIND) return;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return;

  const act = payload.act as { client?: string } | undefined;
  if (act?.client !== WATCH_TOKEN_CLIENT) return;
  if (typeof payload.exp !== "number") return;

  return { watchId: payload.sub, expiresAtSeconds: payload.exp };
}

/** Mint the token for a watch row, using the platform secret. */
export function mintDashboardAgentWatchToken(opts: {
  watchId: string;
  expiresAt: Date;
}): Promise<string> {
  return signDashboardAgentWatchToken(env.SESSION_SECRET, opts);
}

/** Verify a bearer token presented to the check endpoint. */
export function verifyWatchTokenFromRequest(token: string): Promise<WatchTokenClaims | undefined> {
  return verifyDashboardAgentWatchToken(env.SESSION_SECRET, token);
}

/** The bearer value from an `Authorization: Bearer …` header, if present. */
export function bearerToken(request: Request): string | undefined {
  const raw = request.headers.get("Authorization");
  if (!raw) return undefined;
  const value = raw.replace(/^Bearer /, "").trim();
  return value.length > 0 ? value : undefined;
}
