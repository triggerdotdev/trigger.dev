import { z } from "zod";
import { DeploymentErrorData } from "./schemas/api.js";
import { ImportTaskFileErrors, WorkerManifest } from "./schemas/build.js";
import { SerializedError, TaskRunError } from "./schemas/common.js";
import { TaskMetadataFailedToParseData } from "./schemas/messages.js";

export class AbortTaskRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortTaskRunError";
  }
}

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

export function createJsonErrorObject(error: TaskRunError): SerializedError {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      return {
        name: error.name,
        message: error.message,
        stackTrace: error.stackTrace,
      };
    }
    case "STRING_ERROR": {
      return {
        message: error.raw,
      };
    }
    case "CUSTOM_ERROR": {
      return {
        message: error.raw,
      };
    }
    case "INTERNAL_ERROR": {
      return {
        message: `trigger.dev internal error (${error.code})`,
      };
    }
  }
}

// Removes any null characters from the error message
export function sanitizeError(error: TaskRunError): TaskRunError {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      return {
        type: "BUILT_IN_ERROR",
        message: error.message?.replace(/\0/g, ""),
        name: error.name?.replace(/\0/g, ""),
        stackTrace: error.stackTrace?.replace(/\0/g, ""),
      };
    }
    case "STRING_ERROR": {
      return {
        type: "STRING_ERROR",
        raw: error.raw.replace(/\0/g, ""),
      };
    }
    case "CUSTOM_ERROR": {
      return {
        type: "CUSTOM_ERROR",
        raw: error.raw.replace(/\0/g, ""),
      };
    }
    case "INTERNAL_ERROR": {
      return {
        type: "INTERNAL_ERROR",
        code: error.code,
        message: error.message?.replace(/\0/g, ""),
        stackTrace: error.stackTrace?.replace(/\0/g, ""),
      };
    }
  }
}

export function correctErrorStackTrace(
  stackTrace: string,
  projectDir?: string,
  options?: { removeFirstLine?: boolean; isDev?: boolean }
) {
  const [errorLine, ...traceLines] = stackTrace.split("\n");

  return [
    options?.removeFirstLine ? undefined : errorLine,
    ...traceLines.map((line) => correctStackTraceLine(line, projectDir, options?.isDev)),
  ]
    .filter(Boolean)
    .join("\n");
}

const LINES_TO_IGNORE = [
  /ConsoleInterceptor/,
  /TriggerTracer/,
  /TaskExecutor/,
  /EXECUTE_TASK_RUN/,
  /@trigger.dev\/core/,
  /packages\/core\/src\/v3/,
  /safeJsonProcess/,
  /__entryPoint.ts/,
  /ZodIpc/,
  /startActiveSpan/,
  /processTicksAndRejections/,
];

function correctStackTraceLine(line: string, projectDir?: string, isDev?: boolean) {
  if (LINES_TO_IGNORE.some((regex) => regex.test(line))) {
    return;
  }

  // Check to see if the path is inside the project directory
  if (isDev && projectDir && !line.includes(projectDir)) {
    return;
  }

  return line.trim();
}

export function groupTaskMetadataIssuesByTask(tasks: any, issues: z.ZodIssue[]) {
  return issues.reduce(
    (acc, issue) => {
      if (issue.path.length === 0) {
        return acc;
      }

      const taskIndex = issue.path[2];

      if (typeof taskIndex !== "number") {
        return acc;
      }

      const task = tasks[taskIndex];

      if (!task) {
        return acc;
      }

      const restOfPath = issue.path.slice(3);

      const taskId = task.id;
      const taskName = task.exportName;
      const filePath = task.filePath;

      const key = taskIndex;

      const existing = acc[key] ?? {
        id: taskId,
        exportName: taskName,
        filePath,
        issues: [] as Array<{ message: string; path?: string }>,
      };

      existing.issues.push({
        message: issue.message,
        path: restOfPath.length === 0 ? undefined : restOfPath.join("."),
      });

      return {
        ...acc,
        [key]: existing,
      };
    },
    {} as Record<
      number,
      {
        id: any;
        exportName: string;
        filePath: string;
        issues: Array<{ message: string; path?: string }>;
      }
    >
  );
}

export class UncaughtExceptionError extends Error {
  constructor(
    public readonly originalError: { name: string; message: string; stack?: string },
    public readonly origin: "uncaughtException" | "unhandledRejection"
  ) {
    super(`Uncaught exception: ${originalError.message}`);

    this.name = "UncaughtExceptionError";
  }
}

export class TaskMetadataParseError extends Error {
  constructor(
    public readonly zodIssues: z.ZodIssue[],
    public readonly tasks: any
  ) {
    super(`Failed to parse task metadata`);

    this.name = "TaskMetadataParseError";
  }
}

export class TaskIndexingImportError extends Error {
  constructor(
    public readonly importErrors: ImportTaskFileErrors,
    public readonly manifest: WorkerManifest
  ) {
    super(`Failed to import some task files`);

    this.name = "TaskIndexingImportError";
  }
}

