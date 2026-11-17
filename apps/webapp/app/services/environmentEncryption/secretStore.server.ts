import { boundedIn, Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import type { z } from "zod";
import { logger } from "~/services/logger.server";
import { recordSecretProxyFailure } from "../secretProxy/telemetry.server";
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

export async function protectedSecretKeys(
  db: PrismaClientOrTransaction,
  projectId: string,
  environmentIds: string[]
): Promise<Set<string>> {
  if (!environmentIds.length) return new Set();
  const policies = await db
    .$queryRaw<Array<{ environmentId: string; key: string }>>(Prisma.sql`
    WITH environments AS (
      SELECT id, "parentEnvironmentId"
      FROM "RuntimeEnvironment"
      WHERE id = ANY(${[...new Set(environmentIds)]}::text[]) AND "projectId" = ${projectId}
    )
    SELECT e.id AS "environmentId", v.key
    FROM environments e
    JOIN "EnvironmentVariableValue" value ON value."environmentId" = e.id
    JOIN "EnvironmentVariable" v ON v.id = value."variableId"
    WHERE value."isProxyOnly" = true AND v."projectId" = ${projectId}
    UNION ALL
    SELECT e.id AS "environmentId", v.key
    FROM environments e
    JOIN "EnvironmentVariableValue" value ON value."environmentId" = e."parentEnvironmentId"
    JOIN "EnvironmentVariable" v ON v.id = value."variableId"
    WHERE value."isProxyOnly" = true AND v."projectId" = ${projectId}
  `)
    .catch((error: unknown) => {
      recordSecretProxyFailure("metadata", "dependency");
      throw error;
    });
  return new Set(
    policies.map(
      (policy) => `${environmentSecretPrefix(projectId, policy.environmentId)}${policy.key}`
    )
  );
}

/**
 * The stored rows for these keys, in no particular order; a missing key has no row. A raw query
 * with the JSON value as text, parsed here. Through the pg driver adapter it costs about a third
 * of Prisma's `findMany` for the same rows; without the adapter it costs more, so the store only
 * uses it on a client that reads through the adapter.
 */
export async function readSecretStoreRows(
  db: PrismaClientOrTransaction,
  keys: string[]
): Promise<Array<{ key: string; value: unknown; version: string }>> {
  if (!keys.length) return [];
  const rows = await db.$queryRaw<Array<{ key: string; value: string; version: string }>>`
    SELECT key, value::text AS value, version FROM "SecretStore" WHERE key = ANY(${keys}::text[])
  `;
  return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value), version: row.version }));
}

export class EnvironmentSecretStore {
  readonly #prefixes: Array<{ environmentId: string; prefix: string }>;
  constructor(
    private readonly db: PrismaClientOrTransaction,
    private readonly encryption: EnvironmentEncryptionService,
    private readonly projectId: string,
    environmentIds: string[],
    private readonly prepared = new Map<string, PreparedEnvironmentWrite>(),
    private readonly protectedKeys?: ReadonlySet<string>,
    /** Whether `db` reads through the pg driver adapter: bulk reads then use the raw query. */
    private readonly rawReads = false
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
    if (!rows.length) return [];
    const protectedKeys =
      this.protectedKeys ??
      (await protectedSecretKeys(
        this.db,
        this.projectId,
        this.#prefixes.map((owner) => owner.environmentId)
      ));
    rows = rows.filter((row) => !protectedKeys.has(row.key));
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
    const rows = this.rawReads
      ? await readSecretStoreRows(this.db, keys)
      : await this.db.secretStore.findMany({ where: { key: { in: boundedIn(keys) } } });
    return this.#parse(schema, rows);
  }

  async setSecret<T extends object>(key: string, value: T) {
    const context = this.#context(key);
    const protectedKeys =
      this.protectedKeys ??
      (await protectedSecretKeys(this.db, this.projectId, [context.environmentId]));
    if (protectedKeys.has(key)) {
      recordSecretProxyFailure("guard", "policy");
      throw new Error("Proxy-only variables require operator changes");
    }
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
    const context = this.#context(key);
    const protectedKeys =
      this.protectedKeys ??
      (await protectedSecretKeys(this.db, this.projectId, [context.environmentId]));
    if (protectedKeys.has(key)) {
      recordSecretProxyFailure("guard", "policy");
      throw new Error("Proxy-only variables require operator changes");
    }
    await this.db.secretStore.delete({ where: { key } });
  }
}
