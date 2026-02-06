import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";

export const EnvironmentVariableKey = z
  .string()
  .nonempty("Key is required")
  .regex(/^\w+$/, "Keys can only use alphanumeric characters and underscores");

export const EnvironmentVariableUpdaterSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    userId: z.string(),
  }),
  z.object({
    type: z.literal("integration"),
    integration: z.string(),
  }),
]);
export type EnvironmentVariableUpdater = z.infer<typeof EnvironmentVariableUpdaterSchema>;

export const CreateEnvironmentVariables = z.object({
  override: z.boolean(),
  environmentIds: z.array(z.string()),
  isSecret: z.boolean().optional(),
  parentEnvironmentId: z.string().optional(),
  variables: z.array(z.object({ key: EnvironmentVariableKey, value: z.string() })),
  lastUpdatedBy: EnvironmentVariableUpdaterSchema.optional(),
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
  lastUpdatedBy: EnvironmentVariableUpdaterSchema.optional(),
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

export const EditEnvironmentVariableValue = z.object({
  id: z.string(),
  environmentId: z.string(),
  value: z.string(),
  lastUpdatedBy: EnvironmentVariableUpdaterSchema.optional(),
});
export type EditEnvironmentVariableValue = z.infer<typeof EditEnvironmentVariableValue>;

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

export type EnvironmentVariableWithSecret = EnvironmentVariable & {
  isSecret: boolean;
};

export interface Repository {
  create(projectId: string, options: CreateEnvironmentVariables): Promise<CreateResult>;
  edit(projectId: string, options: EditEnvironmentVariable): Promise<Result>;
  editValue(projectId: string, options: EditEnvironmentVariableValue): Promise<Result>;
  getProject(projectId: string): Promise<ProjectEnvironmentVariable[]>;
  /**
   * Get the environment variables for a given environment, it does NOT return values for secret variables
   */
  getEnvironmentWithRedactedSecrets(
    projectId: string,
    environmentId: string
  ): Promise<EnvironmentVariableWithSecret[]>;
  /**
   * Get the environment variables for a given environment
   */
  getEnvironment(projectId: string, environmentId: string): Promise<EnvironmentVariable[]>;
  /**
   * Return all env vars, including secret variables with values. Should only be used for executing tasks.
   */
  getEnvironmentVariables(projectId: string, environmentId: string): Promise<EnvironmentVariable[]>;
  delete(projectId: string, options: DeleteEnvironmentVariable): Promise<Result>;
  deleteValue(projectId: string, options: DeleteEnvironmentVariableValue): Promise<Result>;
}
