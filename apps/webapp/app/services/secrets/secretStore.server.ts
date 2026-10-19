import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { z } from "zod";
import { env } from "~/env.server";
import nodeCrypto from "node:crypto";
import { safeJsonParse } from "~/utils/json";
import { logger } from "../logger.server";
import type { SecretStoreOptions } from "./secretStoreOptionsSchema.server";

import { boundedIn } from "@trigger.dev/database";
type ProviderInitializationOptions = {
  DATABASE: {
    prismaClient?: PrismaClientOrTransaction;
  };
  AWS_KMS: {
    prismaClient?: PrismaClientOrTransaction;
  };
  AWS_PARAM_STORE: {
    region: string;
  };
};

export interface SecretStoreProvider {
  getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined>;
  getSecrets<T>(schema: z.Schema<T>, keyPrefix: string): Promise<{ key: string; value: T }[]>;
  getSecretsByKeys<T>(schema: z.Schema<T>, keys: string[]): Promise<{ key: string; value: T }[]>;
  setSecret<T extends object>(key: string, value: T): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

/** The SecretStore will use the passed in provider. */
export class SecretStore {
  constructor(private provider: SecretStoreProvider) {}

  getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined> {
    return this.provider.getSecret(schema, key);
  }

  async getSecretOrThrow<T>(schema: z.Schema<T>, key: string): Promise<T> {
    const value = await this.getSecret(schema, key);

    if (!value) {
      throw new Error(`Unable to find secret ${key} in ${this.provider}`);
    }

    return value;
  }

  setSecret<T extends object>(key: string, value: T): Promise<void> {
    return this.provider.setSecret(key, value);
  }

  getSecrets<T>(schema: z.Schema<T>, keyPrefix: string): Promise<{ key: string; value: T }[]> {
    return this.provider.getSecrets(schema, keyPrefix);
  }

  getSecretsByKeys<T>(schema: z.Schema<T>, keys: string[]): Promise<{ key: string; value: T }[]> {
    return this.provider.getSecretsByKeys(schema, keys);
  }

  deleteSecret(key: string): Promise<void> {
    return this.provider.deleteSecret(key);
  }
}

export const EncryptedSecretValueSchema = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

export type EncryptedSecretValue = z.infer<typeof EncryptedSecretValueSchema>;

const AWS_KMS_SECRET_VERSION = "aws-kms";

const AwsKmsSecretValueSchema = z.object({
  keyId: z.string(),
  ciphertext: z.string(),
});

/**
 * This stores secrets in the Postgres Database, encrypted using aes-256-gcm with ENCRYPTION_KEY,
 * or with an AWS KMS key when `awsKmsKeyId` is set. Reads handle both, based on each row's version.
 */
class PrismaSecretStore implements SecretStoreProvider {
  #prismaClient: PrismaClientOrTransaction;

  constructor(
    private readonly encryptionKey: string,
    private options?: ProviderInitializationOptions["DATABASE"] & { awsKmsKeyId?: string }
  ) {
    this.#prismaClient = options?.prismaClient ?? prisma;
  }

  async getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined> {
    const secret = await this.#prismaClient.secretStore.findUnique({
      where: {
        key,
      },
    });

    if (!secret) {
      return undefined;
    }

    return this.#parseStoredSecret(schema, secret);
  }

  async getSecrets<T>(
    schema: z.Schema<T>,
    keyPrefix: string
  ): Promise<{ key: string; value: T }[]> {
    const secrets = await this.#prismaClient.secretStore.findMany({
      where: {
        key: {
          startsWith: keyPrefix,
        },
      },
    });

    return this.#parseStoredSecrets(schema, secrets);
  }

  async getSecretsByKeys<T>(
    schema: z.Schema<T>,
    keys: string[]
  ): Promise<{ key: string; value: T }[]> {
    if (keys.length === 0) {
      return [];
    }

    const secrets = await this.#prismaClient.secretStore.findMany({
      where: {
        key: {
          in: boundedIn(keys),
        },
      },
    });

    return this.#parseStoredSecrets(schema, secrets);
  }

  async #parseStoredSecrets<T>(
    schema: z.Schema<T>,
    secrets: Array<{ key: string; value: unknown; version: string }>
  ): Promise<{ key: string; value: T }[]> {
    const results = [] as { key: string; value: T }[];

    for (const secret of secrets) {
      const value = await this.#parseStoredSecret(schema, secret);
      if (value !== undefined) {
        results.push({ key: secret.key, value });
      }
    }

    return results;
  }

  async #parseStoredSecret<T>(
    schema: z.Schema<T>,
    secret: { key: string; value: unknown; version: string }
  ): Promise<T | undefined> {
    if (secret.version === "1") {
      return schema.parse(secret.value);
    }

    if (secret.version === AWS_KMS_SECRET_VERSION) {
      const kmsValue = AwsKmsSecretValueSchema.parse(secret.value);
      return schema.parse(JSON.parse(await decryptWithAwsKms(secret.key, kmsValue)));
    }

    const encryptedData = EncryptedSecretValueSchema.safeParse(secret.value);

    if (!encryptedData.success) {
      throw new Error(
        `Unable to parse encrypted secret ${secret.key}: ${encryptedData.error.message}`
      );
    }

    const decrypted = await this.#decrypt(
      encryptedData.data.nonce,
      encryptedData.data.ciphertext,
      encryptedData.data.tag
    );

    const parsedDecrypted = safeJsonParse(decrypted);

    if (!parsedDecrypted) {
      logger.error(`Secret isn't JSON ${secret.key}`);
      return undefined;
    }

    return schema.parse(parsedDecrypted);
  }

  async setSecret<T extends object>(key: string, value: T): Promise<void> {
    const plaintext = JSON.stringify(value);
    const awsKmsKeyId = this.options?.awsKmsKeyId;
    const encrypted = awsKmsKeyId
      ? await encryptWithAwsKms(awsKmsKeyId, key, plaintext)
      : await this.#encrypt(plaintext);
    const version = awsKmsKeyId ? AWS_KMS_SECRET_VERSION : "2";

    await this.#prismaClient.secretStore.upsert({
      create: {
        key,
        value: encrypted,
        version,
      },
      update: {
        value: encrypted,
        version,
      },
      where: {
        key,
      },
    });
  }

  async deleteSecret(key: string): Promise<void> {
    await this.#prismaClient.secretStore.delete({
      where: {
        key,
      },
    });
  }

  async #decrypt(nonce: string, ciphertext: string, tag: string): Promise<string> {
    return await decryptSecret(this.encryptionKey, {
      nonce,
      ciphertext,
      tag,
    });
  }

  async #encrypt(value: string): Promise<{
    nonce: string;
    ciphertext: string;
    tag: string;
  }> {
    return await encryptSecret(this.encryptionKey, value);
  }
}

