import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

const prismaHolder = vi.hoisted(() => ({
  client: null as PrismaClient | null,
}));

const sent = vi.hoisted(() => ({
  links: [] as { to: string; confirmLink: string }[],
  notices: [] as { to: string; newEmail: string }[],
}));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return {
    Prisma,
    get prisma() {
      if (!prismaHolder.client) throw new Error("test prisma not set");
      return prismaHolder.client;
    },
  };
});

vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET: "test-session-secret", LOGIN_ORIGIN: "http://localhost:3030" },
}));

vi.mock("~/services/rateLimiter.server", () => ({
  createRedisRateLimitClient: () => ({}),
  RateLimiter: class {
    async limit() {
      return { success: true };
    }
  },
}));

vi.mock("~/services/ssoManagedIdentity.server", () => ({
  getEmailOwnership: async () => "user",
}));

vi.mock("~/services/email.server", () => ({
  sendEmail: async (data: {
    email: string;
    to: string;
    confirmLink?: string;
    newEmail?: string;
  }) => {
    if (data.email === "confirm-email-change") {
      sent.links.push({ to: data.to, confirmLink: data.confirmLink ?? "" });
    } else if (data.email === "email-changed") {
      sent.notices.push({ to: data.to, newEmail: data.newEmail ?? "" });
    }
  },
}));

import { postgresTest } from "@internal/testcontainers";

vi.setConfig({ testTimeout: 60_000 });

function suffix() {
  return randomBytes(6).toString("hex");
}

function lastToken(): string {
  const link = sent.links.at(-1);
  if (!link) throw new Error("no confirmation email sent");
  return new URL(link.confirmLink).searchParams.get("token") ?? "";
}

async function seedUser(prisma: PrismaClient) {
  const email = `old-${suffix()}@example.test`;
  return prisma.user.create({ data: { email, authenticationMethod: "MAGIC_LINK" } });
}

describe("email change", () => {
  postgresTest("live email is untouched until the link is opened", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const svc = await import("~/services/emailChange.server");
    const user = await seedUser(prisma);
    const newEmail = `new-${suffix()}@example.test`;

    expect(await svc.requestEmailChange(user, ` ${newEmail.toUpperCase()} `)).toEqual({ ok: true });

    const pending = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.email).toBe(user.email);
    expect(pending.pendingEmail).toBe(newEmail);
    expect(sent.links.at(-1)?.to).toBe(newEmail);

    const token = lastToken();
    expect(await svc.confirmEmailChange(token)).toMatchObject({ ok: true, userId: user.id });

    const confirmed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(confirmed.email).toBe(newEmail);
    expect(confirmed.pendingEmail).toBeNull();
    expect(sent.notices.at(-1)).toEqual({ to: user.email, newEmail });

    // Opening it again (a mail scanner got there first, or a double click)
    // reads as success without sending another notice.
    const noticesBefore = sent.notices.length;
    expect(await svc.confirmEmailChange(token)).toMatchObject({ ok: true, userId: user.id });
    expect(sent.notices.length).toBe(noticesBefore);
  });

  postgresTest("cancelled and replaced links stop working", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const svc = await import("~/services/emailChange.server");
    const user = await seedUser(prisma);

    await svc.requestEmailChange(user, `first-${suffix()}@example.test`);
    const cancelledToken = lastToken();
    await svc.cancelEmailChange(user.id);
    expect(await svc.confirmEmailChange(cancelledToken)).toMatchObject({ ok: false });

    await svc.requestEmailChange(user, `second-${suffix()}@example.test`);
    const replacedToken = lastToken();
    const latest = `third-${suffix()}@example.test`;
    await svc.requestEmailChange(user, latest);
    expect(await svc.confirmEmailChange(replacedToken)).toMatchObject({ ok: false });

    expect(await svc.confirmEmailChange(lastToken())).toMatchObject({ ok: true });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.email).toBe(latest);
  });

  postgresTest("a link only ever changes the account it was minted for", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const svc = await import("~/services/emailChange.server");
    const requester = await seedUser(prisma);
    const bystander = await seedUser(prisma);
    const newEmail = `target-${suffix()}@example.test`;

    await svc.requestEmailChange(requester, newEmail);
    // Whoever opens the link, the token names the account.
    expect(await svc.confirmEmailChange(lastToken())).toMatchObject({
      ok: true,
      userId: requester.id,
    });
    const other = await prisma.user.findUniqueOrThrow({ where: { id: bystander.id } });
    expect(other.email).toBe(bystander.email);
  });

  postgresTest("an address taken since the request fails cleanly", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const svc = await import("~/services/emailChange.server");
    const user = await seedUser(prisma);
    const newEmail = `contested-${suffix()}@example.test`;

    await svc.requestEmailChange(user, newEmail);
    await prisma.user.create({ data: { email: newEmail, authenticationMethod: "MAGIC_LINK" } });

    expect(await svc.confirmEmailChange(lastToken())).toMatchObject({ ok: false });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.email).toBe(user.email);
  });

  postgresTest("an existing account's address cannot be requested", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const svc = await import("~/services/emailChange.server");
    const user = await seedUser(prisma);
    const other = await seedUser(prisma);

    expect(await svc.requestEmailChange(user, other.email)).toMatchObject({ ok: false });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.pendingEmail).toBeNull();
  });
});
