import { SecretReference, User, type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { createRandomStringGenerator } from "@better-auth/utils/random";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { createHash } from "@better-auth/utils/hash";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { z } from "zod";

const generateRandomString = createRandomStringGenerator("A-Z", "0-9");

const SecretSchema = z.object({
  secret: z.string(),
});

export class MultiFactorAuthenticationService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
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

    // validate the TOTP code
    const secretStore = getSecretStore(user.mfaSecretReference.provider);
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

    return {
      success: true,
    };
  }

  public async enableTotp(userId: string) {
    const user = await this.#prismaClient.user.findFirst({
      where: { id: userId },
    });

    if (!user) {
      throw new ServiceValidationError("User not found");
    }

    const secretStore = getSecretStore("DATABASE");

    // Generate a new secret
    const secret = generateRandomString(24);
    const secretKey = `mfa:${userId}:${generateRandomString(8)}`;

    // Store the secret in the SecretStore
    await secretStore.setSecret(secretKey, {
      secret,
    });

    // Update the user's secret reference to the secret store
    await this.#prismaClient.user.update({
      where: { id: userId },
      data: {
        mfaSecretReference: {
          create: {
            provider: "DATABASE",
            key: secretKey,
          },
        },
      },
    });

    // Return the secret and the recovery codes
    const otpAuthUrl = createOTP(secret).url("trigger.dev", user.email);

    const displaySecret = base32.encode(secret, {
      padding: false,
    });

    return {
      secret: displaySecret,
      otpAuthUrl,
    };
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

    const secretStore = getSecretStore(user.mfaSecretReference.provider);
    const secretResult = await secretStore.getSecret(SecretSchema, user.mfaSecretReference.key);

    if (!secretResult) {
      throw new ServiceValidationError("User has not enabled MFA");
    }

    const secret = secretResult.secret;

    const otp = createOTP(secret, {
      digits: 6,
      period: 30,
    });

    const isValid = await otp.verify(totpCode);

    if (!isValid) {
      // Return the secret and the recovery codes
      const otpAuthUrl = createOTP(secret).url("trigger.dev", user.email);

      const displaySecret = base32.encode(secret, {
        padding: false,
      });

      return {
        success: false,
        otpAuthUrl,
        secret: displaySecret,
      };
    }

    // Now that we've validated the TOTP code, we can enable MFA for the user
    await this.#prismaClient.user.update({
      where: { id: userId },
      data: {
        mfaEnabledAt: new Date(),
      },
    });

    // Generate a new set of recovery codes
    const recoveryCodes = Array.from({ length: 9 }, () => generateRandomString(16, "a-z", "0-9"));

    // Delete any existing recovery codes
    await this.#prismaClient.mfaBackupCode.deleteMany({
      where: {
        userId,
      },
    });

    // Hash and store the recovery codes
    for (const code of recoveryCodes) {
      const hashedCode = await createHash("SHA-512", "hex").digest(code);
      await this.#prismaClient.mfaBackupCode.create({
        data: {
          userId,
          code: hashedCode,
        },
      });
    }

    return {
      success: true,
      recoveryCodes,
    };
  }

  async #verifyTotpCodeOrRecoveryCode(
    user: User,
    secretReference: SecretReference,
    totpCode?: string,
    recoveryCode?: string
  ) {
    if (!totpCode && !recoveryCode) {
      return false;
    }

    if (typeof totpCode === "string" && totpCode.length === 6) {
      return this.#verifyTotpCode(user, secretReference, totpCode);
    }

    if (typeof recoveryCode === "string") {
      return this.#verifyRecoveryCode(user, recoveryCode);
    }

    return false;
  }

  async #verifyTotpCode(user: User, secretReference: SecretReference, totpCode: string) {
    const secretStore = getSecretStore(secretReference.provider);
    const secretResult = await secretStore.getSecret(SecretSchema, secretReference.key);

    if (!secretResult) {
      return false;
    }

    const secret = secretResult.secret;

    console.log("secret", secret);
    console.log("totpCode", totpCode);

    const isValid = await createOTP(secret, {
      digits: 6,
      period: 30,
    }).verify(totpCode);

    console.log("isValid", isValid);

    return isValid;
  }

  async #verifyRecoveryCode(user: User, recoveryCode: string) {
    const hashedCode = await createHash("SHA-512", "hex").digest(recoveryCode);

    const backupCode = await this.#prismaClient.mfaBackupCode.findFirst({
      where: { userId: user.id, code: hashedCode },
    });

    return !!backupCode;
  }
}

function generateQRCodeUrl({
  issuer,
  account,
  secret,
  digits = 6,
  period = 30,
}: {
  issuer: string;
  account: string;
  secret: string;
  digits?: number;
  period?: number;
}) {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccountName = encodeURIComponent(account);
  const baseURI = `otpauth://totp/${encodedIssuer}:${encodedAccountName}`;
  const params = new URLSearchParams({
    secret,
    issuer,
  });

  if (digits !== undefined) {
    params.set("digits", digits.toString());
  }
  if (period !== undefined) {
    params.set("period", period.toString());
  }
  return `${baseURI}?${params.toString()}`;
}
