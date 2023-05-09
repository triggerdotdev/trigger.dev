import { z } from "zod";
import { SecretStoreProviderSchema } from "./services/secrets/secretStore.server";

const EnvironmentSchema = z.object({
  NODE_ENV: z.union([
    z.literal("development"),
    z.literal("production"),
    z.literal("test"),
  ]),
  REMIX_APP_PORT: z.string().optional(),
  DATABASE_URL: z.string(),
  LOGIN_ORIGIN: z
    .string()
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    .default(process.env.FC_URL ?? "https://app.trigger.dev"),
  APP_ORIGIN: z
    .string()
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    .default(process.env.FC_URL ?? "https://app.trigger.dev"),
  SENTRY_DSN: z.string().optional(),
  APP_ENV: z
    .union([
      z.literal("development"),
      z.literal("production"),
      z.literal("test"),
      z.literal("staging"),
    ])
    .default(process.env.NODE_ENV),
  SECRET_STORE: SecretStoreProviderSchema.default("database"),
  POSTHOG_PROJECT_KEY: z.string().optional(),
  MAGIC_LINK_SECRET: z.string(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_SECRET: z.string(),
  FROM_EMAIL: z.string(),
  REPLY_TO_EMAIL: z.string(),
  RESEND_API_KEY: z.string(),
  PRIMARY_REGION: z.string().optional(),
  FLY_REGION: z.string().optional(),
  SESSION_SECRET: z.string(),
  PIZZLY_HOST: z.string(),
  PIZZLY_SECRET_KEY: z.string().optional(),
  PULSAR_SERVICE_URL: z.string().default("pulsar://localhost:6650"),
  PULSAR_ENABLED: z
    .string()
    .default("0")
    .transform((v) => v === "1"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  PULSAR_CLIENT_ID: z.string().optional(),
  PULSAR_CLIENT_SECRET: z.string().optional(),
  PULSAR_ISSUER_URL: z.string().optional(),
  PULSAR_AUDIENCE: z.string().optional(),
  PULSAR_DEBUG: z.string().optional(),
  INTERNAL_TRIGGER_API_KEY: z.string().optional(),
  GITHUB_APP_NAME: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  INTEGRATIONS_API_KEY: z.string(),
  INTEGRATIONS_API_ORIGIN: z.string(),
  CAKEWORK_API_KEY: z.string(),
  TRIGGER_WSS_URL: z.string().default("wss://wss.trigger.dev/ws"),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);
