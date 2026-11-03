import { createHash } from "@better-auth/utils/hash";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { postgresAndRedisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { createMfaRateLimiters } from "~/services/mfa/mfaRateLimiter.server";
import { MultiFactorAuthenticationService } from "~/services/mfa/multiFactorAuthentication.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const secret = "EXISTINGMFASECRET12345678";
const recoveryCode = "existing-recovery-code";

const mfaTest = postgresAndRedisTest.extend<{ service: MultiFactorAuthenticationService }>({
  service: async ({ prisma, redisOptions }, use) => {
    const limiters = createMfaRateLimiters({
      redisOptions: { ...redisOptions, tlsDisabled: true },
    });
    await use(new MultiFactorAuthenticationService(prisma, limiters));
  },
});

async function createEnabledUser(prisma: PrismaClient) {
  const user = await prisma.user.create({
    data: {
      email: "mfa@example.com",
      authenticationMethod: "MAGIC_LINK",
      mfaEnabledAt: new Date(),
      mfaSecretReference: { create: { key: "mfa:existing", provider: "DATABASE" } },
      backupCodes: {
        create: { code: await createHash("SHA-512", "hex").digest(recoveryCode) },
      },
    },
    include: { mfaSecretReference: true, backupCodes: true },
  });
  await getSecretStore("DATABASE", { prismaClient: prisma }).setSecret("mfa:existing", {
    secret,
  });
  return user;
}

describe("MFA enrollment", () => {
  // Catches: requiring an existing factor accidentally prevents first enrollment or setup retries.
  mfaTest(
    "allows initial enrollment and confirmation without current proof",
    async ({ prisma, service }) => {
      const user = await prisma.user.create({
        data: { email: "new-mfa@example.com", authenticationMethod: "MAGIC_LINK" },
      });
      const setup = await service.enableTotp(user.id);
      expect(setup.otpAuthUrl).toContain("otpauth://totp/");
      expect(
        (await prisma.user.findFirstOrThrow({ where: { id: user.id } })).mfaEnabledAt
      ).toBeNull();

      const rawSecret = new TextDecoder().decode(base32.decode(setup.secret));
      const retry = await service.validateTotpSetup(user.id, "invalid");
      expect(retry).toEqual({ success: false });

      const confirmation = await service.validateTotpSetup(
        user.id,
        await createOTP(rawSecret).totp()
      );
      expect(confirmation.success).toBe(true);
      expect(confirmation.recoveryCodes).toHaveLength(9);
      expect(await prisma.mfaBackupCode.count({ where: { userId: user.id } })).toBe(9);
      expect(
        (await prisma.user.findFirstOrThrow({ where: { id: user.id } })).mfaEnabledAt
      ).not.toBeNull();
    }
  );

  // Catches: an authenticated session can replace an enabled factor without proving it.
  mfaTest(
    "preserves the existing factor and recovery codes after missing or invalid proof",
    async ({ prisma, service }) => {
      const user = await createEnabledUser(prisma);
      const storedSecret = await prisma.secretStore.findFirstOrThrow({
        where: { key: "mfa:existing" },
      });

      const validCode = await createOTP(secret).totp();
      const invalidCode = String((Number(validCode) + 1) % 1_000_000).padStart(6, "0");
      for (const proof of [undefined, { totpCode: invalidCode }, { recoveryCode: "invalid" }]) {
        await expect(service.enableTotp(user.id, proof)).rejects.toBeInstanceOf(
          ServiceValidationError
        );
        expect(await prisma.user.findFirstOrThrow({ where: { id: user.id } })).toMatchObject({
          mfaEnabledAt: user.mfaEnabledAt,
          mfaSecretReferenceId: user.mfaSecretReferenceId,
        });
        expect(await prisma.secretStore.findMany()).toEqual([storedSecret]);
        expect(await prisma.mfaBackupCode.findMany({ where: { userId: user.id } })).toEqual(
          user.backupCodes
        );
        expect(await prisma.secretReference.count()).toBe(1);
      }

      expect(await service.verifyTotpForLogin(user.id, await createOTP(secret).totp())).toEqual({
        success: true,
      });
      expect(await service.verifyRecoveryCodeForLogin(user.id, recoveryCode)).toEqual({
        success: true,
      });
    }
  );

  // Catches: setup confirmation leaks the enabled secret on an invalid-code retry.
  mfaTest(
    "does not disclose an enabled factor through setup validation",
    async ({ prisma, service }) => {
      const user = await createEnabledUser(prisma);
      expect(await service.validateTotpSetup(user.id, "abcdef")).toEqual({ success: false });
      expect(await prisma.mfaBackupCode.findMany({ where: { userId: user.id } })).toEqual(
        user.backupCodes
      );
      expect(await service.verifyTotpForLogin(user.id, await createOTP(secret).totp())).toEqual({
        success: true,
      });
    }
  );

  // Catches: failed confirmation discloses a factor enabled after the user was read.
  mfaTest(
    "does not disclose a factor enabled during a failed confirmation",
    async ({ prisma, service, redisOptions }) => {
      const user = await prisma.user.create({
        data: { email: "concurrent-mfa@example.com", authenticationMethod: "MAGIC_LINK" },
      });
      const setup = await service.enableTotp(user.id);
      const rawSecret = new TextDecoder().decode(base32.decode(setup.secret));
      const validCode = await createOTP(rawSecret).totp();
      const client = prisma.$extends({
        query: {
          user: {
            async findFirst({ args, query }) {
              const snapshot = await query(args);
              expect((await service.validateTotpSetup(user.id, validCode)).success).toBe(true);
              return snapshot;
            },
          },
        },
      });
      const concurrentService = new MultiFactorAuthenticationService(
        client as unknown as PrismaClient,
        createMfaRateLimiters({ redisOptions: { ...redisOptions, tlsDisabled: true } })
      );

      expect(await concurrentService.validateTotpSetup(user.id, "abcdef")).toEqual({
        success: false,
      });
      expect(
        (await prisma.user.findFirstOrThrow({ where: { id: user.id } })).mfaEnabledAt
      ).not.toBeNull();
    }
  );

  for (const method of ["totp", "recovery"] as const) {
    // Catches: authorized replacement leaves the old secret or recovery codes usable.
    mfaTest(
      `replaces the factor with valid current ${method} proof`,
      async ({ prisma, service }) => {
        const user = await createEnabledUser(prisma);
        const proof =
          method === "totp" ? { totpCode: await createOTP(secret).totp() } : { recoveryCode };
        const setup = await service.enableTotp(user.id, proof);

        const updated = await prisma.user.findFirstOrThrow({
          where: { id: user.id },
          include: { mfaSecretReference: true },
        });
        expect(updated.mfaEnabledAt).toEqual(user.mfaEnabledAt);
        expect(updated.mfaSecretReferenceId).not.toBe(user.mfaSecretReferenceId);
        expect(await prisma.secretStore.findFirst({ where: { key: "mfa:existing" } })).toBeNull();
        expect(
          await prisma.secretReference.findFirst({ where: { id: user.mfaSecretReferenceId! } })
        ).toBeNull();
        expect(await service.verifyRecoveryCodeForLogin(user.id, recoveryCode)).toMatchObject({
          success: false,
        });

        const stored = await getSecretStore("DATABASE", { prismaClient: prisma }).getSecret(
          z.object({ secret: z.string() }),
          updated.mfaSecretReference!.key
        );
        const rawSecret = new TextDecoder().decode(base32.decode(setup.secret));
        expect(stored?.secret).toBe(rawSecret);
        expect(stored?.secret).not.toBe(secret);
        const confirmation = await service.validateTotpSetup(
          user.id,
          await createOTP(rawSecret).totp()
        );
        expect(confirmation.success).toBe(true);
        expect(confirmation.recoveryCodes).toHaveLength(9);
        expect(await prisma.mfaBackupCode.count({ where: { userId: user.id } })).toBe(9);
      }
    );
  }

  // Catches: a previously consumed recovery code can authorize replacement.
  mfaTest(
    "rejects a used recovery code without changing the factor",
    async ({ prisma, service }) => {
      const user = await createEnabledUser(prisma);
      await prisma.mfaBackupCode.update({
        where: { id: user.backupCodes[0].id },
        data: { usedAt: new Date() },
      });
      await expect(service.enableTotp(user.id, { recoveryCode })).rejects.toBeInstanceOf(
        ServiceValidationError
      );
      expect(
        (await prisma.user.findFirstOrThrow({ where: { id: user.id } })).mfaSecretReferenceId
      ).toBe(user.mfaSecretReferenceId);
      expect(await service.verifyTotpForLogin(user.id, await createOTP(secret).totp())).toEqual({
        success: true,
      });
    }
  );
});
