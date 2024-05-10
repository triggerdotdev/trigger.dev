import { runMigrations } from "graphile-worker";
import { PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { PgNotifyService } from "./pgNotify.server";
import { z } from "zod";

export class GraphileMigrationHelperService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call() {
    this.#logDebug("GraphileMigrationHelperService.call");

    await this.#detectAndPrepareForMigrations();

    await runMigrations({
      connectionString: env.DATABASE_URL,
      schema: env.WORKER_SCHEMA,
    });
  }

  #logDebug(message: string, args?: any) {
    logger.debug(`[migrationHelper] ${message}`, args);
  }

  async #getLatestMigration() {
    const migrationQueryResult = await this.#prismaClient.$queryRawUnsafe(`
      SELECT id FROM ${env.WORKER_SCHEMA}.migrations
      ORDER BY id DESC LIMIT 1
    `);

    const MigrationQueryResultSchema = z.array(z.object({ id: z.number() }));

    const migrationResults = MigrationQueryResultSchema.parse(migrationQueryResult);

    if (!migrationResults.length) {
      // no migrations applied yet
      return -1;
    }

    return migrationResults[0].id;
  }

  async #graphileSchemaExists() {
    const schemaCount = await this.#prismaClient.$executeRaw`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = ${env.WORKER_SCHEMA}
    `;

    return schemaCount === 1;
  }

  /** Helper for graphile-worker v0.14.0 migration. No-op if already migrated. */
  async #detectAndPrepareForMigrations() {
    if (!(await this.#graphileSchemaExists())) {
      // no schema yet, likely first start
      return;
    }

    const latestMigration = await this.#getLatestMigration();

    if (latestMigration < 0) {
      // no migrations found
      return;
    }

    // the first v0.14.0 migration has ID 11
    if (latestMigration > 10) {
      // already migrated
      return;
    }

    // add 15s to graceful shutdown timeout, just to be safe
    const migrationDelayInMs = env.GRACEFUL_SHUTDOWN_TIMEOUT + 15000;

    this.#logDebug("Delaying worker startup due to pending migration", {
      latestMigration,
      migrationDelayInMs,
    });

    console.log(`⚠️  detected pending graphile migration`);
    console.log(`⚠️  notifying running workers`);

    const pgNotify = new PgNotifyService();
    await pgNotify.call("trigger:graphile:migrate", { latestMigration });

    console.log(`⚠️  delaying worker startup by ${migrationDelayInMs}ms`);

    await new Promise((resolve) => setTimeout(resolve, migrationDelayInMs));
  }
}
