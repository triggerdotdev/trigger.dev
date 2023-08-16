import { z } from "zod";
import { SecretStoreOptionsSchema } from "./services/secrets/secretStore.server";

const EnvironmentSchema = z.object({
  NODE_ENV: z.union([z.literal("development"), z.literal("production"), z.literal("test")]),
  DATABASE_URL: z.string(),
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().default(10),
  DATABASE_POOL_TIMEOUT: z.coerce.number().int().default(60),
  DIRECT_URL: z.string(),
  SESSION_SECRET: z.string(),
  MAGIC_LINK_SECRET: z.string(),
  ENCRYPTION_KEY: z.string(),
  REMIX_APP_PORT: z.string().optional(),
  LOGIN_ORIGIN: z.string().default("http://localhost:3030"),
  APP_ORIGIN: z.string().default("http://localhost:3030"),
  APP_ENV: z
    .union([
      z.literal("development"),
      z.literal("production"),
      z.literal("test"),
      z.literal("staging"),
    ])
    .default(process.env.NODE_ENV),
  SECRET_STORE: SecretStoreOptionsSchema.default("DATABASE"),
  POSTHOG_PROJECT_KEY: z.string().optional(),
  TELEMETRY_TRIGGER_API_KEY: z.string().optional(),
  TELEMETRY_TRIGGER_API_URL: z.string().optional(),
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
  EXECUTION_WORKER_CONCURRENCY: z.coerce.number().int().default(10),
  EXECUTION_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
  WORKER_ENABLED: z.coerce.boolean().default(true),
  EXECUTION_WORKER_ENABLED: z.coerce.boolean().default(true),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);
