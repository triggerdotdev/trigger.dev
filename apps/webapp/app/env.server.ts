import { SecretStoreOptionsSchema } from "./services/secrets/secretStoreOptionsSchema.server";
import { z } from "zod";
import { isValidRegex } from "./utils/regex";
import { isValidDatabaseUrl } from "./utils/db";

const EnvironmentSchema = z.object({
  NODE_ENV: z.union([z.literal("development"), z.literal("production"), z.literal("test")]),
  DATABASE_URL: z
    .string()
    .refine(
      isValidDatabaseUrl,
      "DATABASE_URL is invalid, for details please check the additional output above this message."
    ),
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().default(10),
  DATABASE_POOL_TIMEOUT: z.coerce.number().int().default(60),
  DIRECT_URL: z
    .string()
    .refine(
      isValidDatabaseUrl,
      "DIRECT_URL is invalid, for details please check the additional output above this message."
    ),
  DATABASE_READ_REPLICA_URL: z.string().optional(),
  SESSION_SECRET: z.string(),
  MAGIC_LINK_SECRET: z.string(),
  ENCRYPTION_KEY: z.string(),
  WHITELISTED_EMAILS: z
    .string()
    .refine(isValidRegex, "WHITELISTED_EMAILS must be a valid regex.")
    .optional(),
  ADMIN_EMAILS: z.string().refine(isValidRegex, "ADMIN_EMAILS must be a valid regex.").optional(),
  REMIX_APP_PORT: z.string().optional(),
  LOGIN_ORIGIN: z.string().default("http://localhost:3030"),
  APP_ORIGIN: z.string().default("http://localhost:3030"),
  APP_ENV: z.string().default(process.env.NODE_ENV),
  SERVICE_NAME: z.string().default("trigger.dev webapp"),
  SECRET_STORE: SecretStoreOptionsSchema.default("DATABASE"),
  POSTHOG_PROJECT_KEY: z.string().default("phc_LFH7kJiGhdIlnO22hTAKgHpaKhpM8gkzWAFvHmf5vfS"),
  TELEMETRY_TRIGGER_API_KEY: z.string().optional(),
  TELEMETRY_TRIGGER_API_URL: z.string().optional(),
  TRIGGER_TELEMETRY_DISABLED: z.string().optional(),
  HIGHLIGHT_PROJECT_ID: z.string().optional(),
  AUTH_GITHUB_CLIENT_ID: z.string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  FROM_EMAIL: z.string().optional(),
  REPLY_TO_EMAIL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  PLAIN_API_KEY: z.string().optional(),
  RUNTIME_PLATFORM: z.enum(["docker-compose", "ecs", "local"]).default("local"),
  WORKER_SCHEMA: z.string().default("graphile_worker"),
  WORKER_CONCURRENCY: z.coerce.number().int().default(10),
  WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  /** The number of days a failed Graphile task should stay before getting cleaned up */
  WORKER_CLEANUP_TTL_DAYS: z.coerce.number().int().default(3),
  EXECUTION_WORKER_CONCURRENCY: z.coerce.number().int().default(10),
  EXECUTION_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  WORKER_ENABLED: z.string().default("true"),
  EXECUTION_WORKER_ENABLED: z.string().default("true"),
  TASK_OPERATION_WORKER_ENABLED: z.string().default("true"),
  TASK_OPERATION_WORKER_CONCURRENCY: z.coerce.number().int().default(10),
  TASK_OPERATION_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  GRACEFUL_SHUTDOWN_TIMEOUT: z.coerce.number().int().default(60000),
  /** Optional. Only used if you use the apps/proxy */
  AWS_SQS_REGION: z.string().optional(),
  /** Optional. Only used if you use the apps/proxy */
  AWS_SQS_ACCESS_KEY_ID: z.string().optional(),
  /** Optional. Only used if you use the apps/proxy */
  AWS_SQS_SECRET_ACCESS_KEY: z.string().optional(),
  /** Optional. Only used if you use the apps/proxy */
  AWS_SQS_QUEUE_URL: z.string().optional(),
  AWS_SQS_BATCH_SIZE: z.coerce.number().int().optional().default(1),
  AWS_SQS_WAIT_TIME_MS: z.coerce.number().int().optional().default(100),
  DISABLE_SSE: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Redis options
  REDIS_HOST: z.string().optional(),
  REDIS_READER_HOST: z.string().optional(),
  REDIS_READER_PORT: z.coerce.number().optional(),
  REDIS_PORT: z.coerce.number().optional(),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS_DISABLED: z.string().optional(),

  DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT: z.coerce.number().int().default(10),
  DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT: z.coerce.number().int().default(10),
  DEFAULT_DEV_ENV_EXECUTION_ATTEMPTS: z.coerce.number().int().positive().default(1),

  TUNNEL_HOST: z.string().optional(),
  TUNNEL_SECRET_KEY: z.string().optional(),

  //API Rate limiting
  /**
   * @example "60s"
   * @example "1m"
   * @example "1h"
   * @example "1d"
   * @example "1000ms"
   * @example "1000s"
   */
  API_RATE_LIMIT_REFILL_INTERVAL: z.string().default("10s"), // refill 250 tokens every 10 seconds
  API_RATE_LIMIT_MAX: z.coerce.number().int().default(750), // allow bursts of 750 requests
  API_RATE_LIMIT_REFILL_RATE: z.coerce.number().int().default(250), // refix 250 tokens every 10 seconds
  API_RATE_LIMIT_REQUEST_LOGS_ENABLED: z.string().default("0"),
  API_RATE_LIMIT_REJECTION_LOGS_ENABLED: z.string().default("1"),

  //Ingesting event rate limit
  INGEST_EVENT_RATE_LIMIT_WINDOW: z.string().default("60s"),
  INGEST_EVENT_RATE_LIMIT_MAX: z.coerce.number().int().optional(),

  //v3
  V3_ENABLED: z.string().default("false"),
  PROVIDER_SECRET: z.string().default("provider-secret"),
  COORDINATOR_SECRET: z.string().default("coordinator-secret"),
  DEPOT_TOKEN: z.string().optional(),
  DEPOT_PROJECT_ID: z.string().optional(),
  DEPOT_ORG_ID: z.string().optional(),
  CONTAINER_REGISTRY_ORIGIN: z.string().optional(),
  CONTAINER_REGISTRY_USERNAME: z.string().optional(),
  CONTAINER_REGISTRY_PASSWORD: z.string().optional(),
  DEPLOY_REGISTRY_HOST: z.string().optional(),
  DEPLOY_REGISTRY_NAMESPACE: z.string().default("trigger"),
  OBJECT_STORE_BASE_URL: z.string().optional(),
  OBJECT_STORE_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_STORE_SECRET_ACCESS_KEY: z.string().optional(),
  EVENTS_BATCH_SIZE: z.coerce.number().int().default(100),
  EVENTS_BATCH_INTERVAL: z.coerce.number().int().default(1000),
  EVENTS_DEFAULT_LOG_RETENTION: z.coerce.number().int().default(7),
  SHARED_QUEUE_CONSUMER_POOL_SIZE: z.coerce.number().int().default(10),
  SHARED_QUEUE_CONSUMER_INTERVAL_MS: z.coerce.number().int().default(100),
  SHARED_QUEUE_CONSUMER_NEXT_TICK_INTERVAL_MS: z.coerce.number().int().default(100),

  // Development OTEL environment variables
  DEV_OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  // If this is set to 1, then the below variables are used to configure the batch processor for spans and logs
  DEV_OTEL_BATCH_PROCESSING_ENABLED: z.string().default("0"),
  DEV_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
  DEV_OTEL_SPAN_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
  DEV_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
  DEV_OTEL_SPAN_MAX_QUEUE_SIZE: z.string().default("512"),
  DEV_OTEL_LOG_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
  DEV_OTEL_LOG_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
  DEV_OTEL_LOG_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
  DEV_OTEL_LOG_MAX_QUEUE_SIZE: z.string().default("512"),

  PROD_OTEL_BATCH_PROCESSING_ENABLED: z.string().default("0"),
  PROD_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
  PROD_OTEL_SPAN_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
  PROD_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
  PROD_OTEL_SPAN_MAX_QUEUE_SIZE: z.string().default("512"),
  PROD_OTEL_LOG_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
  PROD_OTEL_LOG_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
  PROD_OTEL_LOG_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
  PROD_OTEL_LOG_MAX_QUEUE_SIZE: z.string().default("512"),

  CHECKPOINT_THRESHOLD_IN_MS: z.coerce.number().int().default(30000),

  // Internal OTEL environment variables
  INTERNAL_OTEL_TRACE_EXPORTER_URL: z.string().optional(),
  INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADER_NAME: z.string().optional(),
  INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADER_VALUE: z.string().optional(),
  INTERNAL_OTEL_TRACE_LOGGING_ENABLED: z.string().default("1"),
  // this means 1/20 traces or 5% of traces will be sampled (sampled = recorded)
  INTERNAL_OTEL_TRACE_SAMPLING_RATE: z.string().default("20"),
  INTERNAL_OTEL_TRACE_INSTRUMENT_PRISMA_ENABLED: z.string().default("0"),
  INTERNAL_OTEL_TRACE_DISABLED: z.string().default("0"),

  ORG_SLACK_INTEGRATION_CLIENT_ID: z.string().optional(),
  ORG_SLACK_INTEGRATION_CLIENT_SECRET: z.string().optional(),

  /** These enable the alerts feature in v3 */
  ALERT_FROM_EMAIL: z.string().optional(),
  ALERT_RESEND_API_KEY: z.string().optional(),

  MAX_SEQUENTIAL_INDEX_FAILURE_COUNT: z.coerce.number().default(96),

  LOOPS_API_KEY: z.string().optional(),
  MARQS_DISABLE_REBALANCING: z.coerce.boolean().default(false),

  VERBOSE_GRAPHILE_LOGGING: z.string().default("false"),
  V2_MARQS_ENABLED: z.string().default("0"),
  V2_MARQS_CONSUMER_POOL_ENABLED: z.string().default("0"),
  V2_MARQS_CONSUMER_POOL_SIZE: z.coerce.number().int().default(10),
  V2_MARQS_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().default(1000),
  V2_MARQS_QUEUE_SELECTION_COUNT: z.coerce.number().int().default(36),
  V2_MARQS_VISIBILITY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .default(60 * 1000 * 15),
  V2_MARQS_DEFAULT_ENV_CONCURRENCY: z.coerce.number().int().default(100),
  V2_MARQS_VERBOSE: z.string().default("0"),
  V3_MARQS_CONCURRENCY_MONITOR_ENABLED: z.string().default("0"),
  V2_MARQS_CONCURRENCY_MONITOR_ENABLED: z.string().default("0"),
  /* Usage settings */
  USAGE_EVENT_URL: z.string().optional(),
  PROD_USAGE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().optional(),

  CENTS_PER_HOUR_MICRO: z.coerce.number().default(0),
  CENTS_PER_HOUR_SMALL_1X: z.coerce.number().default(0),
  CENTS_PER_HOUR_SMALL_2X: z.coerce.number().default(0),
  CENTS_PER_HOUR_MEDIUM_1X: z.coerce.number().default(0),
  CENTS_PER_HOUR_MEDIUM_2X: z.coerce.number().default(0),
  CENTS_PER_HOUR_LARGE_1X: z.coerce.number().default(0),
  CENTS_PER_HOUR_LARGE_2X: z.coerce.number().default(0),
  BASE_RUN_COST_IN_CENTS: z.coerce.number().default(0),

  USAGE_OPEN_METER_API_KEY: z.string().optional(),
  USAGE_OPEN_METER_BASE_URL: z.string().optional(),
  EVENT_LOOP_MONITOR_ENABLED: z.string().default("1"),
  MAXIMUM_LIVE_RELOADING_EVENTS: z.coerce.number().int().default(1000),
  MAXIMUM_TRACE_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(25_000),
  TASK_PAYLOAD_OFFLOAD_THRESHOLD: z.coerce.number().int().default(524_288), // 512KB
  TASK_PAYLOAD_MAXIMUM_SIZE: z.coerce.number().int().default(3_145_728), // 3MB
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);
