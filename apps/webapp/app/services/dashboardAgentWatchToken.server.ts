import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { env } from "~/env.server";

/**
 * The credential the watcher task presents to the private check endpoint.
 *
 * Deliberately not a user-actor token. A UAT authenticates as its user with a read cap
 * across several `api.v1` routes; a watch token authorizes one thing, asking about one
 * watch, and is accepted nowhere else. Both are HS256-signed with `SESSION_SECRET`, so
 * the separation is structural twice over: a disjoint routing prefix, so each verifier
 * rejects the other's tokens before any crypto, and a disjoint `kind` claim, so
 * re-prefixing a token by hand doesn't help either.
 *
 * The token carries no authority beyond naming the watch. The check endpoint
 * re-authorizes the watch's initiating user against the watch's immutable project and
 * environment on every call, so a leaked token can't read anything the user has since
 * lost access to.
 *
 * The token is not persisted. `expirationTime` is absolute and `omitIssuedAt` drops the
 * only non-deterministic claim, so signing is a pure function of `(SESSION_SECRET,
 * watchId, expiresAt)` and anything that needs the token re-mints it from the watch
 * row. That keeps a long-lived bearer token out of the database.
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
 * How long past `expiresAt` the token stays valid. The final check happens after the
 * watch is already past its deadline, so the token has to outlive the watch by enough
 * to cover a late tick.
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

/** Sign a watch token. Deterministic: the same inputs produce the same string. */
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
      // `sub` is the watch: a watch token never authenticates a user.
      sub: opts.watchId,
      act: { client: WATCH_TOKEN_CLIENT },
    },
    expirationTime,
    omitIssuedAt: true,
  });

  return `${WATCH_TOKEN_PREFIX}${jwt}`;
}

/**
 * `undefined` for anything that isn't a valid, unexpired, correctly-signed watch token,
 * including a perfectly valid user-actor token.
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

/**
 * Chain tokens name a whole (environment, cadence) group. The prefix is disjoint from
 * `tr_daw_` rather than nested under it, so neither verifier sees the other's tokens.
 */
export const WATCH_BATCH_TOKEN_PREFIX = "tr_dab_";

const WATCH_BATCH_TOKEN_KIND = "dashboard_agent_watch_batch";
const WATCH_BATCH_TOKEN_CLIENT = "dashboard-agent-watch-batch";

/**
 * How long a chain's token lives. A chain ticks for as long as its group has active
 * watches, so the token can't be pinned to a deadline the way a watch's is, but it must
 * still expire.
 *
 * An expired one is self-healing: the batch check refuses, the run fails, the chain goes
 * stale, and the re-arm backstop starts a fresh epoch with a fresh token within a sweep.
 * The cost is at most one missed cadence per token lifetime.
 */
export const WATCH_BATCH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type WatchBatchTokenClaims = { environmentId: string; cadenceMinutes: number };

/**
 * Sign a chain token. Like a watch token it names one thing and carries no authority of
 * its own: the batch check re-authorizes every watch's initiating user against that
 * watch's immutable project and environment, and the token can't name a group it wasn't
 * minted for.
 */
export async function signDashboardAgentWatchBatchToken(
  secret: string,
  opts: { environmentId: string; cadenceMinutes: number; expiresAt: Date }
): Promise<string> {
  const jwt = await generateJWT({
    secretKey: secret,
    payload: {
      kind: WATCH_BATCH_TOKEN_KIND,
      // The group, not a user and not a watch.
      sub: `${opts.environmentId}:${opts.cadenceMinutes}`,
      act: { client: WATCH_BATCH_TOKEN_CLIENT },
    },
    expirationTime: Math.floor(opts.expiresAt.getTime() / 1000),
    omitIssuedAt: true,
  });

  return `${WATCH_BATCH_TOKEN_PREFIX}${jwt}`;
}

/** `undefined` for anything that isn't a valid, unexpired chain token. */
export async function verifyDashboardAgentWatchBatchToken(
  secret: string,
  token: string
): Promise<WatchBatchTokenClaims | undefined> {
  if (!token.startsWith(WATCH_BATCH_TOKEN_PREFIX)) return;

  const result = await validateJWT(token.slice(WATCH_BATCH_TOKEN_PREFIX.length), secret);
  if (!result.ok) return;

  const payload = result.payload;
  if (payload.kind !== WATCH_BATCH_TOKEN_KIND) return;
  const act = payload.act as { client?: string } | undefined;
  if (act?.client !== WATCH_BATCH_TOKEN_CLIENT) return;
  if (typeof payload.sub !== "string") return;

  // The cadence is the last segment. An environment id never contains a colon, but
  // splitting from the right can't be fooled if one ever did.
  const separator = payload.sub.lastIndexOf(":");
  if (separator <= 0) return;
  const environmentId = payload.sub.slice(0, separator);
  const cadenceMinutes = Number(payload.sub.slice(separator + 1));
  if (!Number.isInteger(cadenceMinutes) || cadenceMinutes <= 0) return;

  return { environmentId, cadenceMinutes };
}

export function mintDashboardAgentWatchBatchToken(opts: {
  environmentId: string;
  cadenceMinutes: number;
  now?: Date;
}): Promise<string> {
  const now = opts.now ?? new Date();
  return signDashboardAgentWatchBatchToken(env.SESSION_SECRET, {
    environmentId: opts.environmentId,
    cadenceMinutes: opts.cadenceMinutes,
    expiresAt: new Date(now.getTime() + WATCH_BATCH_TOKEN_TTL_MS),
  });
}

/** Verify a bearer token presented to the batch check endpoint. */
export function verifyWatchBatchTokenFromRequest(
  token: string
): Promise<WatchBatchTokenClaims | undefined> {
  return verifyDashboardAgentWatchBatchToken(env.SESSION_SECRET, token);
}

/** The bearer value from an `Authorization: Bearer …` header, if present. */
export function bearerToken(request: Request): string | undefined {
  const raw = request.headers.get("Authorization");
  if (!raw) return undefined;
  const value = raw.replace(/^Bearer /, "").trim();
  return value.length > 0 ? value : undefined;
}
