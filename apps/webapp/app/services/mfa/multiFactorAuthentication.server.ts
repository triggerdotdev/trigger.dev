import { type SecretReference, type User, type PrismaClient } from "@trigger.dev/database";
import { $transaction, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { createRandomStringGenerator } from "@better-auth/utils/random";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { createHash } from "@better-auth/utils/hash";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { z } from "zod";
import { scheduleEmail } from "../scheduleEmail.server";
import { checkMfaRateLimit } from "./mfaRateLimiterGlobal.server";
import type { MfaRateLimiters } from "./mfaRateLimiter.server";

const generateRandomString = createRandomStringGenerator("A-Z", "0-9");

const SecretSchema = z.object({
  secret: z.string(),
});

export class MultiFactorAuthenticationService {
  #prismaClient: PrismaClient;

  constructor(
    prismaClient: PrismaClient = prisma,
    private readonly rateLimiters?: MfaRateLimiters
  ) {
    this.#prismaClient = prismaClient;
  }

  public async disableTotp(userId: string, params: { totpCode?: string; recoveryCode?: string }) {
    const user = await this.#prismaClient.user.findFirst({
      where: { id: userId },
      include: {
        mfaSecretReference: true,
      },
    });

    if (!user) {
      return {
        success: false,
      };
    }

    if (!user.mfaEnabledAt) {
      return {
        success: false,
      };
    }

    if (!user.mfaSecretReference) {
      return {
        success: false,
      };
    }

    // Rate limit before checking the code: disabling MFA asks for the second
    // factor, so unlimited attempts here would let a hijacked session
    // brute-force it. Same limiter as the login verify path.
    await checkMfaRateLimit(userId, this.rateLimiters);

    // validate the TOTP code
    const secretStore = getSecretStore(user.mfaSecretReference.provider, {
      prismaClient: this.#prismaClient,
    });
    const secretResult = await secretStore.getSecret(SecretSchema, user.mfaSecretReference.key);

    if (!secretResult) {
      return {
        success: false,
      };
    }

    const isValid = await this.#verifyTotpCodeOrRecoveryCode(
      user,
      user.mfaSecretReference,
      params.totpCode,
      params.recoveryCode
    );

    if (!isValid) {
      return {
        success: false,
      };
    }

    // Delete the MFA secret
    await secretStore.deleteSecret(user.mfaSecretReference.key);

    // Delete the MFA backup codes
    await this.#prismaClient.mfaBackupCode.deleteMany({
      where: {
        userId,
      },
    });

    await this.#prismaClient.user.update({
      where: { id: userId },
      data: {
        mfaEnabledAt: null,
        mfaSecretReference: {
          delete: true,
        },
      },
    });

    await scheduleEmail({
      email: "mfa-disabled",
      to: user.email,
      userEmail: user.email,
    });

    return {
      success: true,
    };
  }

  public async enableTotp(
    userId: string,
    params: { totpCode?: string; recoveryCode?: string } = {}
  ) {
    const result = await $transaction(
      this.#prismaClient,
      "enableTotp",
      async (tx) => {
        const user = await tx.user.findFirst({
          where: { id: userId },
          include: { mfaSecretReference: true },
        });

        if (!user) {
          throw new ServiceValidationError("User not found");
        }

        if (user.mfaEnabledAt) {
          await checkMfaRateLimit(userId, this.rateLimiters);

          if (
            !user.mfaSecretReference ||
            !(await this.#verifyTotpCodeOrRecoveryCode(
              user,
              user.mfaSecretReference,
              params.totpCode,
              params.recoveryCode,
              tx
            ))
          ) {
            throw new ServiceValidationError("Invalid code provided. Please try again.");
          }
        }

        const secretStore = getSecretStore("DATABASE", { prismaClient: tx });
        const secret = generateRandomString(24);
        const secretKey = `mfa:${userId}:${generateRandomString(8)}`;

        await secretStore.setSecret(secretKey, { secret });

        await tx.user.update({
          where: { id: userId },
          data: {
            mfaLastUsedCode: null,
            mfaSecretReference: {
              create: { provider: "DATABASE", key: secretKey },
            },
          },
        });

        // Retire the previous factor and all its recovery codes atomically.
        if (user.mfaSecretReference) {
          await getSecretStore(user.mfaSecretReference.provider, {
            prismaClient: tx,
          }).deleteSecret(user.mfaSecretReference.key);
          await tx.secretReference.delete({ where: { id: user.mfaSecretReference.id } });
        }

        if (user.mfaEnabledAt) {
          await tx.mfaBackupCode.deleteMany({ where: { userId } });
        }

        return {
          secret: base32.encode(secret, { padding: false }),
          otpAuthUrl: createOTP(secret).url("trigger.dev", user.email),
        };
      },
      { isolationLevel: "Serializable" }
    );

    if (!result) {
      throw new ServiceValidationError("Unable to set up MFA");
    }

    return result;
  }

  public async validateTotpSetup(userId: string, totpCode: string) {
    const user = await this.#prismaClient.user.findFirst({
      where: { id: userId },
      include: {
        mfaSecretReference: true,
      },
    });

    if (!user) {
      throw new ServiceValidationError("User not found");
    }

    if (!user.mfaSecretReference) {
      throw new ServiceValidationError("User has not enabled MFA");
    }

    const secretStore = getSecretStore(user.mfaSecretReference.provider, {
      prismaClient: this.#prismaClient,
    });
    const secretResult = await secretStore.getSecret(SecretSchema, user.mfaSecretReference.key);

    if (!secretResult) {
      throw new ServiceValidationError("User has not enabled MFA");
    }

    // Rate limit enrollment confirmation too: it verifies a TOTP code against
    // a real secret, so it needs the same brute-force protection as the
    // disable and login verify paths.
    await checkMfaRateLimit(userId, this.rateLimiters);

    const secret = secretResult.secret;

    const otp = createOTP(secret, {
      digits: 6,
      period: 30,
    });

    const isValid = await otp.verify(totpCode);

    if (!isValid) {
      return { success: false };
    }

    const recoveryCodes = Array.from({ length: 9 }, () => generateRandomString(16, "a-z", "0-9"));

    await $transaction(this.#prismaClient, "validateTotpSetup", async (tx) => {
      // Only activate the secret we verified, not a concurrent replacement.
      await tx.user.update({
        where: { id: userId, mfaSecretReferenceId: user.mfaSecretReferenceId },
        data: { mfaEnabledAt: new Date() },
      });

      await tx.mfaBackupCode.deleteMany({ where: { userId } });

      for (const code of recoveryCodes) {
        const hashedCode = await createHash("SHA-512", "hex").digest(code);
        await tx.mfaBackupCode.create({
          data: { userId, code: hashedCode },
        });
      }
    });

    await scheduleEmail({
      email: "mfa-enabled",
      to: user.email,
      userEmail: user.email,
    });

    return {
      success: true,
      recoveryCodes,
    };
  }

  async #verifyTotpCodeOrRecoveryCode(
    user: User,
    secretReference: SecretReference,
    totpCode?: string,
    recoveryCode?: string,
    prismaClient: PrismaClientOrTransaction = this.#prismaClient
  ) {
    if (!totpCode && !recoveryCode) {
      return false;
    }

    if (typeof totpCode === "string" && totpCode.length === 6) {
      return this.#verifyTotpCode(user, secretReference, totpCode, prismaClient);
    }

    if (typeof recoveryCode === "string") {
      return this.#verifyRecoveryCode(user, recoveryCode, prismaClient);
    }

    return false;
  }

  async #verifyTotpCode(
    user: User,
    secretReference: SecretReference,
    totpCode: string,
    prismaClient: PrismaClientOrTransaction = this.#prismaClient
  ) {
    const secretStore = getSecretStore(secretReference.provider, { prismaClient });
    const secretResult = await secretStore.getSecret(SecretSchema, secretReference.key);

    if (!secretResult) {
      return false;
    }

    const secret = secretResult.secret;

    const isValid = await createOTP(secret, {
      digits: 6,
      period: 30,
    }).verify(totpCode);

    return isValid;
  }

  async #verifyRecoveryCode(
    user: User,
    recoveryCode: string,
    prismaClient: PrismaClientOrTransaction = this.#prismaClient
  ) {
    const hashedCode = await createHash("SHA-512", "hex").digest(recoveryCode);

    const backupCode = await prismaClient.mfaBackupCode.findFirst({
      where: { userId: user.id, code: hashedCode, usedAt: null },
    });

    return !!backupCode;
  }

  // Public methods for login flow with security measures
  public async verifyTotpForLogin(userId: string, totpCode: string) {
    const user = await this.#prismaClient.user.findFirst({
      where: { id: userId },
      include: {
        mfaSecretReference: true,
      },
    });

    if (!user || !user.mfaEnabledAt || !user.mfaSecretReference) {
      return {
        success: false,
        error: "Invalid authentication code",
      };
    }

    // Check for replay attack - if this code was already used
    const hashedCode = await createHash("SHA-512", "hex").digest(totpCode);
    if (user.mfaLastUsedCode === hashedCode) {
      return {
        success: false,
        error: "Invalid authentication code",
      };
    }

    // Verify the TOTP code
    const isValid = await this.#verifyTotpCode(user, user.mfaSecretReference, totpCode);

    if (!isValid) {
      return {
        success: false,
        error: "Invalid authentication code",
      };
    }

    // Mark this code as used to prevent replay
    await this.#prismaClient.user.update({
      where: { id: userId },
      data: {
        mfaLastUsedCode: hashedCode,
      },
    });

    return {
      success: true,
    };
  }

  public async verifyRecoveryCodeForLogin(userId: string, recoveryCode: string) {
    const user = await this.#prismaClient.user.findFirst({
      where: { id: userId },
    });

    if (!user || !user.mfaEnabledAt) {
      return {
        success: false,
        error: "Invalid authentication code",
      };
    }

    const hashedCode = await createHash("SHA-512", "hex").digest(recoveryCode);

    // Find an unused recovery code
    const backupCode = await this.#prismaClient.mfaBackupCode.findFirst({
      where: {
        userId: user.id,
        code: hashedCode,
        usedAt: null,
      },
    });

    if (!backupCode) {
      return {
        success: false,
        error: "Invalid authentication code",
      };
    }

    // Mark this recovery code as used
    await this.#prismaClient.mfaBackupCode.update({
      where: { id: backupCode.id },
      data: {
        usedAt: new Date(),
      },
    });

    return {
      success: true,
    };
  }
}
