import { z } from "zod";

const EnvironmentSchema = z.object({
  APP_ORIGIN: z.string().default("https://app.trigger.dev"),
  SENTRY_DSN: z
    .string()
    .default(
      "https://a014169306c748b1adf61875c64b90de:a7fa7bfcc28d43e1bd293e121c677e4a@o4504169280569344.ingest.sentry.io/4504169281880064"
    ),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export const env = EnvironmentSchema.parse(process.env);
