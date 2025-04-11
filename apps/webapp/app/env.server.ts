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
  DATABASE_CONNECTION_TIMEOUT: z.coerce.number().int().default(20),
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
  API_ORIGIN: z.string().optional(),
  STREAM_ORIGIN: z.string().optional(),
  ELECTRIC_ORIGIN: z.string().default("http://localhost:3060"),
  APP_ENV: z.string().default(process.env.NODE_ENV),
  SERVICE_NAME: z.string().default("trigger.dev webapp"),
  SECRET_STORE: SecretStoreOptionsSchema.default("DATABASE"),
  POSTHOG_PROJECT_KEY: z.string().default("phc_LFH7kJiGhdIlnO22hTAKgHpaKhpM8gkzWAFvHmf5vfS"),
  TELEMETRY_TRIGGER_API_KEY: z.string().optional(),
  TELEMETRY_TRIGGER_API_URL: z.string().optional(),
  TRIGGER_TELEMETRY_DISABLED: z.string().optional(),
  AUTH_GITHUB_CLIENT_ID: z.string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  EMAIL_TRANSPORT: z.enum(["resend", "smtp", "aws-ses"]).optional(),
  FROM_EMAIL: z.string().optional(),
  REPLY_TO_EMAIL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z.coerce.boolean().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

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

  RATE_LIMIT_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  RATE_LIMIT_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  RATE_LIMIT_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  RATE_LIMIT_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  RATE_LIMIT_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  RATE_LIMIT_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  RATE_LIMIT_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
  RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  CACHE_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  CACHE_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  CACHE_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  CACHE_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  CACHE_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  CACHE_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  CACHE_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
  CACHE_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  REALTIME_STREAMS_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  REALTIME_STREAMS_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  REALTIME_STREAMS_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  REALTIME_STREAMS_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  REALTIME_STREAMS_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  REALTIME_STREAMS_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  REALTIME_STREAMS_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),
  REALTIME_STREAMS_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  PUBSUB_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  PUBSUB_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  PUBSUB_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  PUBSUB_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  PUBSUB_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  PUBSUB_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  PUBSUB_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
  PUBSUB_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

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
  API_RATE_LIMIT_LIMITER_LOGS_ENABLED: z.string().default("0"),

  API_RATE_LIMIT_JWT_WINDOW: z.string().default("1m"),
  API_RATE_LIMIT_JWT_TOKENS: z.coerce.number().int().default(60),

  //Realtime rate limiting
  /**
   * @example "60s"
   * @example "1m"
   * @example "1h"
   * @example "1d"
   * @example "1000ms"
   * @example "1000s"
   */
  REALTIME_RATE_LIMIT_WINDOW: z.string().default("1m"),
  REALTIME_RATE_LIMIT_TOKENS: z.coerce.number().int().default(100),
  REALTIME_RATE_LIMIT_REQUEST_LOGS_ENABLED: z.string().default("0"),
  REALTIME_RATE_LIMIT_REJECTION_LOGS_ENABLED: z.string().default("1"),
  REALTIME_RATE_LIMIT_LIMITER_LOGS_ENABLED: z.string().default("0"),

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
  DEPOT_REGION: z.string().default("us-east-1"),
  CONTAINER_REGISTRY_ORIGIN: z.string().optional(),
  CONTAINER_REGISTRY_USERNAME: z.string().optional(),
  CONTAINER_REGISTRY_PASSWORD: z.string().optional(),
  ENABLE_REGISTRY_PROXY: z.string().optional(),
  DEPLOY_REGISTRY_HOST: z.string().optional(),
  DEPLOY_REGISTRY_USERNAME: z.string().optional(),
  DEPLOY_REGISTRY_PASSWORD: z.string().optional(),
  DEPLOY_REGISTRY_NAMESPACE: z.string().default("trigger"),
  DEPLOY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .default(60 * 1000 * 8), // 8 minutes
  OBJECT_STORE_BASE_URL: z.string().optional(),
  OBJECT_STORE_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_STORE_SECRET_ACCESS_KEY: z.string().optional(),
  EVENTS_BATCH_SIZE: z.coerce.number().int().default(100),
  EVENTS_BATCH_INTERVAL: z.coerce.number().int().default(1000),
  EVENTS_DEFAULT_LOG_RETENTION: z.coerce.number().int().default(7),
  SHARED_QUEUE_CONSUMER_POOL_SIZE: z.coerce.number().int().default(10),
  SHARED_QUEUE_CONSUMER_INTERVAL_MS: z.coerce.number().int().default(100),
  SHARED_QUEUE_CONSUMER_NEXT_TICK_INTERVAL_MS: z.coerce.number().int().default(100),
  SHARED_QUEUE_CONSUMER_EMIT_RESUME_DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().default(1000),
  SHARED_QUEUE_CONSUMER_RESOLVE_PAYLOADS_BATCH_SIZE: z.coerce.number().int().default(25),

  MANAGED_WORKER_SECRET: z.string().default("managed-secret"),

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
  INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADERS: z.string().optional(),
  INTERNAL_OTEL_TRACE_LOGGING_ENABLED: z.string().default("1"),
  // this means 1/20 traces or 5% of traces will be sampled (sampled = recorded)
  INTERNAL_OTEL_TRACE_SAMPLING_RATE: z.string().default("20"),
  INTERNAL_OTEL_TRACE_INSTRUMENT_PRISMA_ENABLED: z.string().default("0"),
  INTERNAL_OTEL_TRACE_DISABLED: z.string().default("0"),

  INTERNAL_OTEL_LOG_EXPORTER_URL: z.string().optional(),

  ORG_SLACK_INTEGRATION_CLIENT_ID: z.string().optional(),
  ORG_SLACK_INTEGRATION_CLIENT_SECRET: z.string().optional(),

  /** These enable the alerts feature in v3 */
  ALERT_EMAIL_TRANSPORT: z.enum(["resend", "smtp", "aws-ses"]).optional(),
  ALERT_FROM_EMAIL: z.string().optional(),
  ALERT_REPLY_TO_EMAIL: z.string().optional(),
  ALERT_RESEND_API_KEY: z.string().optional(),
  ALERT_SMTP_HOST: z.string().optional(),
  ALERT_SMTP_PORT: z.coerce.number().optional(),
  ALERT_SMTP_SECURE: z.coerce.boolean().optional(),
  ALERT_SMTP_USER: z.string().optional(),
  ALERT_SMTP_PASSWORD: z.string().optional(),
  ALERT_RATE_LIMITER_EMISSION_INTERVAL: z.coerce.number().int().default(2_500),
  ALERT_RATE_LIMITER_BURST_TOLERANCE: z.coerce.number().int().default(10_000),
  ALERT_RATE_LIMITER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  ALERT_RATE_LIMITER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  ALERT_RATE_LIMITER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  ALERT_RATE_LIMITER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  ALERT_RATE_LIMITER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  ALERT_RATE_LIMITER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  ALERT_RATE_LIMITER_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),
  ALERT_RATE_LIMITER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  MAX_SEQUENTIAL_INDEX_FAILURE_COUNT: z.coerce.number().default(96),

  LOOPS_API_KEY: z.string().optional(),
  MARQS_DISABLE_REBALANCING: z.coerce.boolean().default(false),
  MARQS_VISIBILITY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .default(60 * 1000 * 15),
  MARQS_SHARED_QUEUE_LIMIT: z.coerce.number().int().default(1000),
  MARQS_DEV_QUEUE_LIMIT: z.coerce.number().int().default(1000),
  MARQS_MAXIMUM_NACK_COUNT: z.coerce.number().int().default(64),
  MARQS_CONCURRENCY_LIMIT_BIAS: z.coerce.number().default(0.75),
  MARQS_AVAILABLE_CAPACITY_BIAS: z.coerce.number().default(0.3),
  MARQS_QUEUE_AGE_RANDOMIZATION_BIAS: z.coerce.number().default(0.25),
  MARQS_REUSE_SNAPSHOT_COUNT: z.coerce.number().int().default(0),
  MARQS_MAXIMUM_ENV_COUNT: z.coerce.number().int().optional(),

  PROD_TASK_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().optional(),

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

  CENTS_PER_VCPU_SECOND: z.coerce.number().default(0),
  CENTS_PER_GB_RAM_SECOND: z.coerce.number().default(0),
  CENTS_PER_RUN: z.coerce.number().default(0),

  USAGE_OPEN_METER_API_KEY: z.string().optional(),
  USAGE_OPEN_METER_BASE_URL: z.string().optional(),
  EVENT_LOOP_MONITOR_ENABLED: z.string().default("1"),
  MAXIMUM_LIVE_RELOADING_EVENTS: z.coerce.number().int().default(1000),
  MAXIMUM_TRACE_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(25_000),
  TASK_PAYLOAD_OFFLOAD_THRESHOLD: z.coerce.number().int().default(524_288), // 512KB
  TASK_PAYLOAD_MAXIMUM_SIZE: z.coerce.number().int().default(3_145_728), // 3MB
  BATCH_TASK_PAYLOAD_MAXIMUM_SIZE: z.coerce.number().int().default(1_000_000), // 1MB
  TASK_RUN_METADATA_MAXIMUM_SIZE: z.coerce.number().int().default(262_144), // 256KB

  MAXIMUM_DEV_QUEUE_SIZE: z.coerce.number().int().optional(),
  MAXIMUM_DEPLOYED_QUEUE_SIZE: z.coerce.number().int().optional(),
  MAX_BATCH_V2_TRIGGER_ITEMS: z.coerce.number().int().default(500),
  MAX_BATCH_AND_WAIT_V2_TRIGGER_ITEMS: z.coerce.number().int().default(500),

  REALTIME_STREAM_VERSION: z.enum(["v1", "v2"]).default("v1"),
  REALTIME_STREAM_MAX_LENGTH: z.coerce.number().int().default(1000),
  REALTIME_STREAM_TTL: z.coerce
    .number()
    .int()
    .default(60 * 60 * 24), // 1 day in seconds
  BATCH_METADATA_OPERATIONS_FLUSH_INTERVAL_MS: z.coerce.number().int().default(1000),
  BATCH_METADATA_OPERATIONS_FLUSH_ENABLED: z.string().default("1"),
  BATCH_METADATA_OPERATIONS_FLUSH_LOGGING_ENABLED: z.string().default("1"),

  // Run Engine 2.0
  RUN_ENGINE_WORKER_COUNT: z.coerce.number().int().default(4),
  RUN_ENGINE_TASKS_PER_WORKER: z.coerce.number().int().default(10),
  RUN_ENGINE_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(10),
  RUN_ENGINE_WORKER_POLL_INTERVAL: z.coerce.number().int().default(100),
  RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(100),
  RUN_ENGINE_TIMEOUT_PENDING_EXECUTING: z.coerce.number().int().default(60_000),
  RUN_ENGINE_TIMEOUT_PENDING_CANCEL: z.coerce.number().int().default(60_000),
  RUN_ENGINE_TIMEOUT_EXECUTING: z.coerce.number().int().default(60_000),
  RUN_ENGINE_TIMEOUT_EXECUTING_WITH_WAITPOINTS: z.coerce.number().int().default(60_000),
  RUN_ENGINE_DEBUG_WORKER_NOTIFICATIONS: z.coerce.boolean().default(false),
  RUN_ENGINE_PARENT_QUEUE_LIMIT: z.coerce.number().int().default(1000),
  RUN_ENGINE_CONCURRENCY_LIMIT_BIAS: z.coerce.number().default(0.75),
  RUN_ENGINE_AVAILABLE_CAPACITY_BIAS: z.coerce.number().default(0.3),
  RUN_ENGINE_QUEUE_AGE_RANDOMIZATION_BIAS: z.coerce.number().default(0.25),
  RUN_ENGINE_REUSE_SNAPSHOT_COUNT: z.coerce.number().int().default(0),
  RUN_ENGINE_MAXIMUM_ENV_COUNT: z.coerce.number().int().optional(),
  RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),

  RUN_ENGINE_WORKER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  RUN_ENGINE_WORKER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  RUN_ENGINE_WORKER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  RUN_ENGINE_WORKER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  RUN_ENGINE_WORKER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  RUN_ENGINE_WORKER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  RUN_ENGINE_WORKER_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),

  RUN_ENGINE_RUN_QUEUE_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  RUN_ENGINE_RUN_QUEUE_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  RUN_ENGINE_RUN_QUEUE_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  RUN_ENGINE_RUN_QUEUE_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  RUN_ENGINE_RUN_QUEUE_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  RUN_ENGINE_RUN_QUEUE_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  RUN_ENGINE_RUN_QUEUE_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),

  RUN_ENGINE_RUN_LOCK_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  RUN_ENGINE_RUN_LOCK_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  RUN_ENGINE_RUN_LOCK_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  RUN_ENGINE_RUN_LOCK_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  RUN_ENGINE_RUN_LOCK_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  RUN_ENGINE_RUN_LOCK_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  RUN_ENGINE_RUN_LOCK_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),

  RUN_ENGINE_DEV_PRESENCE_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  RUN_ENGINE_DEV_PRESENCE_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  RUN_ENGINE_DEV_PRESENCE_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  RUN_ENGINE_DEV_PRESENCE_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  RUN_ENGINE_DEV_PRESENCE_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  RUN_ENGINE_DEV_PRESENCE_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  RUN_ENGINE_DEV_PRESENCE_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),

  //API Rate limiting
  /**
   * @example "60s"
   * @example "1m"
   * @example "1h"
   * @example "1d"
   * @example "1000ms"
   * @example "1000s"
   */
  RUN_ENGINE_RATE_LIMIT_REFILL_INTERVAL: z.string().default("10s"), // refill 250 tokens every 10 seconds
  RUN_ENGINE_RATE_LIMIT_MAX: z.coerce.number().int().default(1200), // allow bursts of 750 requests
  RUN_ENGINE_RATE_LIMIT_REFILL_RATE: z.coerce.number().int().default(400), // refix 250 tokens every 10 seconds
  RUN_ENGINE_RATE_LIMIT_REQUEST_LOGS_ENABLED: z.string().default("0"),
  RUN_ENGINE_RATE_LIMIT_REJECTION_LOGS_ENABLED: z.string().default("1"),
  RUN_ENGINE_RATE_LIMIT_LIMITER_LOGS_ENABLED: z.string().default("0"),

  RUN_ENGINE_RELEASE_CONCURRENCY_ENABLED: z.string().default("0"),
  RUN_ENGINE_RELEASE_CONCURRENCY_DISABLE_CONSUMERS: z.string().default("0"),
  RUN_ENGINE_RELEASE_CONCURRENCY_MAX_TOKENS_RATIO: z.coerce.number().default(1),
  RUN_ENGINE_RELEASE_CONCURRENCY_MAX_RETRIES: z.coerce.number().int().default(3),
  RUN_ENGINE_RELEASE_CONCURRENCY_CONSUMERS_COUNT: z.coerce.number().int().default(1),
  RUN_ENGINE_RELEASE_CONCURRENCY_POLL_INTERVAL: z.coerce.number().int().default(500),
  RUN_ENGINE_RELEASE_CONCURRENCY_BATCH_SIZE: z.coerce.number().int().default(10),

  RUN_ENGINE_WORKER_ENABLED: z.string().default("1"),

  /** How long should the presence ttl last */
  DEV_PRESENCE_SSE_TIMEOUT: z.coerce.number().int().default(30_000),
  DEV_PRESENCE_TTL_MS: z.coerce.number().int().default(5_000),
  DEV_PRESENCE_POLL_MS: z.coerce.number().int().default(1_000),
  /** How many ms to wait until dequeuing again, if there was a run last time */
  DEV_DEQUEUE_INTERVAL_WITH_RUN: z.coerce.number().int().default(250),
  /** How many ms to wait until dequeuing again, if there was no run last time */
  DEV_DEQUEUE_INTERVAL_WITHOUT_RUN: z.coerce.number().int().default(1_000),
  /** The max number of runs per API call that we'll dequeue in DEV */
  DEV_DEQUEUE_MAX_RUNS_PER_PULL: z.coerce.number().int().default(10),

  /** The maximum concurrent local run processes executing at once in dev */
  DEV_MAX_CONCURRENT_RUNS: z.coerce.number().int().default(25),

  LEGACY_RUN_ENGINE_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
  LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
  LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(1),
  LEGACY_RUN_ENGINE_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  LEGACY_RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
  LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(100),
  LEGACY_RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),

  LEGACY_RUN_ENGINE_WORKER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  LEGACY_RUN_ENGINE_WORKER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  LEGACY_RUN_ENGINE_WORKER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  LEGACY_RUN_ENGINE_WORKER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  LEGACY_RUN_ENGINE_WORKER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  LEGACY_RUN_ENGINE_WORKER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  LEGACY_RUN_ENGINE_WORKER_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),
  LEGACY_RUN_ENGINE_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  LEGACY_RUN_ENGINE_WAITING_FOR_DEPLOY_BATCH_SIZE: z.coerce.number().int().default(100),
  LEGACY_RUN_ENGINE_WAITING_FOR_DEPLOY_BATCH_STAGGER_MS: z.coerce.number().int().default(1_000),

  COMMON_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
  COMMON_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
  COMMON_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
  COMMON_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  COMMON_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
  COMMON_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(100),
  COMMON_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),

  COMMON_WORKER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  COMMON_WORKER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  COMMON_WORKER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  COMMON_WORKER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  COMMON_WORKER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  COMMON_WORKER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  COMMON_WORKER_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
  COMMON_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  TASK_EVENT_PARTITIONING_ENABLED: z.string().default("0"),
  TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS: z.coerce.number().int().default(60), // 1 minute

  QUEUE_SSE_AUTORELOAD_INTERVAL_MS: z.coerce.number().int().default(5_000),
  QUEUE_SSE_AUTORELOAD_TIMEOUT_MS: z.coerce.number().int().default(60_000),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);
