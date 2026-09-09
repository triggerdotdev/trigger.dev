import {
  isSchemaZodEsque,
  type AnyZodSchema,
  type inferZodSchemaOutput,
  type Schema,
} from "./schemas.js";

type ValidationResult<T> = { success: true; value: T } | { success: false; error: Error };

// The structural contract keeps Zod-only consumers independent of the optional AI SDK.
type AISchema<T> = {
  _type: T;
  readonly jsonSchema: unknown;
  readonly validate?: (value: unknown) => ValidationResult<T> | PromiseLike<ValidationResult<T>>;
};

export type ToolTaskParameters = AnyZodSchema | AISchema<any>;

export type inferToolParameters<PARAMETERS extends ToolTaskParameters> =
  PARAMETERS extends AnyZodSchema
    ? inferZodSchemaOutput<PARAMETERS>
    : PARAMETERS extends AISchema<any>
      ? PARAMETERS["_type"]
      : never;

export function convertToolParametersToSchema<TToolParameters extends ToolTaskParameters>(
  toolParameters: TToolParameters
): Schema {
  return isSchemaZodEsque(toolParameters)
    ? toolParameters
    : convertAISchemaToTaskSchema(toolParameters as AISchema<any>);
}

function convertAISchemaToTaskSchema(schema: AISchema<any>): Schema {
  return async (payload: unknown) => {
    const result = await schema.validate?.(payload);

    if (!result) {
      throw new Error("Invalid payload");
    }

    if (!result.success) {
      throw result.error;
    }

    return result.value;
  };
}
