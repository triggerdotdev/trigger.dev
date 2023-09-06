import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { z } from "zod";
import { env } from "~/env.server";
import nodeCrypto from "node:crypto";
import { safeJsonParse } from "~/utils/json";

export const SecretStoreOptionsSchema = z.enum(["DATABASE", "AWS_PARAM_STORE"]);
export type SecretStoreOptions = z.infer<typeof SecretStoreOptionsSchema>;

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
  setSecret<T extends object>(key: string, value: T): Promise<void>;
  deleteSecret(key: string): Promise<boolean>;
}

/** The SecretStore will use the passed in provider. We do NOT recommend using "DATABASE" outside of localhost. */
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

  deleteSecret<T extends object>(key: string): Promise<boolean> {
    return this.provider.deleteSecret(key);
  }
}

const EncryptedSecretValueSchema = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

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

  async deleteSecret(key: string): Promise<boolean> {
    const result = await this.#prismaClient.secretStore.delete({
      where: {
        key,
      },
    });

    return !!result;
  }

  async #decrypt(nonce: string, ciphertext: string, tag: string): Promise<string> {
    const decipher = nodeCrypto.createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(nonce, "hex")
    );

    decipher.setAuthTag(Buffer.from(tag, "hex"));

    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  async #encrypt(value: string): Promise<{
    nonce: string;
    ciphertext: string;
    tag: string;
  }> {
    const nonce = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", this.encryptionKey, nonce);

    let encrypted = cipher.update(value, "utf8", "hex");
    encrypted += cipher.final("hex");

    const tag = cipher.getAuthTag().toString("hex");

    return {
      nonce: nonce.toString("hex"),
      ciphertext: encrypted,
      tag,
    };
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
