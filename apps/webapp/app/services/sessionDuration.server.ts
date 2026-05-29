import type { Session } from "@remix-run/node";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
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
  await client.user.update({
    where: { id: userId },
    data: { nextSessionEnd: new Date(now + durationSeconds * 1000) },
  });
  return commitSession(session, { maxAge: DEFAULT_SESSION_DURATION_SECONDS });
}
