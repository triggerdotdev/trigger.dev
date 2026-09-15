import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  AUTHORIZATION_CODE_TTL_MS,
  isAuthorizationCodeMintable,
} from "~/services/personalAccessToken.server";

vi.setConfig({ testTimeout: 30_000 });

function randomCode() {
  return `code_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

// Lock the read-only + TTL properties `isAuthorizationCodeMintable` relies on:
// the loader must not bind a PAT, and expired codes must not be mintable.
describe("authorization code consent gate", () => {
  containerTest(
    "a fresh, unconsumed code is mintable and checking it does NOT bind a PAT",
    async ({ prisma }) => {
      const created = await prisma.authorizationCode.create({ data: { code: randomCode() } });

      expect(await isAuthorizationCodeMintable(created.code, prisma)).toBe(true);

      // The check is read-only — it must not bind a Personal Access Token.
      const after = await prisma.authorizationCode.findFirst({ where: { id: created.id } });
      expect(after?.personalAccessTokenId).toBeNull();
    }
  );

  containerTest("a code older than the TTL is not mintable", async ({ prisma }) => {
    const created = await prisma.authorizationCode.create({ data: { code: randomCode() } });

    await prisma.authorizationCode.update({
      where: { id: created.id },
      data: { createdAt: new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS - 1_000) },
    });

    expect(await isAuthorizationCodeMintable(created.code, prisma)).toBe(false);
  });

  containerTest(
    "a code created just inside the TTL is still mintable (CLI flow not broken)",
    async ({ prisma }) => {
      const created = await prisma.authorizationCode.create({ data: { code: randomCode() } });

      await prisma.authorizationCode.update({
        where: { id: created.id },
        data: { createdAt: new Date(Date.now() - (AUTHORIZATION_CODE_TTL_MS - 30_000)) },
      });

      expect(await isAuthorizationCodeMintable(created.code, prisma)).toBe(true);
    }
  );

  containerTest("an unknown code is not mintable", async ({ prisma }) => {
    expect(await isAuthorizationCodeMintable(randomCode(), prisma)).toBe(false);
  });
});
