/**
 * Changing an account's email address requires opening a link sent to the new
 * address. Until then the new address sits in `User.pendingEmail` and the live
 * `User.email` (which invites and logins key on) is untouched.
 *
 * The link carries a signed, stateless token. `pendingEmail` is what makes it
 * single-use: confirming clears it, cancelling clears it, and a newer request
 * for a different address overwrites it, so an older link no longer matches.
 */

import { Prisma } from "@trigger.dev/database";
import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { Ratelimit } from "@upstash/ratelimit";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { sendEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { getEmailOwnership } from "~/services/ssoManagedIdentity.server";
import { assertEmailAllowed } from "~/utils/email";
import { singleton } from "~/utils/singleton";

const TOKEN_PREFIX = "tr_ecc_";
const TOKEN_KIND = "email_change";
const TOKEN_TTL = "1h";

const EMAIL_CHANGE_CONFIRM_PATH = "/account/email/confirm";

const requestRateLimiter = singleton(
  "emailChangeRequestRateLimiter",
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
      keyPrefix: "account:email-change",
      limiter: Ratelimit.slidingWindow(5, "1 h"), // 5 confirmation emails / hour / user
      logSuccess: false,
      logFailure: true,
    })
);

type EmailChangeClaims = { userId: string; email: string };

async function signEmailChangeToken(secret: string, claims: EmailChangeClaims): Promise<string> {
  const jwt = await generateJWT({
    secretKey: secret,
    payload: { kind: TOKEN_KIND, sub: claims.userId, email: claims.email },
    expirationTime: TOKEN_TTL,
  });
  return `${TOKEN_PREFIX}${jwt}`;
}

async function verifyEmailChangeToken(
  secret: string,
  token: string
): Promise<EmailChangeClaims | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return;

  const result = await validateJWT(token.slice(TOKEN_PREFIX.length), secret);
  if (!result.ok) return;

  const { kind, sub, email } = result.payload;
  if (kind !== TOKEN_KIND) return;
  if (typeof sub !== "string" || sub.length === 0) return;
  if (typeof email !== "string" || email.length === 0) return;

  return { userId: sub, email };
}

type EmailChangeFailure = { ok: false; error: string; status: number };
export type EmailChangeResult = { ok: true } | EmailChangeFailure;

function failure(error: string, status: number): EmailChangeFailure {
  return { ok: false, error, status };
}

/** Same folding as the login form, so the confirmed address matches a later magic-link login. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Instance allowlist and SSO ownership. Run when a change is requested and
 * again when it is confirmed, since either can change while the link is live.
 */
async function checkEmailPolicy(
  user: { id: string; email: string },
  email: string
): Promise<EmailChangeResult> {
  try {
    assertEmailAllowed(email);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "That email address isn't allowed.",
      400
    );
  }

  const ownership = await getEmailOwnership(user, email);
  if (ownership === "idp") {
    return failure("Your email address is managed by your organization's identity provider.", 403);
  }
  if (ownership === "unknown") {
    return failure(
      "We couldn't check your single sign-on settings just now. Please try again shortly.",
      503
    );
  }

  return { ok: true };
}

/**
 * Store `newEmail` as pending and send the confirmation link to it. `User.email`
 * is not changed here.
 */
export async function requestEmailChange(
  user: { id: string; email: string },
  newEmail: string
): Promise<EmailChangeResult> {
  const email = normalizeEmail(newEmail);

  if (email === normalizeEmail(user.email)) {
    return failure("That's already your email address.", 400);
  }

  const policy = await checkEmailPolicy(user, email);
  if (!policy.ok) return policy;

  const existingUser = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  if (existingUser && existingUser.id !== user.id) {
    return failure("Email is already being used by a different account", 400);
  }

  const limit = await requestRateLimiter.limit(user.id);
  if (!limit.success) {
    return failure("Too many confirmation emails sent. Please try again later.", 429);
  }

  await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: email } });

  const token = await signEmailChangeToken(env.SESSION_SECRET, { userId: user.id, email });
  const confirmLink = `${env.LOGIN_ORIGIN}${EMAIL_CHANGE_CONFIRM_PATH}?token=${encodeURIComponent(token)}`;

  try {
    await sendEmail({ email: "confirm-email-change", to: email, confirmLink });
  } catch (error) {
    logger.error("Failed sending email change confirmation", { userId: user.id, error });
    return failure("Failed sending the confirmation email. Please try again shortly.", 500);
  }

  return { ok: true };
}

/** Re-send the link for the address already pending on the account. */
export async function resendEmailChange(user: {
  id: string;
  email: string;
}): Promise<EmailChangeResult> {
  const record = await prisma.user.findFirst({
    where: { id: user.id },
    select: { pendingEmail: true },
  });
  if (!record?.pendingEmail) {
    return failure("There's no email change waiting to be confirmed.", 400);
  }
  return requestEmailChange(user, record.pendingEmail);
}

export async function cancelEmailChange(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { pendingEmail: null } });
}

export type ConfirmEmailChangeResult =
  | { ok: true; userId: string; email: string }
  | EmailChangeFailure;

/**
 * Complete the change. No session is needed: the token names the account and
 * the address, and possessing it proves access to that inbox. The WHERE on
 * `pendingEmail` makes the swap atomic: a link that was cancelled, replaced,
 * or already used matches zero rows.
 */
export async function confirmEmailChange(token: string): Promise<ConfirmEmailChangeResult> {
  const claims = await verifyEmailChangeToken(env.SESSION_SECRET, token);
  if (!claims) {
    return failure("This confirmation link is invalid or has expired.", 400);
  }

  const user = await prisma.user.findFirst({
    where: { id: claims.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    return failure("This confirmation link is invalid or has expired.", 400);
  }

  // Already applied: mail scanners fetch links before the recipient does, and
  // people open them twice. Both must read as success, not as a dead link.
  if (normalizeEmail(user.email) === claims.email) {
    return { ok: true, userId: user.id, email: claims.email };
  }

  const policy = await checkEmailPolicy(user, claims.email);
  if (!policy.ok) return policy;

  try {
    const { count } = await prisma.user.updateMany({
      where: { id: user.id, pendingEmail: claims.email },
      data: { email: claims.email, pendingEmail: null },
    });
    if (count === 0) {
      // A concurrent open may have applied it between the read above and here.
      const now = await prisma.user.findFirst({ where: { id: user.id }, select: { email: true } });
      if (now && normalizeEmail(now.email) === claims.email) {
        return { ok: true, userId: user.id, email: claims.email };
      }
      return failure("This confirmation link is no longer valid. Request a new one.", 400);
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure("Email is already being used by a different account", 400);
    }
    throw error;
  }

  // Best effort: the change is done; the previous owner should hear about it.
  try {
    await sendEmail({ email: "email-changed", to: user.email, newEmail: claims.email });
  } catch (error) {
    logger.error("Failed sending email changed notice", { userId: user.id, error });
  }

  return { ok: true, userId: user.id, email: claims.email };
}
