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

export type EnvironmentMigrationProgress = {
  scanned: number;
  rewritten: number;
  conflicts: number;
  remaining: number;
  runtimeValues: number;
  buildEnvelopes: number;
  stopped: boolean;
};

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
  onProgress?: (progress: EnvironmentMigrationProgress) => void | Promise<void>;
  shouldContinue?: () => Promise<boolean>;
}) {
  const { db, encryption, projectId, environmentId } = options;
  const batchSize = options.batchSize ?? 100;
  const pauseMs = options.pauseMs ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
    throw new Error("Invalid migration batch size");
  const progress: EnvironmentMigrationProgress = {
    scanned: 0,
    rewritten: 0,
    conflicts: 0,
    remaining: 0,
    runtimeValues: 0,
    buildEnvelopes: 0,
    stopped: false,
  };
  const scope = { projectId, environmentId };
  // Validate ownership even for empty environments or entirely legacy values.
  await encryption.policies([scope], true);
  async function continueScanning() {
    if (options.shouldContinue && !(await options.shouldContinue())) {
      progress.stopped = true;
      return false;
    }
    return true;
  }
  async function activeKeyId() {
    return (await encryption.policies([scope], true)).get(environmentId)!.policy?.activeKeyId;
  }
  let cursor: string | undefined;
  const prefix = environmentSecretPrefix(projectId, environmentId);
  const prefixEnd = environmentSecretPrefixEnd(projectId, environmentId);
  // Every pass verifies decryption, including values already naming the active key.
  while (true) {
    if (!(await continueScanning())) return progress;
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
    const targetKeyId = prepared?.keyId ?? (await activeKeyId());
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
      progress.runtimeValues++;
      if (targetKeyId && encryptedWithKey(row.value, targetKeyId)) continue;
      if (!prepared) {
        progress.remaining++;
        continue;
      }
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
      else {
        progress.conflicts++;
        progress.remaining++;
      }
    }
    cursor = rows[rows.length - 1]!.key;
    await options.onProgress?.({ ...progress });
    await sleep(pauseMs);
  }
  cursor = undefined;
  while (true) {
    if (!(await continueScanning())) return progress;
    // The existing (environmentId, version) unique index bounds deployment paging.
    const rows: Array<Pick<WorkerDeployment, "id" | "version" | "buildEnvVars">> =
      await db.workerDeployment.findMany({
        where: {
          projectId,
          environmentId,
          buildEnvVars: { not: Prisma.DbNull },
          ...(cursor ? { version: { gt: cursor } } : {}),
        },
        select: { id: true, version: true, buildEnvVars: true },
        orderBy: { version: "asc" },
        take: batchSize,
      });
    if (!rows.length) break;
    const prepared = options.apply
      ? await encryption.prepareWrite({ projectId, environmentId })
      : undefined;
    if (prepared && !prepared.keyId)
      throw new Error("Enable environment encryption before migration");
    const targetKeyId = prepared?.keyId ?? (await activeKeyId());
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
      progress.buildEnvelopes++;
      if (targetKeyId && encryptedWithKey(row.buildEnvVars, targetKeyId)) continue;
      if (!prepared) {
        progress.remaining++;
        continue;
      }
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
      else {
        progress.conflicts++;
        progress.remaining++;
      }
    }
    cursor = rows[rows.length - 1]!.version;
    await options.onProgress?.({ ...progress });
    await sleep(pauseMs);
  }
  return progress;
}
