import {
  Prisma,
  type PrismaClient,
  type PrismaTransactionClient,
  type WorkerDeployment,
  type SecretStore,
} from "@trigger.dev/database";
import { setTimeout as sleep } from "node:timers/promises";
import { ENVIRONMENT_ENCRYPTION_SCHEME } from "./crypto.server";
import {
  environmentSecretPrefix,
  ENVIRONMENT_SECRET_VERSION,
  environmentSecretPrefixEnd,
} from "./secretStore.server";
import type { EnvironmentEncryptionService } from "./service.server";

function encryptedWithKey(value: Prisma.JsonValue, keyId: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.scheme === ENVIRONMENT_ENCRYPTION_SCHEME &&
    value.keyId === keyId
  );
}

export async function migrateEnvironmentEncryption(options: {
  db: PrismaClient;
  encryption: EnvironmentEncryptionService;
  encryptionTransaction: <T>(
    fn: (tx: PrismaTransactionClient) => Promise<T>
  ) => Promise<T | undefined>;
  projectId: string;
  environmentId: string;
  apply: boolean;
  batchSize?: number;
  pauseMs?: number;
  onProgress?: (progress: { scanned: number; rewritten: number; conflicts: number }) => void;
}) {
  const { db, encryption, projectId, environmentId } = options;
  const batchSize = options.batchSize ?? 100;
  const pauseMs = options.pauseMs ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
    throw new Error("Invalid migration batch size");
  const progress = { scanned: 0, rewritten: 0, conflicts: 0 };
  let cursor: string | undefined;
  const prefix = environmentSecretPrefix(projectId, environmentId);
  const prefixEnd = environmentSecretPrefixEnd(projectId, environmentId);
  // Every pass verifies decryption, including values already naming the active key.
  while (true) {
    // These operators and ordering match the existing text_pattern_ops index, independent of DB collation.
    const rows = await db.$queryRaw<
      Array<Pick<SecretStore, "key" | "value" | "version" | "updatedAt">>
    >`
      SELECT key, value, version, "updatedAt" FROM "SecretStore"
      WHERE key ~>=~ ${prefix} AND key ~<~ ${prefixEnd}
      ${cursor ? Prisma.sql`AND key ~>~ ${cursor}` : Prisma.empty}
      ORDER BY key USING ~<~ LIMIT ${batchSize}
    `;
    if (!rows.length) break;
    const prepared = options.apply
      ? await encryption.prepareWrite({ projectId, environmentId })
      : undefined;
    if (prepared && !prepared.keyId)
      throw new Error("Enable environment encryption before migration");
    const plaintexts = await encryption.decryptMany(
      rows.map((row) => ({
        projectId,
        context: { environmentId, purpose: "environment-variable" as const, objectId: row.key },
        value: row.value,
        version: row.version,
      }))
    );
    for (const [i, row] of rows.entries()) {
      progress.scanned++;
      if (prepared?.keyId && encryptedWithKey(row.value, prepared.keyId)) continue;
      if (!prepared) continue;
      const value = encryption.encrypt(
        prepared,
        { environmentId, purpose: "environment-variable", objectId: row.key },
        plaintexts[i]!
      );
      const result = await options.encryptionTransaction(async (tx) => {
        await encryption.assertWrite(tx, [prepared]);
        return tx.secretStore.updateMany({
          where: {
            key: row.key,
            version: row.version,
            updatedAt: row.updatedAt,
            value: { equals: row.value ?? Prisma.JsonNull },
          },
          data: { value, version: ENVIRONMENT_SECRET_VERSION },
        });
      });
      if (!result) throw new Error("Migration write did not commit");
      if (result.count) progress.rewritten++;
      else progress.conflicts++;
    }
    cursor = rows[rows.length - 1]!.key;
    options.onProgress?.({ ...progress });
    await sleep(pauseMs);
  }
  cursor = undefined;
  while (true) {
    const rows: Array<Pick<WorkerDeployment, "id" | "buildEnvVars">> =
      await db.workerDeployment.findMany({
        where: {
          environmentId,
          buildEnvVars: { not: Prisma.DbNull },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, buildEnvVars: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    if (!rows.length) break;
    const prepared = options.apply
      ? await encryption.prepareWrite({ projectId, environmentId })
      : undefined;
    if (prepared && !prepared.keyId)
      throw new Error("Enable environment encryption before migration");
    const nonNull = rows.filter((row) => row.buildEnvVars !== null);
    const plaintexts = await encryption.decryptMany(
      nonNull.map((row) => ({
        projectId,
        value: row.buildEnvVars,
        context: { environmentId, purpose: "build-env-vars", objectId: row.id },
      }))
    );
    for (const [i, row] of nonNull.entries()) {
      progress.scanned++;
      if (prepared?.keyId && encryptedWithKey(row.buildEnvVars, prepared.keyId)) continue;
      if (!prepared) continue;
      const value = encryption.encrypt(
        prepared,
        { environmentId, purpose: "build-env-vars", objectId: row.id },
        plaintexts[i]!
      );
      const result = await options.encryptionTransaction(async (tx) => {
        await encryption.assertWrite(tx, [prepared]);
        return tx.workerDeployment.updateMany({
          where: {
            id: row.id,
            environmentId,
            buildEnvVars: { equals: row.buildEnvVars! },
          },
          data: { buildEnvVars: value },
        });
      });
      if (!result) throw new Error("Migration write did not commit");
      if (result.count) progress.rewritten++;
      else progress.conflicts++;
    }
    cursor = rows[rows.length - 1]!.id;
    options.onProgress?.({ ...progress });
    await sleep(pauseMs);
  }
  return progress;
}
