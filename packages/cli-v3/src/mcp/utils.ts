import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
