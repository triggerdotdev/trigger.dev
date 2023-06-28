import { ErrorWithStack, ErrorWithStackSchema } from "@trigger.dev/internal";

export function formatError(
  error: ErrorWithStack,
  style: "short" | "long" = "short"
): string {
  if (style === "short") {
    return error.name ? `${error.name}: ${error.message}` : error.message;
  }

  return formatError(error, "short") + "\n" + error.stack;
}

export function formatUnknownError(
  error: unknown,
  style: "short" | "long" = "short"
): string {
  const parsedError = ErrorWithStackSchema.safeParse(error);

  if (parsedError.success) {
    return formatError(parsedError.data, style);
  }

  return "Unknown error";
}
