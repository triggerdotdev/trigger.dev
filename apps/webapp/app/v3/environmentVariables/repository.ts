import { RuntimeEnvironmentType } from "@trigger.dev/database";
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

export const EditEnvironmentVariable = z.object({
  id: z.string(),
  values: z.array(
    z.object({
      environmentId: z.string(),
      value: z.string(),
    })
  ),
});
export type EditEnvironmentVariable = z.infer<typeof EditEnvironmentVariable>;

export type Result =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

export type ProjectEnvironmentVariable = {
  key: string;
  values: {
    value: string;
    environment: {
      id: string;
      type: RuntimeEnvironmentType;
    };
  }[];
};

export type EnvironmentVariable = {
  key: string;
  value: string;
};

export interface Repository {
  create(projectId: string, userId: string, options: CreateEnvironmentVariable): Promise<Result>;
  edit(projectId: string, userId: string, options: EditEnvironmentVariable): Promise<Result>;
  getProject(projectId: string, userId: string): Promise<ProjectEnvironmentVariable[]>;
  getEnvironment(
    projectId: string,
    userId: string,
    environmentId: string
  ): Promise<EnvironmentVariable[]>;
}