export function getSecretStore<
  K extends SecretStoreOptions,
  TOptions extends ProviderInitializationOptions[K],
>(provider: K, options?: TOptions): SecretStore {
  switch (provider) {
    case "DATABASE": {
      return new SecretStore(
        new PrismaSecretStore(
          env.ENCRYPTION_KEY,
          options as ProviderInitializationOptions["DATABASE"]
        )
      );
    }
    case "AWS_KMS": {
      if (!env.SECRET_STORE_AWS_KMS_KEY_ID) {
        throw new Error("The AWS_KMS secret store requires SECRET_STORE_AWS_KMS_KEY_ID");
      }
      return new SecretStore(
        new PrismaSecretStore(env.ENCRYPTION_KEY, {
          ...(options as ProviderInitializationOptions["AWS_KMS"]),
          awsKmsKeyId: env.SECRET_STORE_AWS_KMS_KEY_ID,
        })
      );
    }
    default: {
      throw new Error(`Unsupported secret store option ${provider}`);
    }
  }
}

export function isAwsKmsSecretStoreEnabled(): boolean {
  return !!env.SECRET_STORE_AWS_KMS_KEY_ID;
}

let awsKmsClient: KMSClient | undefined;

function getAwsKmsClient(): KMSClient {
  awsKmsClient ??= new KMSClient({ region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION });
  return awsKmsClient;
}

// The encryption context binds each ciphertext to its SecretStore key, so a blob copied to
// another row fails to decrypt.
async function encryptWithAwsKms(
  keyId: string,
  secretKey: string,
  plaintext: string
): Promise<z.infer<typeof AwsKmsSecretValueSchema>> {
  const result = await getAwsKmsClient().send(
    new EncryptCommand({
      KeyId: keyId,
      Plaintext: Buffer.from(plaintext, "utf8"),
      EncryptionContext: { secretKey },
    })
  );
  if (!result.CiphertextBlob || !result.KeyId) {
    throw new Error("AWS KMS encrypt returned no ciphertext");
  }

  // Store the resolved key ARN so existing secrets still decrypt if the configured key changes.
  return {
    keyId: result.KeyId,
    ciphertext: Buffer.from(result.CiphertextBlob).toString("base64"),
  };
}

async function decryptWithAwsKms(
  secretKey: string,
  value: z.infer<typeof AwsKmsSecretValueSchema>
): Promise<string> {
  const result = await getAwsKmsClient().send(
    new DecryptCommand({
      KeyId: value.keyId,
      CiphertextBlob: Buffer.from(value.ciphertext, "base64"),
      EncryptionContext: { secretKey },
    })
  );
  if (!result.Plaintext) {
    throw new Error("AWS KMS decrypt returned no plaintext");
  }

  return Buffer.from(result.Plaintext).toString("utf8");
}

export async function decryptSecret(
  encryptionKey: string,
  secret: EncryptedSecretValue
): Promise<string> {
  const decipher = nodeCrypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(secret.nonce, "hex")
  );

  decipher.setAuthTag(Buffer.from(secret.tag, "hex"));

  let decrypted = decipher.update(secret.ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export async function encryptSecret(
  encryptionKey: string,
  value: string
): Promise<EncryptedSecretValue> {
  const nonce = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);

  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag().toString("hex");

  return {
    nonce: nonce.toString("hex"),
    ciphertext: encrypted,
    tag,
  };
}
