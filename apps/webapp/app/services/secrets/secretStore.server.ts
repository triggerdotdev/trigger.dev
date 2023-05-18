import { prisma } from "~/db.server";
import { z } from "zod";

export interface ASecretStore {
  getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined>;
  setSecret<T extends object>(key: string, value: T): Promise<void>;
}

export const SecretStoreProviderSchema = z.union([
  z.literal("aws_param_store"),
  z.literal("database"),
]);
export type SecretStoreProvider = z.infer<typeof SecretStoreProviderSchema>;

/** The SecretStore will use the passed in provider. We do NOT recommend using "database" outside of localhost. */
export class SecretStore implements ASecretStore {
  #provider: ASecretStore;

  constructor(private provider: SecretStoreProvider) {
    switch (provider) {
      case "aws_param_store":
        throw new Error("Not implemented");
      case "database":
        this.#provider = new DatabaseSecretStore();
        break;
      default:
        throw new Error("Invalid provider");
    }
  }

  getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined> {
    return this.#provider.getSecret(schema, key);
  }

  async getSecretOrThrow<T>(schema: z.Schema<T>, key: string): Promise<T> {
    const value = await this.getSecret(schema, key);

    if (!value) {
      throw new Error(`Unable to find secret ${key} in ${this.provider}`);
    }

    return value;
  }

  setSecret<T extends object>(key: string, value: T): Promise<void> {
    return this.#provider.setSecret(key, value);
  }
}

/** This stores secrets in the Postgres Database, in plain text. NOT recommended outside of localhost. */
class DatabaseSecretStore implements ASecretStore {
  async getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined> {
    const secret = await prisma.secretStore.findUnique({
      where: {
        key,
      },
    });

    if (!secret) {
      return undefined;
    }

    return schema.parse(secret.value);
  }

  async setSecret<T extends object>(key: string, value: T): Promise<void> {
    await prisma.secretStore.upsert({
      create: {
        key,
        value,
      },
      update: {
        value,
      },
      where: {
        key,
      },
    });
  }
}
