// The expiry email job against real token rows in Postgres. The job gets its database client and
// a recording `send` as arguments, as the other sweeps on the same worker do, so nothing is mocked:
// each test sees exactly which emails the job asked for.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import type { DeliverEmail } from "emails";
import { describe, expect, it, vi } from "vitest";
import {
  claimNotice,
  personalAccessTokenExpiryEmailsSchedule,
  sendPersonalAccessTokenExpiryEmails,
} from "~/services/personalAccessTokenExpiryEmails.server";

vi.setConfig({ testTimeout: 60_000 });

const TOKENS_URL = "https://dashboard.example.test/account/tokens";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-10T12:00:00.000Z");

function recordingSend() {
  return vi.fn(async (_email: DeliverEmail) => {});
}

/** The emails `send` was asked to deliver to this address. */
function emailsTo(send: ReturnType<typeof recordingSend>, address: string) {
  return send.mock.calls.map(([email]) => email).filter((email) => email.to === address);
}

async function createToken(
  prisma: PrismaClient,
  options: { name?: string; expiresAt: Date | null; revoked?: boolean; lastAccessedAt?: Date }
) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const user = await prisma.user.create({
    data: { email: `pat-owner-${suffix}@example.test`, authenticationMethod: "MAGIC_LINK" },
  });
  // The job reads only these columns, so the token needn't be a usable one.
  const row = await prisma.personalAccessToken.create({
    data: {
      name: options.name ?? `ci-deploy-${suffix}`,
      userId: user.id,
      encryptedToken: {},
      obfuscatedToken: `tr_pat_${suffix}••••`,
      hashedToken: `hash-${suffix}`,
      expiresAt: options.expiresAt,
      revokedAt: options.revoked ? NOW : null,
      lastAccessedAt: options.lastAccessedAt ?? null,
    },
  });
  return { id: row.id, userEmail: user.email };
}

