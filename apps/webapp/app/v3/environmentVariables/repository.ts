import { z } from "zod";

const EnvironmentVariable = z
  .string()
  .nonempty("Environment variable key is required")
  .regex(/^\w+$/, "Environment variables can only contain alphanumeric characters and underscores");

export const CreateEnvironmentVariable = z.object({
  key: EnvironmentVariable,
  values: z.array(
    z.object({
      environmentId: z.string(),
      value: z.string(),
    })
  ),
});

export type CreateEnvironmentVariable = z.infer<typeof CreateEnvironmentVariable>;

export type Result =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

export interface Repository {
  create(projectId: string, userId: string, options: CreateEnvironmentVariable): Promise<Result>;
}
