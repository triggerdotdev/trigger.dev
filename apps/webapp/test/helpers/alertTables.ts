import { readFileSync } from "node:fs";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@trigger.dev/database";

const MIGRATION_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../../../internal-packages/database/prisma/migrations/20261019120000_alerts_v1/migration.sql"
  ),
  "utf8"
);

const STATEMENTS = MIGRATION_SQL.split(/\n(?=-- )/)
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

export async function replayAlertsMigration(prisma: PrismaClient): Promise<void> {
  for (const statement of STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
}

export async function applyAlertsMigration(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "Alert", "AlertEvent", "AlertDelivery", "AlertOccurrenceSeen" CASCADE`
  );
  await replayAlertsMigration(prisma);
}

export async function ensureAlertPartitions(
  prisma: PrismaClient,
  params: { from: Date; to: Date }
): Promise<void> {
  let month = new Date(Date.UTC(params.from.getUTCFullYear(), params.from.getUTCMonth(), 1));
  while (month <= params.to) {
    const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const suffix = `${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    for (const table of ["AlertEvent", "AlertDelivery"]) {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "public"."${table}_p${suffix}" ` +
          `PARTITION OF "public"."${table}" ` +
          `FOR VALUES FROM ('${month.toISOString()}') TO ('${next.toISOString()}')`
      );
    }
    month = next;
  }
}

export function rawSqlClient(prisma: PrismaClient) {
  return <T = any[]>(strings: TemplateStringsArray, ...values: unknown[]) =>
    prisma.$queryRaw<T>(strings, ...values);
}

export async function startAlertsPostgres() {
  const container = await new PostgreSqlContainer("docker.io/postgres:14").start();
  const prisma = new PrismaClient({ datasources: { db: { url: container.getConnectionUri() } } });
  await applyAlertsMigration(prisma);
  return {
    container,
    prisma,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
