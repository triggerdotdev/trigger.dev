import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.union([
    z.literal("development"),
    z.literal("production"),
    z.literal("test"),
  ]),
  REMIX_APP_PORT: z.string().optional(),
  DATABASE_URL: z.string(),
  APP_ORIGIN: z.string().default("https://app.trigger.dev"),
  SENTRY_DSN: z
    .string()
    .default(
      "https://a014169306c748b1adf61875c64b90de:a7fa7bfcc28d43e1bd293e121c677e4a@o4504169280569344.ingest.sentry.io/4504169281880064"
    ),
  POSTHOG_PROJECT_KEY: z.string().optional(),
  MAGIC_LINK_SECRET: z.string(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_SECRET: z.string(),
  MAILGUN_KEY: z.string(),
  FROM_EMAIL: z.string(),
  MERGENT_KEY: z.string(),
  PRIMARY_REGION: z.string().optional(),
  FLY_REGION: z.string().optional(),
  SESSION_SECRET: z.string(),
  PIZZLY_HOST: z.string(),
  PULSAR_URL: z.string().default("pulsar://localhost:6650"),
  PULSAR_ENABLED: z
    .string()
    .default("0")
    .transform((v) => v === "1"),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export const env = EnvironmentSchema.parse(process.env);
