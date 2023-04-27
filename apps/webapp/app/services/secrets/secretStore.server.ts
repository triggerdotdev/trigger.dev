import { prisma } from "~/db.server";
import { z } from "zod";

export interface ASecretStore {
  getSecret<TSchema extends z.ZodFirstPartySchemaTypes>(
    schema: TSchema,
    key: string
  ): Promise<z.infer<TSchema> | undefined>;
  setSecret<T extends object>(key: string, value: T): Promise<void>;
}

export const SecretStoreProviderSchema = z.union([
  z.literal("aws_param_store"),
  z.literal("database"),
]);
export type SecretStoreProvider = z.infer<typeof SecretStoreProviderSchema>;

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

  getSecret<TSchema extends z.ZodFirstPartySchemaTypes>(
    schema: TSchema,
    key: string
  ): Promise<z.TypeOf<TSchema> | undefined> {
    return this.#provider.getSecret(schema, key);
  }

  setSecret<T extends object>(key: string, value: T): Promise<void> {
    return this.#provider.setSecret(key, value);
  }
}

class DatabaseSecretStore implements ASecretStore {
  async getSecret<TSchema extends z.ZodFirstPartySchemaTypes>(
    schema: TSchema,
    key: string
  ): Promise<z.TypeOf<TSchema> | undefined> {
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
