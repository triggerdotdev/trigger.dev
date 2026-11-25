import type { Session } from "@remix-run/node";
import { Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { commitSession, DEFAULT_SESSION_DURATION_SECONDS } from "./sessionStorage.server";

export { DEFAULT_SESSION_DURATION_SECONDS };

// Months and years use standard Gregorian-calendar conversions (365.2425 days/yr,
// 30.436875 days/month) so values produced by external "X months in seconds"
// calculators map cleanly to a labeled option.
const GREGORIAN_HALF_YEAR_SECONDS = 15_778_476;

export type SessionDurationOption = {
  value: number;
  label: string;
};

export const SESSION_DURATION_OPTIONS: SessionDurationOption[] = [
  { value: 60 * 5, label: "5 minutes" },
  { value: 60 * 30, label: "30 minutes" },
  { value: 60 * 60, label: "1 hour" },
  { value: 60 * 60 * 24, label: "1 day" },
  { value: 60 * 60 * 24 * 30, label: "30 days" },
  { value: GREGORIAN_HALF_YEAR_SECONDS, label: "6 months" },
  { value: DEFAULT_SESSION_DURATION_SECONDS, label: "1 year" },
];

export const ALLOWED_SESSION_DURATION_VALUES: ReadonlySet<number> = new Set(
  SESSION_DURATION_OPTIONS.map((o) => o.value)
);

export function isAllowedSessionDuration(value: number): boolean {
  return ALLOWED_SESSION_DURATION_VALUES.has(value);
}

export type OrganizationSessionCap = {
  /** The org cap in seconds. */
  orgCapSeconds: number;
  /** The id of the org whose cap is currently the most restrictive. */
  cappingOrgId: string;
};

/**
 * Returns the most restrictive max session duration across the user's orgs
 * along with the id of the org that owns it, ignoring orgs where the cap is
 * null. Returns null when no org has set a cap.
 */
export async function getOrganizationSessionCap(
  userId: string,
  client: PrismaClientOrTransaction = prisma
): Promise<OrganizationSessionCap | null> {
  const tightest = await client.organization.findFirst({
    where: {
      members: { some: { userId } },
      maxSessionDuration: { not: null },
      deletedAt: null,
    },
    orderBy: { maxSessionDuration: "asc" },
    select: { id: true, maxSessionDuration: true },
  });
  if (!tightest || tightest.maxSessionDuration === null) return null;
  return { orgCapSeconds: tightest.maxSessionDuration, cappingOrgId: tightest.id };
}

export type EffectiveSessionDuration = {
  /** Effective session duration in seconds = min(user.sessionDuration, orgCap?). */
  durationSeconds: number;
  /** The org cap in seconds, or null if no org caps the user. */
  orgCapSeconds: number | null;
  /** The id of the org whose cap is currently in effect, or null. */
  cappingOrgId: string | null;
  /** The raw user setting in seconds. */
  userSettingSeconds: number;
};

/**
 * Computes the effective session duration for a user by combining their
 * configured `User.sessionDuration` with the most restrictive cap across
 * their organizations.
 */
export async function getEffectiveSessionDuration(
  userId: string,
  client: PrismaClientOrTransaction = prisma
): Promise<EffectiveSessionDuration> {
  const [user, orgCap] = await Promise.all([
    client.user.findFirst({
      where: { id: userId },
      select: { sessionDuration: true },
    }),
    getOrganizationSessionCap(userId, client),
  ]);

  const userSettingSeconds = user?.sessionDuration ?? DEFAULT_SESSION_DURATION_SECONDS;
  const durationSeconds =
    orgCap === null ? userSettingSeconds : Math.min(userSettingSeconds, orgCap.orgCapSeconds);

  return {
    durationSeconds,
    orgCapSeconds: orgCap?.orgCapSeconds ?? null,
    cappingOrgId: orgCap?.cappingOrgId ?? null,
    userSettingSeconds,
  };
}

/**
 * Returns the dropdown options the user is allowed to pick. Options strictly
 * greater than the org cap are removed.
 *
 * `currentValueSeconds` should be the *effective* (clamped) duration — i.e.
 * `EffectiveSessionDuration.durationSeconds`, which is guaranteed to be ≤
 * `orgCapSeconds`. Passing the clamped value makes the dropdown's selected
 * option reflect what's actually in effect rather than the user's stored
 * preference, which is the right UX when a stricter org cap supersedes a
 * larger user setting (the raw user preference stays in the DB and is
 * restored automatically if the cap is later removed).
 *
 * The tag-along branch below — appending `currentValueSeconds` to the option
 * list when it isn't already present — is now defensive only. It exists so
 * that any caller passing an out-of-range value (e.g. tests, or future
 * callers wanting to surface the raw user preference) still gets a renderable
 * form, rather than a dropdown whose `defaultValue` matches no option.
 */
export function getAllowedSessionOptions(
  orgCapSeconds: number | null,
  currentValueSeconds: number
): SessionDurationOption[] {
  const allowed = SESSION_DURATION_OPTIONS.filter((opt) => {
    if (orgCapSeconds === null) return true;
    return opt.value <= orgCapSeconds;
  });

  if (!allowed.some((o) => o.value === currentValueSeconds)) {
    const currentLabel =
      SESSION_DURATION_OPTIONS.find((o) => o.value === currentValueSeconds)?.label ??
      `${currentValueSeconds} seconds`;
    allowed.push({ value: currentValueSeconds, label: currentLabel });
    allowed.sort((a, b) => a.value - b.value);
  }

  return allowed;
}

/** Session key holding when the session was issued (ms since epoch), for session policy checks. */
export const SESSION_ISSUED_AT_KEY = "issuedAt";
/** Session key holding when the session's own window closes (ms since epoch). */
export const SESSION_EXPIRES_AT_KEY = "expiresAt";

type SessionTimes = { issuedAt?: number; expiresAt?: number };

export function getSessionTimes(session: Session): SessionTimes {
  const issuedAt = session.get(SESSION_ISSUED_AT_KEY);
  const expiresAt = session.get(SESSION_EXPIRES_AT_KEY);
  return {
    issuedAt: typeof issuedAt === "number" ? issuedAt : undefined,
    expiresAt: typeof expiresAt === "number" ? expiresAt : undefined,
  };
}

/**
 * When the session's own window closes: its stamped expiry, else one cookie lifetime after it was
 * issued. Undefined for sessions that predate issue-time stamping.
 */
export function sessionWindowEnd({ issuedAt, expiresAt }: SessionTimes): number | undefined {
  if (expiresAt !== undefined) return expiresAt;
  return issuedAt === undefined ? undefined : issuedAt + DEFAULT_SESSION_DURATION_SECONDS * 1000;
}

type SessionRevocationState = {
  sessionsValidAfter: Date | null;
  revokedSessions: Date[];
};

/**
 * Why a session is no longer accepted, or undefined while it is. A session without an issue time
 * counts as issued before any cut-off.
 */
export function sessionEndReason(
  state: SessionRevocationState,
  times: SessionTimes,
  now: number
): "revoked" | "expired" | undefined {
  const { issuedAt } = times;
  const validAfter = state.sessionsValidAfter?.getTime();
  if (validAfter !== undefined && (issuedAt === undefined || issuedAt < validAfter)) {
    return "revoked";
  }
  if (issuedAt !== undefined && state.revokedSessions.some((d) => d.getTime() === issuedAt)) {
    return "revoked";
  }
  const windowEnd = sessionWindowEnd(times);
  if (windowEnd !== undefined && now > windowEnd) return "expired";
  return undefined;
}

/**
 * Ends every session of `userId` issued before `at`. A later cut-off already recorded is kept, so
 * concurrent account changes never bring an ended session back.
 */
export async function endSessionsIssuedBefore(
  userId: string,
  at: Date,
  client: PrismaClientOrTransaction = prisma
): Promise<void> {
  await client.$executeRaw`UPDATE "User" SET "sessionsValidAfter" = GREATEST("sessionsValidAfter",
      (to_timestamp(${at.getTime()}::float8 / 1000) AT TIME ZONE 'UTC')::timestamp(3))
    WHERE id = ${userId}`;
}

/** Signed-out sessions kept per user before falling back to ending all of them. */
const MAX_REVOKED_SESSIONS = 50;

/**
 * Records a signed-out session so its cookie is no longer accepted. Entries older than the longest
 * possible session are dropped on each write; when the list is full, every session issued until
 * now is ended instead. A session without an issue time ends all of the user's sessions that lack
 * one, via the earliest possible `sessionsValidAfter`.
 */
export async function revokeSession(
  userId: string,
  issuedAt: number | undefined,
  client: PrismaClientOrTransaction = prisma
): Promise<void> {
  if (issuedAt === undefined) {
    await client.user.updateMany({
      where: { id: userId, sessionsValidAfter: null },
      data: { sessionsValidAfter: new Date(1) },
    });
    return;
  }
  // Every expression reads the row being updated, so concurrent sign-outs don't drop each other.
  const issued = Prisma.sql`(to_timestamp(${issuedAt}::float8 / 1000) AT TIME ZONE 'UTC')::timestamp(3)`;
  const kept = Prisma.sql`ARRAY(SELECT t FROM unnest("revokedSessions") t
    WHERE t > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${DEFAULT_SESSION_DURATION_SECONDS}))`;
  const full = Prisma.sql`cardinality(${kept}) >= ${MAX_REVOKED_SESSIONS}`;
  // A session that is already ended changes nothing, so repeats never use up the list.
  await client.$executeRaw`UPDATE "User" SET
    "revokedSessions" = CASE WHEN ${full} THEN ARRAY[]::TIMESTAMP(3)[]
      ELSE array_append(${kept}, ${issued}) END,
    "sessionsValidAfter" = CASE WHEN ${full} THEN GREATEST("sessionsValidAfter", now() AT TIME ZONE 'UTC')
      ELSE "sessionsValidAfter" END
    WHERE id = ${userId}
      AND NOT (${issued} = ANY("revokedSessions"))
      AND ("sessionsValidAfter" IS NULL OR "sessionsValidAfter" <= ${issued})`;
}

/**
 * Commits the session for an authenticated user and stamps the user's
 * effective expiry into `User.nextSessionEnd`. Use this at every
 * login/MFA-completion point so the session window starts fresh, plus any
 * time the user re-affirms their session duration. The single DB write here
 * is the canonical "compute effective duration" step — request-time checks
 * just read `nextSessionEnd` from the row that `requireUser`/`getUser`
 * already fetches.
 *
 * The auth cookie's `Max-Age` is intentionally long
 * (`DEFAULT_SESSION_DURATION_SECONDS`, 1 year) so the cookie always reaches
 * the server. Actual session expiry is enforced server-side by reading
 * `User.nextSessionEnd`. If we let the cookie expire client-side, the user
 * is silently logged out.
 */
export async function commitAuthenticatedSession(
  session: Session,
  userId: string,
  now: number = Date.now(),
  client: PrismaClientOrTransaction = prisma
): Promise<string> {
  const { durationSeconds } = await getEffectiveSessionDuration(userId, client);
  const issued = Prisma.sql`to_timestamp(${now}::float8 / 1000) AT TIME ZONE 'UTC'`;
  const end = now + durationSeconds * 1000;
  // Sessions that already passed the previous deadline stay ended once the new deadline is set.
  await client.$executeRaw`UPDATE "User" SET
    "sessionsValidAfter" = CASE WHEN "nextSessionEnd" < ${issued}
      THEN GREATEST("sessionsValidAfter", ${issued}) ELSE "sessionsValidAfter" END,
    "nextSessionEnd" = to_timestamp(${end}::float8 / 1000) AT TIME ZONE 'UTC'
    WHERE id = ${userId}`;
  session.set(SESSION_ISSUED_AT_KEY, now);
  session.set(SESSION_EXPIRES_AT_KEY, end);
  return commitSession(session, { maxAge: DEFAULT_SESSION_DURATION_SECONDS });
}

/**
 * Applies a new session duration without lengthening any session. A shorter duration moves the
 * deadline earlier and ends the user's other sessions, so a later login can't carry them past it;
 * this session is kept with its window shortened. A longer duration takes effect at the next login.
 */
export async function shortenAuthenticatedSession(
  session: Session,
  userId: string,
  now: number = Date.now(),
  client: PrismaClientOrTransaction = prisma
): Promise<string> {
  const { durationSeconds } = await getEffectiveSessionDuration(userId, client);
  const end = now + durationSeconds * 1000;
  const endAt = Prisma.sql`(to_timestamp(${end}::float8 / 1000) AT TIME ZONE 'UTC')::timestamp(3)`;
  const nowAt = Prisma.sql`(to_timestamp(${now}::float8 / 1000) AT TIME ZONE 'UTC')::timestamp(3)`;
  const shorter = Prisma.sql`${endAt} < COALESCE("nextSessionEnd", 'infinity'::timestamp)`;
  const [row] = await client.$queryRaw<{ shortened: boolean }[]>`UPDATE "User" SET
      "sessionsValidAfter" = CASE WHEN ${shorter}
        THEN GREATEST("sessionsValidAfter", ${nowAt}) ELSE "sessionsValidAfter" END,
      "nextSessionEnd" = CASE WHEN ${shorter} THEN ${endAt} ELSE "nextSessionEnd" END
    WHERE id = ${userId}
    RETURNING "nextSessionEnd" = ${endAt} AS shortened`;
  const windowEnd = Math.min(sessionWindowEnd(getSessionTimes(session)) ?? end, end);
  if (row?.shortened) session.set(SESSION_ISSUED_AT_KEY, now);
  session.set(SESSION_EXPIRES_AT_KEY, windowEnd);
  return commitSession(session, { maxAge: DEFAULT_SESSION_DURATION_SECONDS });
}
