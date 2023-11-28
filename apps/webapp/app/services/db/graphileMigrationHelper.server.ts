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
    this.#logDebug("Upserting custom batch job function");

    // Differences to add_job:
    // - job_key is now required
    // - job_key_mode defaults to 'preserve_run_at'
    // - max_payloads is new
    // - payload must be a JSON array

    // FIXME: should delete all functions with same name
    await this.#prismaClient.$executeRawUnsafe(`
      DROP FUNCTION IF EXISTS add_batch_job(
        text,
        text,
        json,
        text,
        timestamp with time zone,
        integer,
        integer,
        text[],
        text,
        integer
        );`);

    await this.#prismaClient.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION add_batch_job(
        identifier text,
        job_key text,
        payload json default null::json,
        queue_name text default null::text,
        run_at timestamp with time zone default null::timestamp with time zone,
        max_attempts integer default null::integer,
        priority integer default null::integer,
        flags text[] default null::text[],
        job_key_mode text default 'preserve_run_at'::text,
        max_payloads integer default null::integer
      ) RETURNS ${env.WORKER_SCHEMA}._private_jobs AS $$
      DECLARE
        v_job ${env.WORKER_SCHEMA}._private_jobs;
      BEGIN
        IF json_typeof(payload) IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Must only call add_batch_job with an array payload';
        END IF;

        v_job := ${env.WORKER_SCHEMA}.add_job(
          identifier := identifier,
          payload := payload,
          queue_name := queue_name,
          run_at := run_at,
          max_attempts := max_attempts,
          job_key := job_key,
          priority := priority,
          flags := flags,
          job_key_mode := job_key_mode
        );

        IF max_payloads IS NOT NULL
        AND json_array_length(v_job.payload) >= max_payloads THEN
          UPDATE ${env.WORKER_SCHEMA}._private_jobs
            SET run_at = NOW()
            WHERE _private_jobs.id = v_job.id
            RETURNING * INTO v_job;
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
