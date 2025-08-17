import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import z from "zod";
import { ToolMeta } from "./types.js";
import { loadConfig } from "../config.js";

export function respondWithError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: enumerateError(error) }),
      },
    ],
  };
}

function enumerateError(error: unknown) {
  if (!error) {
    return error;
  }

  if (typeof error !== "object") {
    return error;
  }

  const newError: Record<string, unknown> = {};

  const errorProps = ["name", "message"] as const;

  for (const prop of errorProps) {
    if (prop in error) {
      newError[prop] = (error as Record<string, unknown>)[prop];
    }
  }

  return newError;
}

export function toolHandler<TInputShape extends z.ZodRawShape>(
  shape: TInputShape,
  handler: (input: z.output<z.ZodObject<TInputShape>>, meta: ToolMeta) => Promise<CallToolResult>
) {
  return async (input: unknown, extra: ToolMeta) => {
    const parsedInput = z.object(shape).safeParse(input);

    if (!parsedInput.success) {
      return respondWithError(parsedInput.error);
    }

    return handler(parsedInput.data, extra);
  };
}
