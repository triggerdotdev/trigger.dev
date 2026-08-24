import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { env } from "~/env.server";

/**
 * The credential the watcher task presents to the private check endpoint. It names one watch, is
 * kept apart from the UAT by a disjoint prefix and `kind`, and is re-minted, never persisted.
 */

export const WATCH_TOKEN_PREFIX = "tr_daw_";

/** Distinguishes a watch token from every other SESSION_SECRET-signed JWT. */
const WATCH_TOKEN_KIND = "dashboard_agent_watch";

/** Mirrors the UAT's `act.client` with a value no UAT uses. Verified, so no replay. */
const WATCH_TOKEN_CLIENT = "dashboard-agent-watch";

/**
 * How long past `expiresAt` the token stays valid. The final check happens after the
 * deadline, so the token has to outlive the watch by enough to cover a late tick.
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

/** Deterministic: the same inputs produce the same string. */
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

/** `undefined` for anything but a valid watch token, including a valid user-actor token. */
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

export function mintDashboardAgentWatchToken(opts: {
  watchId: string;
  expiresAt: Date;
}): Promise<string> {
  return signDashboardAgentWatchToken(env.SESSION_SECRET, opts);
}

export function verifyWatchTokenFromRequest(token: string): Promise<WatchTokenClaims | undefined> {
  return verifyDashboardAgentWatchToken(env.SESSION_SECRET, token);
}

/**
 * Chain tokens name a whole (environment, cadence) group. The prefix is disjoint from
 * `tr_daw_` rather than nested under it, so neither verifier sees the other's tokens.
 */
const WATCH_BATCH_TOKEN_PREFIX = "tr_dab_";

const WATCH_BATCH_TOKEN_KIND = "dashboard_agent_watch_batch";
const WATCH_BATCH_TOKEN_CLIENT = "dashboard-agent-watch-batch";

/**
 * How long a chain's token lives. A chain has no deadline to pin it to, but it must still
 * expire. A chain whose token no longer verifies keeps ticking — a failed check is never a
 * verdict — and gets a fresh token when the re-arm backstop starts the next epoch.
 */
const WATCH_BATCH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type WatchBatchTokenClaims = { environmentId: string; cadenceMinutes: number };

/**
 * Like a watch token, a chain token names one group and carries no authority of its own: the
 * batch check re-authorizes every watch's initiating user against that watch's snapshot.
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
async function verifyDashboardAgentWatchBatchToken(
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

  // The cadence is the last segment, split from the right so a colon in an environment id
  // could never confuse it.
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
