import { TaskRunError } from "./schemas/common";
import nodePath from "node:path";

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

export function correctErrorStackTrace(
  stackTrace: string,
  projectDir?: string,
  options?: { removeFirstLine?: boolean }
) {
  const [errorLine, ...traceLines] = stackTrace.split("\n");

  return [
    options?.removeFirstLine ? undefined : errorLine,
    ...traceLines.map((line) => correctStackTraceLine(line, projectDir)),
  ]
    .filter(Boolean)
    .join("\n");
}

function correctStackTraceLine(line: string, projectDir?: string) {
  const regex = /at (.*?) \(?file:\/\/(\/.*?\.ts):(\d+):(\d+)\)?/;

  const match = regex.exec(line);

  if (!match) {
    return;
  }

  const [_, identifier, path, lineNum, colNum] = match;

  if (!path) {
    return;
  }

  // Check to see if the file name is __entryPoint.ts, if it is we can remove it
  if (nodePath.basename(path) === "__entryPoint.ts") {
    return;
  }

  // Check to see if the path is inside the project directory
  if (projectDir && !path.includes(projectDir)) {
    return;
  }

  return line;
}
