import { z } from "zod";
import { SecretStoreOptionsSchema } from "./services/secrets/secretStore.server";

const EnvironmentSchema = z.object({
  NODE_ENV: z.union([z.literal("development"), z.literal("production"), z.literal("test")]),
  DATABASE_URL: z.string(),
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
  SMTP_HOST: z.string().optional(), 
  SMTP_PORT: z.number().optional(), 
  SMTP_USER: z.string().optional(), 
  SMTP_PASSWORD: z.string().optional(), 
  PLAIN_API_KEY: z.string().optional(),
  RUNTIME_PLATFORM: z.enum(["docker-compose", "ecs", "local"]).default("local"),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);
