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

    await this.#upsertBatchJobFunction();
  }

  #logDebug(message: string, args?: any) {
    logger.debug(`[migrationHelper] ${message}`, args);
  }

  async #upsertBatchJobFunction() {
    const prismaSchema = new URL(env.DATABASE_URL).searchParams.get("schema") ?? "public";

    await this.#prismaClient.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${prismaSchema}.add_batch_job(
        job_key text,
        job_key_new int,
        task_identifier text,
        payload json,
        maximum_payloads int,
        run_at timestamptz
      ) RETURNS ${env.WORKER_SCHEMA}.jobs AS $$
      DECLARE
        v_job ${env.WORKER_SCHEMA}.jobs;
      BEGIN
        IF json_typeof(payload) IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Must only call add_batch_job with an array payload';
        END IF;

        v_job := ${env.WORKER_SCHEMA}.add_job(
          identifier := task_identifier,
          payload := payload,
          run_at := run_at,
          job_key := job_key,
          job_key_mode := 'preserve_run_at'
        );
        
        IF json_array_length(v_job.payload) >= maximum_payloads THEN
          UPDATE jobs SET run_at = NOW() WHERE jobs.id = v_job.id RETURNING * INTO v_job;
          -- lie that this job was just inserted so a worker picks it up ASAP
          PERFORM pg_notify('jobs:insert', '');
        END IF;

        RETURN v_job;
      END
      $$ LANGUAGE plpgsql VOLATILE;
    `);
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

    console.log(`⚠️  detected pending graphile migration`);
    console.log(`⚠️  delaying worker startup by ${migrationDelayInMs}ms`);

    await new Promise((resolve) => setTimeout(resolve, migrationDelayInMs));

    console.log(`⚠️  notifying running workers about incoming migration`);

    const pgNotify = new PgNotifyService();
    await pgNotify.call("trigger:graphile:migrate", { latestMigration });
  }
}
