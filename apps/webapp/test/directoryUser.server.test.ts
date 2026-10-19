import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { findOrCreateDirectoryUser } from "~/models/directoryUser.server";

vi.setConfig({ testTimeout: 60_000 });

describe("findOrCreateDirectoryUser", () => {
  postgresTest("reuses the user with the lowercased email", async ({ prisma }) => {
    const existing = await prisma.user.create({
      data: { email: "kai@example.com", authenticationMethod: "GITHUB" },
    });

    const result = await findOrCreateDirectoryUser(prisma, {
      email: "Kai@Example.com",
      firstName: "Kai",
      lastName: null,
    });

    expect(result.userId).toBe(existing.id);
    expect(await prisma.user.count()).toBe(1);
  });

  postgresTest("reuses a user whose stored email differs only in case", async ({ prisma }) => {
    const existing = await prisma.user.create({
      data: { email: "Kai.Smith@Example.com", authenticationMethod: "GITHUB" },
    });

    const result = await findOrCreateDirectoryUser(prisma, {
      email: "kai.smith@example.com",
      firstName: "Kai",
      lastName: null,
    });

    expect(result.userId).toBe(existing.id);
    expect(await prisma.user.count()).toBe(1);
  });

  postgresTest("creates a separate user when only ambiguous casings exist", async ({ prisma }) => {
    const upper = await prisma.user.create({
      data: { email: "Amb@example.com", authenticationMethod: "GITHUB" },
    });
    const shout = await prisma.user.create({
      data: { email: "AMB@example.com", authenticationMethod: "GOOGLE" },
    });

    const result = await findOrCreateDirectoryUser(prisma, {
      email: "amb@example.com",
      firstName: null,
      lastName: null,
    });

    expect([upper.id, shout.id]).not.toContain(result.userId);
    const created = await prisma.user.findFirstOrThrow({ where: { id: result.userId } });
    expect(created.email).toBe("amb@example.com");
  });

  postgresTest("creates a lowercased SSO user when none matches", async ({ prisma }) => {
    const result = await findOrCreateDirectoryUser(prisma, {
      email: "  New.User@Example.com ",
      firstName: "New",
      lastName: "User",
    });

    const created = await prisma.user.findFirstOrThrow({ where: { id: result.userId } });
    expect(created).toMatchObject({
      email: "new.user@example.com",
      authenticationMethod: "SSO",
      name: "New User",
    });
  });
});