describe("personal access token expiry emails", () => {
  /** Catches: no warning before expiry, a duplicate on the next run, or a leak of the token. */
  postgresTest(
    "a token expiring within 7 days gets one 'about to expire' email",
    async ({ prisma }) => {
      const expiresAt = new Date(NOW.getTime() + 3 * DAY_MS);
      const lastAccessedAt = new Date(NOW.getTime() - DAY_MS);
      const token = await createToken(prisma, {
        name: "github-actions-deploy",
        expiresAt,
        lastAccessedAt,
      });
      const send = recordingSend();

      await sendPersonalAccessTokenExpiryEmails(prisma, send, { now: NOW, tokensUrl: TOKENS_URL });
      await sendPersonalAccessTokenExpiryEmails(prisma, send, { now: NOW, tokensUrl: TOKENS_URL });

      const emails = emailsTo(send, token.userEmail);
      expect(emails).toEqual([
        {
          email: "personal-access-token-expiring",
          to: token.userEmail,
          tokenName: "github-actions-deploy",
          expiresAt: expiresAt.toUTCString(),
          lastUsedAt: lastAccessedAt.toUTCString(),
          tokensUrl: TOKENS_URL,
        },
      ]);
      expect(JSON.stringify(emails)).not.toContain("tr_pat_");
    }
  );

  /** Catches: a missing or repeated email over a token's life, warning then expiry. */
  postgresTest("over its life a token gets exactly one email of each kind", async ({ prisma }) => {
    const expiresAt = new Date(NOW.getTime() + 2 * DAY_MS);
    const token = await createToken(prisma, { expiresAt });
    const send = recordingSend();
    const afterExpiry = new Date(expiresAt.getTime() + 60_000);

    await sendPersonalAccessTokenExpiryEmails(prisma, send, { now: NOW, tokensUrl: TOKENS_URL });
    await sendPersonalAccessTokenExpiryEmails(prisma, send, {
      now: afterExpiry,
      tokensUrl: TOKENS_URL,
    });
    await sendPersonalAccessTokenExpiryEmails(prisma, send, {
      now: afterExpiry,
      tokensUrl: TOKENS_URL,
    });

    expect(emailsTo(send, token.userEmail).map((email) => email.email)).toEqual([
      "personal-access-token-expiring",
      "personal-access-token-expired",
    ]);
    const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.expiryReminderSentAt).toEqual(NOW);
    expect(row.expiredNoticeSentAt).toEqual(afterExpiry);
  });

  /** Catches: a warning for a token that's already expired when the job first sees it. */
  postgresTest(
    "a token that's already expired gets only the 'has expired' email",
    async ({ prisma }) => {
      const token = await createToken(prisma, { expiresAt: new Date(NOW.getTime() - 60 * 60_000) });
      const send = recordingSend();

      await sendPersonalAccessTokenExpiryEmails(prisma, send, { now: NOW, tokensUrl: TOKENS_URL });

      expect(emailsTo(send, token.userEmail)).toEqual([
        expect.objectContaining({ email: "personal-access-token-expired", lastUsedAt: undefined }),
      ]);
    }
  );

  /** Catches: emails for tokens that are revoked, never expire, or are outside both windows. */
  postgresTest("other tokens get no email", async ({ prisma }) => {
    await Promise.all([
      createToken(prisma, { expiresAt: new Date(NOW.getTime() + 3 * DAY_MS), revoked: true }),
      createToken(prisma, { expiresAt: new Date(NOW.getTime() - DAY_MS), revoked: true }),
      createToken(prisma, { expiresAt: null }),
      createToken(prisma, { expiresAt: new Date(NOW.getTime() + 8 * DAY_MS) }),
      createToken(prisma, { expiresAt: new Date(NOW.getTime() - 8 * DAY_MS) }),
    ]);
    const send = recordingSend();

    await sendPersonalAccessTokenExpiryEmails(prisma, send, { now: NOW, tokensUrl: TOKENS_URL });

    expect(send).not.toHaveBeenCalled();
  });

  /** Catches: a second worker sending an email the first has picked up but not yet sent. */
  postgresTest(
    "a run that starts while another is sending doesn't send the same email",
    async ({ prisma }) => {
      const token = await createToken(prisma, { expiresAt: new Date(NOW.getTime() + DAY_MS) });
      const send = recordingSend();
      let secondRun: Awaited<ReturnType<typeof sendPersonalAccessTokenExpiryEmails>> | undefined;

      // The first run's sender starts a second run before delivering, the window a second worker
      // would hit.
      const firstRun = await sendPersonalAccessTokenExpiryEmails(
        prisma,
        async (email) => {
          secondRun ??= await sendPersonalAccessTokenExpiryEmails(prisma, send, {
            now: NOW,
            tokensUrl: TOKENS_URL,
          });
          return send(email);
        },
        { now: NOW, tokensUrl: TOKENS_URL }
      );

      expect(firstRun.sent).toBe(1);
      expect(secondRun).toEqual({ sent: 0, failed: 0 });
      expect(emailsTo(send, token.userEmail)).toHaveLength(1);
    }
  );

  /** Catches: two workers that both found a token each winning the claim, so both send. */
  postgresTest("only one claim on an email wins", async ({ prisma }) => {
    const token = await createToken(prisma, { expiresAt: new Date(NOW.getTime() + DAY_MS) });
    const revoked = await createToken(prisma, {
      expiresAt: new Date(NOW.getTime() + DAY_MS),
      revoked: true,
    });

    const claims = await Promise.all([
      claimNotice(prisma, token.id, "expiryReminderSentAt", NOW),
      claimNotice(prisma, token.id, "expiryReminderSentAt", NOW),
    ]);

    expect(claims.sort()).toEqual([false, true]);
    expect(await claimNotice(prisma, token.id, "expiredNoticeSentAt", NOW)).toBe(true);
    expect(await claimNotice(prisma, revoked.id, "expiryReminderSentAt", NOW)).toBe(false);
  });

  /** Catches: a failed send leaving the email marked as sent, so it's never retried. */
  postgresTest("a failed send is retried on the next run", async ({ prisma }) => {
    const token = await createToken(prisma, { expiresAt: new Date(NOW.getTime() + DAY_MS) });
    const failing = vi.fn(async (_email: DeliverEmail) => {
      throw new Error("Email provider unavailable");
    });
    const send = recordingSend();

    const failedRun = await sendPersonalAccessTokenExpiryEmails(prisma, failing, {
      now: NOW,
      tokensUrl: TOKENS_URL,
    });
    const afterFailure = await prisma.personalAccessToken.findUniqueOrThrow({
      where: { id: token.id },
    });
    await sendPersonalAccessTokenExpiryEmails(prisma, send, { now: NOW, tokensUrl: TOKENS_URL });

    expect(failedRun).toEqual({ sent: 0, failed: 1 });
    expect(afterFailure.expiryReminderSentAt).toBeNull();
    expect(emailsTo(send, token.userEmail)).toHaveLength(1);
  });

  /** Catches: the job running, and marking emails sent, while the webapp can only log them. */
  it("is only scheduled when it's enabled and an email transport is set", () => {
    expect(
      personalAccessTokenExpiryEmailsSchedule({ enabled: true, emailTransport: "smtp" })
    ).toEqual({ cron: "0 * * * *", jitterInMs: 5 * 60_000 });
    expect(
      personalAccessTokenExpiryEmailsSchedule({ enabled: true, emailTransport: undefined })
    ).toBeUndefined();
    expect(
      personalAccessTokenExpiryEmailsSchedule({ enabled: false, emailTransport: "smtp" })
    ).toBeUndefined();
  });
});
