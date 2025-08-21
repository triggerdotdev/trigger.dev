import { z } from "zod";
import { BoolEnv } from "./utils/boolEnv";
import { isValidDatabaseUrl } from "./utils/db";
import { isValidRegex } from "./utils/regex";

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
  // A comma separated list of electric origins to shard into different electric instances by environmentId
  // example: "http://localhost:3060,http://localhost:3061,http://localhost:3062"
  ELECTRIC_ORIGIN_SHARDS: z.string().optional(),
  APP_ENV: z.string().default(process.env.NODE_ENV),
  SERVICE_NAME: z.string().default("trigger.dev webapp"),
  POSTHOG_PROJECT_KEY: z.string().default("phc_LFH7kJiGhdIlnO22hTAKgHpaKhpM8gkzWAFvHmf5vfS"),
  TRIGGER_TELEMETRY_DISABLED: z.string().optional(),
  AUTH_GITHUB_CLIENT_ID: z.string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  EMAIL_TRANSPORT: z.enum(["resend", "smtp", "aws-ses"]).optional(),
  FROM_EMAIL: z.string().optional(),
  REPLY_TO_EMAIL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: BoolEnv.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  PLAIN_API_KEY: z.string().optional(),
  WORKER_SCHEMA: z.string().default("graphile_worker"),
  WORKER_CONCURRENCY: z.coerce.number().int().default(10),
  WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  WORKER_ENABLED: z.string().default("true"),
  GRACEFUL_SHUTDOWN_TIMEOUT: z.coerce.number().int().default(60000),
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

  REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS: z.coerce
    .number()
    .int()
    .default(24 * 60 * 60 * 1000), // 1 day in milliseconds

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

  DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT: z.coerce.number().int().default(100),
  DEFAULT_ENV_EXECUTION_CONCURRENCY_BURST_FACTOR: z.coerce.number().default(1.0),
  DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT: z.coerce.number().int().default(300),
  DEFAULT_DEV_ENV_EXECUTION_ATTEMPTS: z.coerce.number().int().positive().default(1),

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

  //v3
  PROVIDER_SECRET: z.string().default("provider-secret"),
  COORDINATOR_SECRET: z.string().default("coordinator-secret"),
  DEPOT_TOKEN: z.string().optional(),
  DEPOT_ORG_ID: z.string().optional(),
  DEPOT_REGION: z.string().default("us-east-1"),

  // Deployment registry (v3)
  DEPLOY_REGISTRY_HOST: z.string().min(1),
  DEPLOY_REGISTRY_USERNAME: z.string().optional(),
  DEPLOY_REGISTRY_PASSWORD: z.string().optional(),
  DEPLOY_REGISTRY_NAMESPACE: z.string().min(1).default("trigger"),
  DEPLOY_REGISTRY_ECR_TAGS: z.string().optional(), // csv, for example: "key1=value1,key2=value2"
  DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: z.string().optional(),
  DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: z.string().optional(),

  // Deployment registry (v4) - falls back to v3 registry if not specified
  V4_DEPLOY_REGISTRY_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.DEPLOY_REGISTRY_HOST)
    .pipe(z.string().min(1)), // Ensure final type is required string
  V4_DEPLOY_REGISTRY_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.DEPLOY_REGISTRY_USERNAME),
  V4_DEPLOY_REGISTRY_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.DEPLOY_REGISTRY_PASSWORD),
  V4_DEPLOY_REGISTRY_NAMESPACE: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.DEPLOY_REGISTRY_NAMESPACE)
    .pipe(z.string().min(1).default("trigger")), // Ensure final type is required string
  V4_DEPLOY_REGISTRY_ECR_TAGS: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.DEPLOY_REGISTRY_ECR_TAGS),
  V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN),
  V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID),

  DEPLOY_IMAGE_PLATFORM: z.string().default("linux/amd64"),
  DEPLOY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .default(60 * 1000 * 8), // 8 minutes

  OBJECT_STORE_BASE_URL: z.string().optional(),
  OBJECT_STORE_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_STORE_SECRET_ACCESS_KEY: z.string().optional(),
  OBJECT_STORE_REGION: z.string().optional(),
  OBJECT_STORE_SERVICE: z.string().default("s3"),
  EVENTS_BATCH_SIZE: z.coerce.number().int().default(100),
  EVENTS_BATCH_INTERVAL: z.coerce.number().int().default(1000),
  EVENTS_DEFAULT_LOG_RETENTION: z.coerce.number().int().default(7),
  EVENTS_MIN_CONCURRENCY: z.coerce.number().int().default(1),
  EVENTS_MAX_CONCURRENCY: z.coerce.number().int().default(10),
  EVENTS_MAX_BATCH_SIZE: z.coerce.number().int().default(500),
  EVENTS_MEMORY_PRESSURE_THRESHOLD: z.coerce.number().int().default(5000),
  EVENTS_LOAD_SHEDDING_THRESHOLD: z.coerce.number().int().default(100000),
  EVENTS_LOAD_SHEDDING_ENABLED: z.string().default("1"),
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

  TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: z.string().default("1024"),
  TRIGGER_OTEL_LOG_ATTRIBUTE_COUNT_LIMIT: z.string().default("1024"),
  TRIGGER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: z.string().default("131072"),
  TRIGGER_OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT: z.string().default("131072"),
  TRIGGER_OTEL_SPAN_EVENT_COUNT_LIMIT: z.string().default("10"),
  TRIGGER_OTEL_LINK_COUNT_LIMIT: z.string().default("2"),
  TRIGGER_OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT: z.string().default("10"),
  TRIGGER_OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT: z.string().default("10"),

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
  INTERNAL_OTEL_METRIC_EXPORTER_URL: z.string().optional(),
  INTERNAL_OTEL_METRIC_EXPORTER_AUTH_HEADERS: z.string().optional(),
  INTERNAL_OTEL_METRIC_EXPORTER_ENABLED: z.string().default("0"),
  INTERNAL_OTEL_METRIC_EXPORTER_INTERVAL_MS: z.coerce.number().int().default(30_000),

  ORG_SLACK_INTEGRATION_CLIENT_ID: z.string().optional(),
  ORG_SLACK_INTEGRATION_CLIENT_SECRET: z.string().optional(),

  /** These enable the alerts feature in v3 */
  ALERT_EMAIL_TRANSPORT: z.enum(["resend", "smtp", "aws-ses"]).optional(),
  ALERT_FROM_EMAIL: z.string().optional(),
  ALERT_REPLY_TO_EMAIL: z.string().optional(),
  ALERT_RESEND_API_KEY: z.string().optional(),
  ALERT_SMTP_HOST: z.string().optional(),
  ALERT_SMTP_PORT: z.coerce.number().optional(),
  ALERT_SMTP_SECURE: BoolEnv.optional(),
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

  LOOPS_API_KEY: z.string().optional(),
  MARQS_DISABLE_REBALANCING: BoolEnv.default(false),
  MARQS_VISIBILITY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .default(60 * 1000 * 15),
  MARQS_SHARED_QUEUE_LIMIT: z.coerce.number().int().default(1000),
  MARQS_MAXIMUM_QUEUE_PER_ENV_COUNT: z.coerce.number().int().default(50),
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

  CENTS_PER_RUN: z.coerce.number().default(0),

  EVENT_LOOP_MONITOR_ENABLED: z.string().default("1"),
  MAXIMUM_LIVE_RELOADING_EVENTS: z.coerce.number().int().default(1000),
  MAXIMUM_TRACE_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(25_000),
  MAXIMUM_TRACE_DETAILED_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(10_000),
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
  RUN_ENGINE_TIMEOUT_SUSPENDED: z.coerce
    .number()
    .int()
    .default(60_000 * 10),
  RUN_ENGINE_DEBUG_WORKER_NOTIFICATIONS: BoolEnv.default(false),
  RUN_ENGINE_PARENT_QUEUE_LIMIT: z.coerce.number().int().default(1000),
  RUN_ENGINE_CONCURRENCY_LIMIT_BIAS: z.coerce.number().default(0.75),
  RUN_ENGINE_AVAILABLE_CAPACITY_BIAS: z.coerce.number().default(0.3),
  RUN_ENGINE_QUEUE_AGE_RANDOMIZATION_BIAS: z.coerce.number().default(0.25),
  RUN_ENGINE_REUSE_SNAPSHOT_COUNT: z.coerce.number().int().default(0),
  RUN_ENGINE_MAXIMUM_ENV_COUNT: z.coerce.number().int().optional(),
  RUN_ENGINE_RUN_QUEUE_SHARD_COUNT: z.coerce.number().int().default(4),
  RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  RUN_ENGINE_RETRY_WARM_START_THRESHOLD_MS: z.coerce.number().int().default(30_000),
  RUN_ENGINE_PROCESS_WORKER_QUEUE_DEBOUNCE_MS: z.coerce.number().int().default(200),
  RUN_ENGINE_DEQUEUE_BLOCKING_TIMEOUT_SECONDS: z.coerce.number().int().default(10),
  RUN_ENGINE_MASTER_QUEUE_CONSUMERS_INTERVAL_MS: z.coerce.number().int().default(500),
  RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_SCHEDULE: z.string().optional(),
  RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_SCHEDULE: z.string().optional(),
  RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_JITTER_IN_MS: z.coerce.number().int().optional(),
  RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_JITTER_IN_MS: z.coerce.number().int().optional(),

  RUN_ENGINE_RUN_LOCK_DURATION: z.coerce.number().int().default(5000),
  RUN_ENGINE_RUN_LOCK_AUTOMATIC_EXTENSION_THRESHOLD: z.coerce.number().int().default(1000),
  RUN_ENGINE_RUN_LOCK_MAX_RETRIES: z.coerce.number().int().default(10),
  RUN_ENGINE_RUN_LOCK_BASE_DELAY: z.coerce.number().int().default(100),
  RUN_ENGINE_RUN_LOCK_MAX_DELAY: z.coerce.number().int().default(3000),
  RUN_ENGINE_RUN_LOCK_BACKOFF_MULTIPLIER: z.coerce.number().default(1.8),
  RUN_ENGINE_RUN_LOCK_JITTER_FACTOR: z.coerce.number().default(0.15),
  RUN_ENGINE_RUN_LOCK_MAX_TOTAL_WAIT_TIME: z.coerce.number().int().default(15000),

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
  RUN_ENGINE_RELEASE_CONCURRENCY_RELEASINGS_MAX_AGE: z.coerce
    .number()
    .int()
    .default(60_000 * 30),
  RUN_ENGINE_RELEASE_CONCURRENCY_RELEASINGS_POLL_INTERVAL: z.coerce.number().int().default(60_000),
  RUN_ENGINE_RELEASE_CONCURRENCY_MAX_RETRIES: z.coerce.number().int().default(3),
  RUN_ENGINE_RELEASE_CONCURRENCY_CONSUMERS_COUNT: z.coerce.number().int().default(1),
  RUN_ENGINE_RELEASE_CONCURRENCY_POLL_INTERVAL: z.coerce.number().int().default(500),
  RUN_ENGINE_RELEASE_CONCURRENCY_BATCH_SIZE: z.coerce.number().int().default(10),

  RUN_ENGINE_WORKER_ENABLED: z.string().default("1"),
  RUN_ENGINE_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
  RUN_ENGINE_RUN_QUEUE_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

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

  /** The CLI should connect to this for dev runs */
  DEV_ENGINE_URL: z.string().default(process.env.APP_ORIGIN ?? "http://localhost:3030"),

  LEGACY_RUN_ENGINE_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
  LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
  LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(1),
  LEGACY_RUN_ENGINE_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  LEGACY_RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
  LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(50),
  LEGACY_RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  LEGACY_RUN_ENGINE_WORKER_LOG_LEVEL: z
    .enum(["log", "error", "warn", "info", "debug"])
    .default("info"),

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
  COMMON_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(50),
  COMMON_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  COMMON_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

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

  BATCH_TRIGGER_PROCESS_JOB_VISIBILITY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .default(60_000 * 5), // 5 minutes

  BATCH_TRIGGER_CACHED_RUNS_CHECK_ENABLED: BoolEnv.default(false),

  BATCH_TRIGGER_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
  BATCH_TRIGGER_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
  BATCH_TRIGGER_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
  BATCH_TRIGGER_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  BATCH_TRIGGER_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
  BATCH_TRIGGER_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(20),
  BATCH_TRIGGER_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  BATCH_TRIGGER_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

  BATCH_TRIGGER_WORKER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  BATCH_TRIGGER_WORKER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  BATCH_TRIGGER_WORKER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  BATCH_TRIGGER_WORKER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  BATCH_TRIGGER_WORKER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  BATCH_TRIGGER_WORKER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  BATCH_TRIGGER_WORKER_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),
  BATCH_TRIGGER_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  ADMIN_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
  ADMIN_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
  ADMIN_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
  ADMIN_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  ADMIN_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
  ADMIN_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(20),
  ADMIN_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  ADMIN_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

  ADMIN_WORKER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  ADMIN_WORKER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  ADMIN_WORKER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  ADMIN_WORKER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  ADMIN_WORKER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  ADMIN_WORKER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  ADMIN_WORKER_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
  ADMIN_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  ALERTS_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
  ALERTS_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
  ALERTS_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
  ALERTS_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  ALERTS_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(100),
  ALERTS_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(50),
  ALERTS_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  ALERTS_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

  ALERTS_WORKER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  ALERTS_WORKER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  ALERTS_WORKER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  ALERTS_WORKER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  ALERTS_WORKER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  ALERTS_WORKER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  ALERTS_WORKER_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
  ALERTS_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  SCHEDULE_ENGINE_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
  SCHEDULE_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
  SCHEDULE_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
  SCHEDULE_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
  SCHEDULE_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  SCHEDULE_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
  SCHEDULE_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(50),
  SCHEDULE_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(30_000),
  SCHEDULE_WORKER_DISTRIBUTION_WINDOW_SECONDS: z.coerce.number().int().default(30),

  SCHEDULE_WORKER_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  SCHEDULE_WORKER_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  SCHEDULE_WORKER_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  SCHEDULE_WORKER_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  SCHEDULE_WORKER_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  SCHEDULE_WORKER_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  SCHEDULE_WORKER_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
  SCHEDULE_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

  TASK_EVENT_PARTITIONING_ENABLED: z.string().default("0"),
  TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS: z.coerce.number().int().default(60), // 1 minute

  QUEUE_SSE_AUTORELOAD_INTERVAL_MS: z.coerce.number().int().default(5_000),
  QUEUE_SSE_AUTORELOAD_TIMEOUT_MS: z.coerce.number().int().default(60_000),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNUP_REASON_CHANNEL_ID: z.string().optional(),

  // kapa.ai
  KAPA_AI_WEBSITE_ID: z.string().optional(),

  // BetterStack
  BETTERSTACK_API_KEY: z.string().optional(),
  BETTERSTACK_STATUS_PAGE_ID: z.string().optional(),

  RUN_REPLICATION_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  RUN_REPLICATION_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  RUN_REPLICATION_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  RUN_REPLICATION_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  RUN_REPLICATION_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  RUN_REPLICATION_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  RUN_REPLICATION_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),

  RUN_REPLICATION_CLICKHOUSE_URL: z.string().optional(),
  RUN_REPLICATION_ENABLED: z.string().default("0"),
  RUN_REPLICATION_SLOT_NAME: z.string().default("task_runs_to_clickhouse_v1"),
  RUN_REPLICATION_PUBLICATION_NAME: z.string().default("task_runs_to_clickhouse_v1_publication"),
  RUN_REPLICATION_MAX_FLUSH_CONCURRENCY: z.coerce.number().int().default(2),
  RUN_REPLICATION_FLUSH_INTERVAL_MS: z.coerce.number().int().default(1000),
  RUN_REPLICATION_FLUSH_BATCH_SIZE: z.coerce.number().int().default(100),
  RUN_REPLICATION_LEADER_LOCK_TIMEOUT_MS: z.coerce.number().int().default(30_000),
  RUN_REPLICATION_LEADER_LOCK_EXTEND_INTERVAL_MS: z.coerce.number().int().default(10_000),
  RUN_REPLICATION_ACK_INTERVAL_SECONDS: z.coerce.number().int().default(10),
  RUN_REPLICATION_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
  RUN_REPLICATION_CLICKHOUSE_LOG_LEVEL: z
    .enum(["log", "error", "warn", "info", "debug"])
    .default("info"),
  RUN_REPLICATION_LEADER_LOCK_ADDITIONAL_TIME_MS: z.coerce.number().int().default(10_000),
  RUN_REPLICATION_LEADER_LOCK_RETRY_INTERVAL_MS: z.coerce.number().int().default(500),
  RUN_REPLICATION_WAIT_FOR_ASYNC_INSERT: z.string().default("0"),
  RUN_REPLICATION_KEEP_ALIVE_ENABLED: z.string().default("0"),
  RUN_REPLICATION_KEEP_ALIVE_IDLE_SOCKET_TTL_MS: z.coerce.number().int().optional(),
  RUN_REPLICATION_MAX_OPEN_CONNECTIONS: z.coerce.number().int().default(10),
  // Retry configuration for insert operations
  RUN_REPLICATION_INSERT_MAX_RETRIES: z.coerce.number().int().default(3),
  RUN_REPLICATION_INSERT_BASE_DELAY_MS: z.coerce.number().int().default(100),
  RUN_REPLICATION_INSERT_MAX_DELAY_MS: z.coerce.number().int().default(2000),
  RUN_REPLICATION_INSERT_STRATEGY: z.enum(["insert", "insert_async"]).default("insert"),

  // Clickhouse
  CLICKHOUSE_URL: z.string(),
  CLICKHOUSE_KEEP_ALIVE_ENABLED: z.string().default("1"),
  CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS: z.coerce.number().int().optional(),
  CLICKHOUSE_MAX_OPEN_CONNECTIONS: z.coerce.number().int().default(10),
  CLICKHOUSE_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
  CLICKHOUSE_COMPRESSION_REQUEST: z.string().default("1"),

  // Bootstrap
  TRIGGER_BOOTSTRAP_ENABLED: z.string().default("0"),
  TRIGGER_BOOTSTRAP_WORKER_GROUP_NAME: z.string().optional(),
  TRIGGER_BOOTSTRAP_WORKER_TOKEN_PATH: z.string().optional(),

  // Machine presets
  MACHINE_PRESETS_OVERRIDE_PATH: z.string().optional(),

  // CLI package tag (e.g. "latest", "v4-beta", "4.0.0") - used for setup commands
  TRIGGER_CLI_TAG: z.string().default("latest"),

  HEALTHCHECK_DATABASE_DISABLED: z.string().default("0"),

  REQUEST_IDEMPOTENCY_REDIS_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_HOST),
  REQUEST_IDEMPOTENCY_REDIS_READER_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_READER_HOST),
  REQUEST_IDEMPOTENCY_REDIS_READER_PORT: z.coerce
    .number()
    .optional()
    .transform(
      (v) =>
        v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
    ),
  REQUEST_IDEMPOTENCY_REDIS_PORT: z.coerce
    .number()
    .optional()
    .transform((v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)),
  REQUEST_IDEMPOTENCY_REDIS_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_USERNAME),
  REQUEST_IDEMPOTENCY_REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v ?? process.env.REDIS_PASSWORD),
  REQUEST_IDEMPOTENCY_REDIS_TLS_DISABLED: z
    .string()
    .default(process.env.REDIS_TLS_DISABLED ?? "false"),

  REQUEST_IDEMPOTENCY_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

  REQUEST_IDEMPOTENCY_TTL_IN_MS: z.coerce
    .number()
    .int()
    .default(60_000 * 60 * 24),

  // Bulk action
  BULK_ACTION_BATCH_SIZE: z.coerce.number().int().default(100),
  BULK_ACTION_BATCH_DELAY_MS: z.coerce.number().int().default(200),
  BULK_ACTION_SUBBATCH_CONCURRENCY: z.coerce.number().int().default(5),

  // AI Run Filter
  AI_RUN_FILTER_MODEL: z.string().optional(),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);
