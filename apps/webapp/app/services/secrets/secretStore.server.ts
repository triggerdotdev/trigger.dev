import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { z } from "zod";
import { env } from "~/env.server";
import nodeCrypto from "node:crypto";
import { safeJsonParse } from "~/utils/json";
import { logger } from "../logger.server";
import type { SecretStoreOptions } from "./secretStoreOptionsSchema.server";

type ProviderInitializationOptions = {
  DATABASE: {
    prismaClient?: PrismaClientOrTransaction;
  };
  AWS_PARAM_STORE: {
    region: string;
  };
};

export interface SecretStoreProvider {
  getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined>;
  getSecrets<T>(schema: z.Schema<T>, keyPrefix: string): Promise<{ key: string; value: T }[]>;
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

/** This stores secrets in the Postgres Database, encrypted using aes-256-gcm */
class PrismaSecretStore implements SecretStoreProvider {
  #prismaClient: PrismaClientOrTransaction;

  constructor(
    private readonly encryptionKey: string,
    private options?: ProviderInitializationOptions["DATABASE"]
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

    if (secret.version === "1") {
      return schema.parse(secret.value);
    }

    const encryptedData = EncryptedSecretValueSchema.safeParse(secret.value);

    if (!encryptedData.success) {
      throw new Error(`Unable to parse encrypted secret ${key}: ${encryptedData.error.message}`);
    }

    const decrypted = await this.#decrypt(
      encryptedData.data.nonce,
      encryptedData.data.ciphertext,
      encryptedData.data.tag
    );

    const parsedDecrypted = safeJsonParse(decrypted);

    if (!parsedDecrypted) {
      return;
    }

    return schema.parse(parsedDecrypted);
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

    const results = [] as { key: string; value: T }[];

    for (const secret of secrets) {
      if (secret.version === "1") {
        results.push({ key: secret.key, value: schema.parse(secret.value) });
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
        continue;
      }

      results.push({ key: secret.key, value: schema.parse(parsedDecrypted) });
    }

    return results;
  }

  async setSecret<T extends object>(key: string, value: T): Promise<void> {
    const encrypted = await this.#encrypt(JSON.stringify(value));

    await this.#prismaClient.secretStore.upsert({
      create: {
        key,
        value: encrypted,
        version: "2",
      },
      update: {
        value: encrypted,
        version: "2",
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
  TOptions extends ProviderInitializationOptions[K]
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
    default: {
      throw new Error(`Unsupported secret store option ${provider}`);
    }
  }
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
