import { z } from "zod";
import { SecretStoreOptionsSchema } from "./services/secrets/secretStore.server";

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
  SECRET_STORE: SecretStoreOptionsSchema.default("DATABASE"),
  POSTHOG_PROJECT_KEY: z.string().optional(),
  MAGIC_LINK_SECRET: z.string(),
  AUTH_GITHUB_CLIENT_ID: z.string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  FROM_EMAIL: z.string(),
  REPLY_TO_EMAIL: z.string(),
  RESEND_API_KEY: z.string(),
  SESSION_SECRET: z.string(),
  PLAIN_API_KEY: z.string().optional(),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);
