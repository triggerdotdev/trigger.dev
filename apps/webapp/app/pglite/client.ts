import { PGlite, PGliteOptions } from "@electric-sql/pglite";

export async function client(options?: PGliteOptions) {
  // Load the data file
  const dataResponse = await fetch("/wasm/postgres.data");
  const dataBlob = await dataResponse.blob();

  const db = new PGlite("idb://triggerdotdev", {
    relaxedDurability: true,
    wasmModule: "/wasm/postgres.wasm",
    loadDataDir: dataBlob,
    ...options,
  });

  console.log("Creating tables...");

  const results = await db.exec(`
    DROP TYPE IF EXISTS "public"."TaskRunStatus";
    CREATE TYPE "public"."TaskRunStatus" AS ENUM ('PENDING', 'EXECUTING', 'WAITING_TO_RESUME', 'RETRYING_AFTER_FAILURE', 'PAUSED', 'CANCELED', 'COMPLETED_SUCCESSFULLY', 'COMPLETED_WITH_ERRORS', 'INTERRUPTED', 'SYSTEM_FAILURE', 'CRASHED', 'WAITING_FOR_DEPLOY', 'DELAYED', 'EXPIRED', 'TIMED_OUT');

    CREATE TABLE "public"."TaskRun" (
        "id" text NOT NULL,
        "idempotencyKey" text,
        "payload" text NOT NULL,
        "payloadType" text NOT NULL DEFAULT 'application/json'::text,
        "context" jsonb,
        "runtimeEnvironmentId" text NOT NULL,
        "projectId" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamp NOT NULL,
        "taskIdentifier" text NOT NULL,
        "lockedAt" timestamp,
        "lockedById" text,
        "friendlyId" text NOT NULL,
        "lockedToVersionId" text,
        "traceContext" jsonb,
        "spanId" text NOT NULL,
        "traceId" text NOT NULL,
        "concurrencyKey" text,
        "queue" text NOT NULL,
        "number" int4 NOT NULL DEFAULT 0,
        "isTest" bool NOT NULL DEFAULT false,
        "status" "public"."TaskRunStatus" NOT NULL DEFAULT 'PENDING'::"TaskRunStatus",
        "scheduleId" text,
        "scheduleInstanceId" text,
        "startedAt" timestamp,
        "usageDurationMs" int4 NOT NULL DEFAULT 0,
        "costInCents" float8 NOT NULL DEFAULT 0,
        "baseCostInCents" float8 NOT NULL DEFAULT 0,
        "machinePreset" text,
        "delayUntil" timestamp,
        "queuedAt" timestamp,
        "expiredAt" timestamp,
        "ttl" text,
        "maxAttempts" int4,
        "completedAt" timestamp,
        "logsDeletedAt" timestamp,
        "batchId" text,
        "depth" int4 NOT NULL DEFAULT 0,
        "parentTaskRunAttemptId" text,
        "parentTaskRunId" text,
        "resumeParentOnCompletion" bool NOT NULL DEFAULT false,
        "rootTaskRunId" text,
        "parentSpanId" text,
        "metadata" text,
        "metadataType" text NOT NULL DEFAULT 'application/json'::text,
        "output" text,
        "outputType" text NOT NULL DEFAULT 'application/json'::text,
        "error" jsonb,
        "seedMetadata" text,
        "seedMetadataType" text NOT NULL DEFAULT 'application/json'::text,
        "runTags" _text,
        "maxDurationInSeconds" int4,
        CONSTRAINT "TaskRun_parentTaskRunId_fkey" FOREIGN KEY ("parentTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL,
        CONSTRAINT "TaskRun_rootTaskRunId_fkey" FOREIGN KEY ("rootTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL,
        PRIMARY KEY ("id")
    );
  `);

  console.log("Created table...", { results });

  return db;
}
