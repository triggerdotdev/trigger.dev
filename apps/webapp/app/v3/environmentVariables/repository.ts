import { z } from "zod";

export const CreateEnvironmentVariable = z.object({
  key: z.string(),
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
