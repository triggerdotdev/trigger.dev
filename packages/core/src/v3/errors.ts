import { TaskRunError } from "./schemas/common";

export function parseError(error: unknown): TaskRunError {
  if (error instanceof Error) {
    return {
      type: "BUILT_IN_ERROR",
      name: error.name,
      message: error.message,
      stackTrace: error.stack ?? "",
    };
  }

  if (typeof error === "string") {
    return {
      type: "STRING_ERROR",
      raw: error,
    };
  }

  try {
    return {
      type: "CUSTOM_ERROR",
      raw: JSON.stringify(error),
    };
  } catch (e) {
    return {
      type: "CUSTOM_ERROR",
      raw: String(error),
    };
  }
}

export function createErrorTaskError(error: TaskRunError): any {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      const e = new Error(error.message);

      e.name = error.name;
      e.stack = error.stackTrace;

      return e;
    }
    case "STRING_ERROR": {
      return error.raw;
    }
    case "CUSTOM_ERROR": {
      return JSON.parse(error.raw);
    }
    case "INTERNAL_ERROR": {
      return new Error(`trigger.dev internal error (${error.code})`);
    }
  }
}
