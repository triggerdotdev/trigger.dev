import { boundedIn, type PrismaClientOrTransaction } from "@trigger.dev/database";
import type { z } from "zod";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";
import { ENVIRONMENT_SECRET_VERSION } from "./crypto.server";
import type { EnvironmentEncryptionService, PreparedEnvironmentWrite } from "./service.server";

export { ENVIRONMENT_SECRET_VERSION } from "./crypto.server";
export function environmentSecretPrefix(projectId: string, environmentId: string) {
  return `environmentvariable:${projectId}:${environmentId}:`;
}

export function environmentSecretPrefixEnd(projectId: string, environmentId: string) {
  // The prefix ends in ":"; ";" is its exclusive upper bound under byte ordering.
  return `${environmentSecretPrefix(projectId, environmentId).slice(0, -1)};`;
}

export class EnvironmentSecretStore {
  readonly #prefixes: Array<{ environmentId: string; prefix: string }>;
  constructor(
    private readonly db: PrismaClientOrTransaction,
    private readonly encryption: EnvironmentEncryptionService,
    private readonly projectId: string,
    environmentIds: string[],
    private readonly prepared = new Map<string, PreparedEnvironmentWrite>()
  ) {
    this.#prefixes = [...new Set(environmentIds)].map((environmentId) => ({
      environmentId,
      prefix: environmentSecretPrefix(projectId, environmentId),
    }));
  }

  #context(key: string) {
    const owner = this.#prefixes.find(({ prefix }) => key.startsWith(prefix));
    if (!owner) throw new Error("Secret is outside the authorized environment scope");
    return {
      environmentId: owner.environmentId,
      purpose: "environment-variable" as const,
      objectId: key,
    };
  }

  async #parse<T>(
    schema: z.Schema<T>,
    rows: Array<{ key: string; value: unknown; version: string }>
  ) {
    const values = await this.encryption.decryptMany(
      rows.map((row) => ({
        projectId: this.projectId,
        context: this.#context(row.key),
        value: row.value,
        version: row.version,
      })),
      this.db
    );
    return rows.flatMap((row, i) => {
      const parsed = safeJsonParse(values[i]!);
      if (!parsed && row.version !== "1") {
        logger.error("Secret isn\u2019t JSON", { key: row.key });
        return [];
      }
      return [{ key: row.key, value: schema.parse(parsed) }];
    });
  }

  async getSecrets<T>(schema: z.Schema<T>, prefix: string) {
    if (
      !this.#prefixes.some((owner) => prefix.startsWith(owner.prefix)) &&
      prefix !== `environmentvariable:${this.projectId}:`
    ) {
      throw new Error("Invalid environment secret prefix");
    }
    if (!this.#prefixes.length) return [];
    const rows = await this.db.secretStore.findMany({
      where: { key: { startsWith: prefix } },
    });
    return this.#parse(schema, rows);
  }

  async getSecretsByKeys<T>(schema: z.Schema<T>, keys: string[]) {
    if (!keys.length) return [];
    keys.forEach((key) => this.#context(key));
    const rows = await this.db.secretStore.findMany({ where: { key: { in: boundedIn(keys) } } });
    return this.#parse(schema, rows);
  }

  async setSecret<T extends object>(key: string, value: T) {
    const context = this.#context(key);
    const prepared = this.prepared.get(context.environmentId);
    if (!prepared)
      throw new Error("Environment encryption must be prepared before starting a transaction");
    const encrypted = this.encryption.encrypt(prepared, context, JSON.stringify(value));
    const version = encrypted.scheme ? ENVIRONMENT_SECRET_VERSION : "2";
    await this.db.secretStore.upsert({
      where: { key },
      create: { key, value: encrypted, version },
      update: { value: encrypted, version },
    });
  }

  async deleteSecret(key: string) {
    this.#context(key);
    await this.db.secretStore.delete({ where: { key } });
  }
}
