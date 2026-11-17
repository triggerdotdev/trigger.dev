import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";

export const EnvironmentVariableKey = z
  .string()
  .nonempty("Key is required")
  .regex(/^\w+$/, "Keys can only use alphanumeric characters and underscores");

const EnvironmentVariableUpdaterSchema = z.discriminatedUnion("type", [
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

export type CreateAuditOptions = {
  /** Marks each recorded event with `changes.imported: true`, e.g. for a CLI import or a sync. */
  imported?: boolean;
  /** Where imported variables came from, recorded as `changes.via`. */
  via?: "vercel";
};

/**
 * A write that didn't happen. `conflict` marks one that lost to another request changing the
 * same variable at the same time, so trying again can work.
 */
type Failure = {
  success: false;
  error: string;
  conflict?: true;
};

export type CreateResult =
  | {
      success: true;
    }
  | (Failure & {
      variableErrors?: { key: string; error: string }[];
    });

export const EditEnvironmentVariable = z.object({
  id: z.string(),
  values: z.array(
    z.object({
      environmentId: z.string(),
      value: z.string(),
    })
  ),
  lastUpdatedBy: EnvironmentVariableUpdaterSchema.optional(),
});
export type EditEnvironmentVariable = z.infer<typeof EditEnvironmentVariable>;

export const DeleteEnvironmentVariableValue = z.object({
  id: z.string(),
  environmentId: z.string(),
});
export type DeleteEnvironmentVariableValue = z.infer<typeof DeleteEnvironmentVariableValue>;

/** The most values one batch delete takes. */
export const DELETE_ENVIRONMENT_VARIABLE_VALUES_LIMIT = 100;

export const DeleteEnvironmentVariableValues = z
  .array(DeleteEnvironmentVariableValue)
  .min(1, "Select at least one value to delete.")
  .max(
    DELETE_ENVIRONMENT_VARIABLE_VALUES_LIMIT,
    `At most ${DELETE_ENVIRONMENT_VARIABLE_VALUES_LIMIT} values can be deleted at once.`
  );

export type DeleteValuesResult =
  | {
      success: true;
      /** The values that were there to delete. One that was already gone isn't listed. */
      deleted: Array<{ id: string; key: string; environmentId: string }>;
    }
  | Failure;

/** The most values one copy takes. */
export const COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT = 100;

export const CopyEnvironmentVariableValues = z.object({
  sourceEnvironmentId: z.string(),
  targetEnvironmentId: z.string(),
  variableIds: z
    .array(z.string())
    .min(1, "Select at least one value to copy.")
    .max(
      COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT,
      `At most ${COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT} values can be copied at once.`
    ),
  lastUpdatedBy: EnvironmentVariableUpdaterSchema.optional(),
});
export type CopyEnvironmentVariableValues = z.infer<typeof CopyEnvironmentVariableValues>;

export type CopyValuesResult =
  | {
      success: true;
      /** Each copied variable, and whether its value was new in the target. */
      copied: Array<{ id: string; key: string; created: boolean }>;
    }
  | Failure;

// Forms preserve explicit empty strings through their custom coercion.
// A missing field is still invalid.
export const EnvironmentVariableValue = z.string();

export const EditEnvironmentVariableValue = z.object({
  id: z.string(),
  environmentId: z.string(),
  value: EnvironmentVariableValue,
  setEmptyValue: z.literal("true").optional(),
  lastUpdatedBy: EnvironmentVariableUpdaterSchema.optional(),
});
export type EditEnvironmentVariableValue = z.infer<typeof EditEnvironmentVariableValue>;

export type Result =
  | {
      success: true;
    }
  | Failure;

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
  create(
    projectId: string,
    options: CreateEnvironmentVariables,
    audit?: CreateAuditOptions
  ): Promise<CreateResult>;
  edit(projectId: string, options: EditEnvironmentVariable): Promise<Result>;
  editValue(projectId: string, options: EditEnvironmentVariableValue): Promise<Result>;
  getProject(projectId: string): Promise<ProjectEnvironmentVariable[]>;
  /**
   * Fetch and decrypt only the given env var values (for dashboard display of non-secret rows).
   * Map keys are `${environmentId}:${variableKey}`.
   */
  getVariableValuesForKeys(
    projectId: string,
    items: Array<{ environmentId: string; key: string }>
  ): Promise<Map<string, string>>;
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
  getEnvironmentVariables(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string,
    options?: { readFromReplica?: boolean }
  ): Promise<EnvironmentVariable[]>;
  deleteValue(projectId: string, options: DeleteEnvironmentVariableValue): Promise<Result>;
  deleteValues(
    projectId: string,
    values: DeleteEnvironmentVariableValue[]
  ): Promise<DeleteValuesResult>;
  copyValues(projectId: string, options: CopyEnvironmentVariableValues): Promise<CopyValuesResult>;
}
