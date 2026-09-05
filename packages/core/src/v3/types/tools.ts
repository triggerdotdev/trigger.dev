import type { Schema as AISchema } from "ai";
import {
  isSchemaZodEsque,
  type AnyZodSchema,
  type inferZodSchemaOutput,
  type Schema,
} from "./schemas.js";

export type ToolTaskParameters = AnyZodSchema | AISchema<any>;

export type inferToolParameters<PARAMETERS extends ToolTaskParameters> =
  PARAMETERS extends AISchema<any>
    ? PARAMETERS["_type"]
    : PARAMETERS extends AnyZodSchema
      ? inferZodSchemaOutput<PARAMETERS>
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
