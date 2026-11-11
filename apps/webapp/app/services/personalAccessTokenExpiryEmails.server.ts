import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { DeliverEmail } from "emails";
import { logger } from "./logger.server";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long before its expiry a token's owner is warned. The tokens page flags a token as expiring
 * soon from the same point.
 */
export const PERSONAL_ACCESS_TOKEN_EXPIRING_SOON_DAYS = 7;
const PERSONAL_ACCESS_TOKEN_REMINDER_WINDOW_MS = PERSONAL_ACCESS_TOKEN_EXPIRING_SOON_DAYS * DAY_MS;

/**
 * How long after its expiry a token still gets the "has expired" email. A token that expired
 * earlier (say, while the job wasn't running) gets none, rather than a late burst of them.
 */
const PERSONAL_ACCESS_TOKEN_EXPIRED_NOTICE_WINDOW_MS = 7 * DAY_MS;

type SendEmail = (email: DeliverEmail) => Promise<unknown>;

type NoticeColumn = "expiryReminderSentAt" | "expiredNoticeSentAt";

type Notice = {
  email: "personal-access-token-expiring" | "personal-access-token-expired";
  sentAtColumn: NoticeColumn;
  expiresAt: { gt: Date; lte: Date };
};

/**
 * Emails the owner of each dashboard-created personal access token once before it expires and
 * once when it has. CLI logins have no `expiresAt`, so they get neither.
 *
 * Each email is claimed by setting its `*SentAt` column before it's sent, so a retry or a second
 * worker never sends it twice. A failed send clears the claim for the next run to retry. A process
 * that dies between the claim and the send loses that email: at most once, never twice.
 */
export async function sendPersonalAccessTokenExpiryEmails(
  prismaClient: PrismaClientOrTransaction,
  send: SendEmail,
  options: { tokensUrl: string; batchSize?: number; maxPages?: number; now?: Date }
): Promise<{ sent: number; failed: number }> {
  const { tokensUrl, batchSize = 500, maxPages = 20, now = new Date() } = options;
  const notices: Notice[] = [
    {
      email: "personal-access-token-expiring",
      sentAtColumn: "expiryReminderSentAt",
      expiresAt: {
        gt: now,
        lte: new Date(now.getTime() + PERSONAL_ACCESS_TOKEN_REMINDER_WINDOW_MS),
      },
    },
    {
      email: "personal-access-token-expired",
      sentAtColumn: "expiredNoticeSentAt",
      expiresAt: {
        gt: new Date(now.getTime() - PERSONAL_ACCESS_TOKEN_EXPIRED_NOTICE_WINDOW_MS),
        lte: now,
      },
    },
  ];

  let sent = 0;
  let failed = 0;
  for (const notice of notices) {
    const result = await sendNotice(prismaClient, send, notice, {
      tokensUrl,
      batchSize,
      maxPages,
      now,
    });
    sent += result.sent;
    failed += result.failed;
  }

  if (sent > 0 || failed > 0) {
    logger.info("Sent personal access token expiry emails", { sent, failed });
  }
  return { sent, failed };
}

async function sendNotice(
  prismaClient: PrismaClientOrTransaction,
  send: SendEmail,
  notice: Notice,
  {
    tokensUrl,
    batchSize,
    maxPages,
    now,
  }: { tokensUrl: string; batchSize: number; maxPages: number; now: Date }
) {
  let sent = 0;
  let failed = 0;
  // Paged by id, so a token whose send failed (and whose claim was cleared) isn't picked up again
  // in the same run.
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const tokens = await prismaClient.personalAccessToken.findMany({
      where: {
        revokedAt: null,
        expiresAt: notice.expiresAt,
        [notice.sentAtColumn]: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: {
        id: true,
        name: true,
        expiresAt: true,
        lastAccessedAt: true,
        user: { select: { email: true } },
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });

    for (const token of tokens) {
      if (!(await claimNotice(prismaClient, token.id, notice.sentAtColumn, now))) continue;

      try {
        await send({
          email: notice.email,
          to: token.user.email,
          tokenName: token.name,
          expiresAt: token.expiresAt!.toUTCString(),
          lastUsedAt: token.lastAccessedAt?.toUTCString(),
          tokensUrl,
        });
        sent++;
      } catch (error) {
        failed++;
        await prismaClient.personalAccessToken.updateMany({
          where: { id: token.id, [notice.sentAtColumn]: now },
          data: { [notice.sentAtColumn]: null },
        });
        logger.error("Failed to send a personal access token expiry email", {
          tokenId: token.id,
          // Not `email`, which the logger redacts.
          template: notice.email,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (tokens.length < batchSize) break;
    cursor = tokens[tokens.length - 1]!.id;
  }

  return { sent, failed };
}

/**
 * Marks one email as sent, if nothing has yet. Returns whether this caller won, so of two workers
 * that both found the token, only one sends.
 */
export async function claimNotice(
  prismaClient: PrismaClientOrTransaction,
  tokenId: string,
  column: NoticeColumn,
  now: Date
): Promise<boolean> {
  const claimed = await prismaClient.personalAccessToken.updateMany({
    where: { id: tokenId, revokedAt: null, [column]: null },
    data: { [column]: now },
  });
  return claimed.count === 1;
}

/**
 * The job's cron schedule, or none. It only runs when emails can actually go out: with no
 * transport the webapp just logs them, and the job would still record each one as sent, so
 * configuring email later would never deliver them.
 */
export function personalAccessTokenExpiryEmailsSchedule(options: {
  enabled: boolean;
  emailTransport: string | undefined;
}): { cron: string; jitterInMs: number } | undefined {
  if (!options.enabled || !options.emailTransport) return undefined;
  return { cron: "0 * * * *", jitterInMs: 5 * 60_000 };
}
