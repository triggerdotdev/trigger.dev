import { z } from "zod";

const EnvironmentSchema = z.object({
  PORT: z.coerce.number().finite().default(8889),
  PULSAR_URL: z.string().default("pulsar://localhost:6650"),
  AUTHORIZATION_URL: z
    .string()
    .default("http://localhost:3000/api/v1/internal/authorizeKey"),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export const env = EnvironmentSchema.parse(process.env);
