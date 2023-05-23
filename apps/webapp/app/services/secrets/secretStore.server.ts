import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { z } from "zod";

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
}

/** This stores secrets in the Postgres Database, in plain text. NOT recommended outside of localhost. */
class PrismaSecretStore implements SecretStoreProvider {
  #prismaClient: PrismaClientOrTransaction;

  constructor(private options?: ProviderInitializationOptions["DATABASE"]) {
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

    return schema.parse(secret.value);
  }

  async setSecret<T extends object>(key: string, value: T): Promise<void> {
    await this.#prismaClient.secretStore.upsert({
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

export function getSecretStore<
  K extends SecretStoreOptions,
  TOptions extends ProviderInitializationOptions[K]
>(provider: K, options?: TOptions): SecretStore {
  switch (provider) {
    case "DATABASE": {
      return new SecretStore(new PrismaSecretStore(options as any));
    }
    default: {
      throw new Error(`Unsupported secret store option ${provider}`);
    }
  }
}
