import type { Session } from "@remix-run/node";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { commitSession, DEFAULT_SESSION_DURATION_SECONDS } from "./sessionStorage.server";

export { DEFAULT_SESSION_DURATION_SECONDS };

export const SESSION_ISSUED_AT_KEY = "session:issuedAt";

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
 * Returns the dropdown options the user is allowed to pick. If an org cap
 * exists, options strictly greater than the cap are removed. The user's
 * currently-saved value is always included even if it now exceeds the cap, so
 * the form remains valid until they pick a smaller value.
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

export function getSessionIssuedAt(session: Session): number | null {
  const raw = session.get(SESSION_ISSUED_AT_KEY);
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw;
}

/**
 * Returns true when the session has an issuedAt timestamp older than the
 * effective duration. Missing issuedAt is treated as not expired (legacy
 * cookies from before this feature shipped will be lazily backfilled).
 */
export function isSessionExpired(
  session: Session,
  effectiveDurationSeconds: number,
  now: number = Date.now()
): boolean {
  const issuedAt = getSessionIssuedAt(session);
  if (issuedAt === null) return false;
  return now - issuedAt > effectiveDurationSeconds * 1000;
}

/** Sets the session's issuedAt to `now` (epoch ms). */
export function setSessionIssuedAt(session: Session, now: number = Date.now()): void {
  session.set(SESSION_ISSUED_AT_KEY, now);
}

/**
 * If the session has no issuedAt set, sets it to `now` and returns true so the
 * caller knows to commit the cookie. Returns false when nothing changed.
 */
export function ensureSessionIssuedAt(session: Session, now: number = Date.now()): boolean {
  if (getSessionIssuedAt(session) !== null) return false;
  setSessionIssuedAt(session, now);
  return true;
}

/**
 * Commits the session for an authenticated user, setting `issuedAt = now`.
 * Use this at every login/MFA-completion point so the session window starts
 * fresh.
 *
 * The auth cookie's `Max-Age` is intentionally long
 * (`DEFAULT_SESSION_DURATION_SECONDS`, 1 year) so the cookie always reaches
 * the server. Actual session expiry is enforced server-side via
 * `sessionIssuedAt` against the user's effective duration. If we let the
 * cookie expire client-side, the user is silently logged out.
 */
export async function commitAuthenticatedSession(
  session: Session,
  now: number = Date.now()
): Promise<string> {
  setSessionIssuedAt(session, now);
  return commitSession(session, { maxAge: DEFAULT_SESSION_DURATION_SECONDS });
}

/**
 * Commits the session for an authenticated user, lazily backfilling
 * `issuedAt` if missing. Use on every authenticated response that already
 * commits the cookie (e.g. root.tsx).
 */
export async function commitAuthenticatedSessionLazy(
  session: Session,
  now: number = Date.now()
): Promise<string> {
  ensureSessionIssuedAt(session, now);
  return commitSession(session, { maxAge: DEFAULT_SESSION_DURATION_SECONDS });
}
