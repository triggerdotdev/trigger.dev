import { z } from "zod";
import type { Schema as AISchema } from "ai";
import { Schema } from "./schemas.js";

export type ToolTaskParameters = z.ZodTypeAny | AISchema<any>;

export type inferToolParameters<PARAMETERS extends ToolTaskParameters> =
  PARAMETERS extends AISchema<any>
    ? PARAMETERS["_type"]
    : PARAMETERS extends z.ZodTypeAny
    ? z.infer<PARAMETERS>
    : never;

export function convertToolParametersToSchema<TToolParameters extends ToolTaskParameters>(
  toolParameters: TToolParameters
): Schema {
  return toolParameters instanceof z.ZodSchema
    ? toolParameters
    : convertAISchemaToTaskSchema(toolParameters);
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
