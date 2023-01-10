import { z } from "zod";

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
  POSTHOG_PROJECT_KEY: z.string().optional(),
  MAGIC_LINK_SECRET: z.string(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_SECRET: z.string(),
  FROM_EMAIL: z.string(),
  REPLY_TO_EMAIL: z.string(),
  RESEND_API_KEY: z.string(),
  MERGENT_KEY: z.string(),
  PRIMARY_REGION: z.string().optional(),
  FLY_REGION: z.string().optional(),
  SESSION_SECRET: z.string(),
  PIZZLY_HOST: z.string(),
  PULSAR_SERVICE_URL: z.string().default("pulsar://localhost:6650"),
  PULSAR_ENABLED: z
    .string()
    .default("0")
    .transform((v) => v === "1"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export const env = EnvironmentSchema.parse(process.env);
