import {
  isSchemaZodEsque,
  type inferSchemaIn,
  type TaskSchema,
  type TaskWithSchema,
} from "@trigger.dev/core/v3";
import { jsonSchema, Schema, tool, ToolExecutionOptions, zodSchema } from "ai";
import { metadata } from "./metadata.js";

const METADATA_KEY = "tool.execute.options";

export type ToolCallExecutionOptions = Omit<ToolExecutionOptions, "abortSignal">;

type ToolResultContent = Array<
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mimeType?: string;
    }
>;

export type ToolOptions<TResult> = {
  experimental_toToolResultContent?: (result: TResult) => ToolResultContent;
};

function toolFromTask<
  TIdentifier extends string,
  TTaskSchema extends TaskSchema | undefined = undefined,
  TOutput = unknown,
>(task: TaskWithSchema<TIdentifier, TTaskSchema, TOutput>, options?: ToolOptions<TOutput>) {
  if (!task.schema) {
    throw new Error(
      "Cannot convert schemaTask to a tool because the task has no schema. Make sure the schema used in the task is either zod, arktype, or another supported schema."
    );
  }

  return tool({
    description: task.description,
    parameters: convertTaskSchemaToToolParameters(task.schema),
    execute: async (args, options) => {
      const serializedOptions = options ? JSON.parse(JSON.stringify(options)) : undefined;

      return await task
        .triggerAndWait(args, {
          metadata: {
            [METADATA_KEY]: serializedOptions,
          },
        })
        .unwrap();
    },
    ...options,
  });
}

function getToolOptionsFromMetadata(): ToolCallExecutionOptions | undefined {
  const tool = metadata.get(METADATA_KEY);
  if (!tool) {
    return undefined;
  }
  return tool as ToolCallExecutionOptions;
}

function convertTaskSchemaToToolParameters<TTaskSchema extends TaskSchema>(
  schema: TTaskSchema
): Schema<inferSchemaIn<TTaskSchema>> {
  // If TaskSchema is ZodEsque, use ai.zodSchema to convert it to a Schema
  if (isSchemaZodEsque(schema)) {
    return zodSchema(schema as any);
  }

  // If TaskSchema is ArkTypeEsque, use ai.jsonSchema to convert it to a Schema
  if ("toJsonSchema" in schema && typeof schema.toJsonSchema === "function") {
    return jsonSchema((schema as any).toJsonSchema());
  }

  throw new Error(
    "Cannot convert schemaTask to a tool. Make sure the schema used in the task is either zod, arktype, or another supported schema."
  );
}

export const ai = {
  tool: toolFromTask,
  currentToolOptions: getToolOptionsFromMetadata,
};