export class UnexpectedExitError extends Error {
  constructor(
    public code: number,
    public signal: NodeJS.Signals | null,
    public stderr: string | undefined
  ) {
    super(`Unexpected exit with code ${code}`);

    this.name = "UnexpectedExitError";
  }
}

export class CleanupProcessError extends Error {
  constructor() {
    super("Cancelled");

    this.name = "CleanupProcessError";
  }
}

export class CancelledProcessError extends Error {
  constructor() {
    super("Cancelled");

    this.name = "CancelledProcessError";
  }
}

export class SigKillTimeoutProcessError extends Error {
  constructor() {
    super("Process kill timeout");

    this.name = "SigKillTimeoutProcessError";
  }
}

export class GracefulExitTimeoutError extends Error {
  constructor() {
    super("Graceful exit timeout");

    this.name = "GracefulExitTimeoutError";
  }
}

export function getFriendlyErrorMessage(
  code: number,
  signal: NodeJS.Signals | null,
  stderr: string | undefined,
  dockerMode = true
) {
  const message = (text: string) => {
    if (signal) {
      return `[${signal}] ${text}`;
    } else {
      return text;
    }
  };

  if (code === 137) {
    if (dockerMode) {
      return message(
        "Process ran out of memory! Try choosing a machine preset with more memory for this task."
      );
    } else {
      // Note: containerState reason and message should be checked to clarify the error
      return message(
        "Process most likely ran out of memory, but we can't be certain. Try choosing a machine preset with more memory for this task."
      );
    }
  }

  if (stderr?.includes("OOMErrorHandler")) {
    return message(
      "Process ran out of memory! Try choosing a machine preset with more memory for this task."
    );
  }

  return message(`Process exited with code ${code}.`);
}

export function serializeIndexingError(error: unknown, stderr?: string): DeploymentErrorData {
  if (error instanceof TaskMetadataParseError) {
    return {
      name: "TaskMetadataParseError",
      message: "There was an error parsing the task metadata",
      stack: JSON.stringify({ zodIssues: error.zodIssues, tasks: error.tasks }),
      stderr,
    };
  } else if (error instanceof TaskIndexingImportError) {
    return {
      name: "TaskIndexingImportError",
      message: "There was an error importing task files",
      stack: JSON.stringify(error.importErrors),
      stderr,
    };
  } else if (error instanceof UncaughtExceptionError) {
    const originalError = error.originalError;

    return {
      name: originalError.name,
      message: originalError.message,
      stack: originalError.stack,
      stderr,
    };
  } else if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      stderr,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
    stderr,
  };
}

export function prepareDeploymentError(
  errorData: DeploymentErrorData
): DeploymentErrorData | undefined {
  if (!errorData) {
    return;
  }

  if (errorData.name === "TaskMetadataParseError") {
    const errorJson = tryJsonParse(errorData.stack);

    if (errorJson) {
      const parsedError = TaskMetadataFailedToParseData.safeParse(errorJson);

      if (parsedError.success) {
        return {
          name: errorData.name,
          message: errorData.message,
          stack: createTaskMetadataFailedErrorStack(parsedError.data),
          stderr: errorData.stderr,
        };
      } else {
        return {
          name: errorData.name,
          message: errorData.message,
          stderr: errorData.stderr,
        };
      }
    } else {
      return {
        name: errorData.name,
        message: errorData.message,
        stderr: errorData.stderr,
      };
    }
  } else if (errorData.name === "TaskIndexingImportError") {
    const errorJson = tryJsonParse(errorData.stack);

    if (errorJson) {
      const parsedError = ImportTaskFileErrors.safeParse(errorJson);

      if (parsedError.success) {
        return {
          name: errorData.name,
          message: errorData.message,
          stack: parsedError.data
            .map((error) => {
              return `x ${error.message} in ${error.file}`;
            })
            .join("\n"),
          stderr: errorData.stderr,
        };
      } else {
        return {
          name: errorData.name,
          message: errorData.message,
          stderr: errorData.stderr,
        };
      }
    } else {
      return {
        name: errorData.name,
        message: errorData.message,
        stderr: errorData.stderr,
      };
    }
  }

  return {
    name: errorData.name,
    message: errorData.message,
    stack: errorData.stack,
    stderr: errorData.stderr,
  };
}

export function createTaskMetadataFailedErrorStack(
  data: z.infer<typeof TaskMetadataFailedToParseData>
): string {
  const stack = [];

  const groupedIssues = groupTaskMetadataIssuesByTask(data.tasks, data.zodIssues);

  for (const key in groupedIssues) {
    const taskWithIssues = groupedIssues[key];

    if (!taskWithIssues) {
      continue;
    }

    stack.push("\n");
    stack.push(`  ❯ ${taskWithIssues.exportName} in ${taskWithIssues.filePath}`);

    for (const issue of taskWithIssues.issues) {
      if (issue.path) {
        stack.push(`    x ${issue.path} ${issue.message}`);
      } else {
        stack.push(`    x ${issue.message}`);
      }
    }
  }

  return stack.join("\n");
}

function tryJsonParse(data: string | undefined): any {
  if (!data) {
    return;
  }

  try {
    return JSON.parse(data);
  } catch {
    return;
  }
}
