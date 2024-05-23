import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";

export const EnvironmentVariableKey = z
  .string()
  .nonempty("Key is required")
  .regex(/^\w+$/, "Keys can only use alphanumeric characters and underscores");

export const CreateEnvironmentVariables = z.object({
  environmentIds: z.array(z.string()),
  variables: z.array(z.object({ key: EnvironmentVariableKey, value: z.string() })),
});

export type CreateEnvironmentVariables = z.infer<typeof CreateEnvironmentVariables>;

export type CreateResult =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
      variableErrors?: { key: string; error: string }[];
    };

export const EditEnvironmentVariable = z.object({
  id: z.string(),
  values: z.array(
    z.object({
      environmentId: z.string(),
      value: z.string(),
    })
  ),
  keepEmptyValues: z.boolean().optional(),
});
export type EditEnvironmentVariable = z.infer<typeof EditEnvironmentVariable>;

export const DeleteEnvironmentVariable = z.object({
  id: z.string(),
  environmentId: z.string().optional(),
});
export type DeleteEnvironmentVariable = z.infer<typeof DeleteEnvironmentVariable>;

export const DeleteEnvironmentVariableValue = z.object({
  id: z.string(),
  environmentId: z.string(),
});
export type DeleteEnvironmentVariableValue = z.infer<typeof DeleteEnvironmentVariableValue>;

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
  create(
    projectId: string,
    userId: string,
    options: CreateEnvironmentVariables
  ): Promise<CreateResult>;
  edit(projectId: string, userId: string, options: EditEnvironmentVariable): Promise<Result>;
  getProject(projectId: string, userId: string): Promise<ProjectEnvironmentVariable[]>;
  getEnvironment(
    projectId: string,
    userId: string,
    environmentId: string,
    excludeInternalVariables?: boolean
  ): Promise<EnvironmentVariable[]>;
  getEnvironmentVariables(
    projectId: string,
    environmentId: string,
    excludeInternalVariables?: boolean
  ): Promise<EnvironmentVariable[]>;
  delete(projectId: string, userId: string, options: DeleteEnvironmentVariable): Promise<Result>;
  deleteValue(
    projectId: string,
    userId: string,
    options: DeleteEnvironmentVariableValue
  ): Promise<Result>;
}
