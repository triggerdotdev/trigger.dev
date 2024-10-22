import { z } from "zod";
import { DeploymentErrorData } from "./schemas/api.js";
import { ImportTaskFileErrors, WorkerManifest } from "./schemas/build.js";
import {
  SerializedError,
  TaskRunError,
  TaskRunErrorCodes,
  TaskRunInternalError,
} from "./schemas/common.js";
import { TaskMetadataFailedToParseData } from "./schemas/messages.js";
import { links } from "./links.js";
import { ExceptionEventProperties } from "./schemas/openTelemetry.js";
import { assertExhaustive } from "../utils.js";

export class AbortTaskRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortTaskRunError";
  }
}

export class TaskPayloadParsedError extends Error {
  public readonly cause: unknown;

  constructor(cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);

    super("Parsing payload with schema failed: " + causeMessage);
    this.name = "TaskPayloadParsedError";
    this.cause = cause;
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
      const e = new Error(error.message ?? `Internal error (${error.code})`);
      e.name = error.code;
      e.stack = error.stackTrace;

      return e;
    }
  }
}

export function createJsonErrorObject(error: TaskRunError): SerializedError {
  const enhancedError = taskRunErrorEnhancer(error);

  switch (enhancedError.type) {
    case "BUILT_IN_ERROR": {
      return {
        name: enhancedError.name,
        message: enhancedError.message,
        stackTrace: enhancedError.stackTrace,
      };
    }
    case "STRING_ERROR": {
      return {
        message: enhancedError.raw,
      };
    }
    case "CUSTOM_ERROR": {
      return {
        message: enhancedError.raw,
      };
    }
    case "INTERNAL_ERROR": {
      return {
        message: `trigger.dev internal error (${enhancedError.code})`,
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

export function shouldRetryError(error: TaskRunError): boolean {
  switch (error.type) {
    case "INTERNAL_ERROR": {
      switch (error.code) {
        case "COULD_NOT_FIND_EXECUTOR":
        case "COULD_NOT_FIND_TASK":
        case "COULD_NOT_IMPORT_TASK":
        case "CONFIGURED_INCORRECTLY":
        case "TASK_ALREADY_RUNNING":
        case "TASK_PROCESS_SIGKILL_TIMEOUT":
        case "TASK_PROCESS_SIGSEGV":
        case "TASK_PROCESS_SIGTERM":
        case "TASK_PROCESS_OOM_KILLED":
        case "TASK_PROCESS_MAYBE_OOM_KILLED":
        case "TASK_RUN_CANCELLED":
        case "MAX_DURATION_EXCEEDED":
        case "DISK_SPACE_EXCEEDED":
          return false;

        case "GRACEFUL_EXIT_TIMEOUT":
        case "HANDLE_ERROR_ERROR":
        case "TASK_INPUT_ERROR":
        case "TASK_OUTPUT_ERROR":
        case "POD_EVICTED":
        case "POD_UNKNOWN_ERROR":
        case "TASK_EXECUTION_ABORTED":
        case "TASK_EXECUTION_FAILED":
        case "TASK_RUN_CRASHED":
        case "TASK_RUN_HEARTBEAT_TIMEOUT":
        // TODO: check we really want to retry here, these could be oom errors
        case "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE":
          return true;

        default:
          assertExhaustive(error.code);
      }
    }
    case "STRING_ERROR": {
      return true;
    }
    case "BUILT_IN_ERROR": {
      return true;
    }
    case "CUSTOM_ERROR": {
      return true;
    }
    default: {
      assertExhaustive(error);
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
    super(`Unexpected exit with code ${code} after signal ${signal}`);

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

type ErrorLink = {
  name: string;
  href: string;
  // This allows us to easily add more complex logic on the frontend, e.g. display a button to open a contact form modal
  magic?: "CONTACT_FORM";
};

type EnhanceError<T extends TaskRunError | ExceptionEventProperties> = T & { link?: ErrorLink };

const prettyInternalErrors: Partial<
  Record<
    TaskRunInternalError["code"],
    {
      message: string;
      link?: ErrorLink;
    }
  >
> = {
  TASK_PROCESS_OOM_KILLED: {
    message:
      "Your task ran out of memory. Try increasing the machine specs. If this doesn't fix it there might be a memory leak.",
    link: {
      name: "Machines",
      href: links.docs.machines.home,
    },
  },
  TASK_PROCESS_MAYBE_OOM_KILLED: {
    message:
      "We think your task ran out of memory, but we can't be certain. If this keeps happening, try increasing the machine specs.",
    link: {
      name: "Machines",
      href: links.docs.machines.home,
    },
  },
  TASK_PROCESS_SIGSEGV: {
    message:
      "Your task crashed with a segmentation fault (SIGSEGV). Most likely there's a bug in a package or binary you're using. If this keeps happening and you're unsure why, please get in touch.",
    link: {
      name: "Contact us",
      href: links.site.contact,
      magic: "CONTACT_FORM",
    },
  },
  TASK_PROCESS_SIGTERM: {
    message:
      "Your task exited after receiving SIGTERM but we don't know why. If this keeps happening, please get in touch so we can investigate.",
    link: {
      name: "Contact us",
      href: links.site.contact,
      magic: "CONTACT_FORM",
    },
  },
};

const getPrettyTaskRunError = (code: TaskRunInternalError["code"]): TaskRunInternalError => {
  return {
    type: "INTERNAL_ERROR" as const,
    code,
    ...prettyInternalErrors[code],
  };
};

const getPrettyExceptionEvent = (code: TaskRunInternalError["code"]): ExceptionEventProperties => {
  return {
    type: code,
    ...prettyInternalErrors[code],
  };
};

const findSignalInMessage = (message?: string, truncateLength = 100) => {
  if (!message) {
    return;
  }

  const trunc = truncateLength ? message.slice(0, truncateLength) : message;

  if (trunc.includes("SIGTERM")) {
    return "SIGTERM";
  } else if (trunc.includes("SIGSEGV")) {
    return "SIGSEGV";
  } else if (trunc.includes("SIGKILL")) {
    return "SIGKILL";
  } else {
    return;
  }
};

export function taskRunErrorEnhancer(error: TaskRunError): EnhanceError<TaskRunError> {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      if (error.name === "UnexpectedExitError") {
        if (error.message.startsWith("Unexpected exit with code -1")) {
          const signal = findSignalInMessage(error.stackTrace);

          switch (signal) {
            case "SIGTERM":
              return {
                ...getPrettyTaskRunError("TASK_PROCESS_SIGTERM"),
              };
            case "SIGSEGV":
              return {
                ...getPrettyTaskRunError("TASK_PROCESS_SIGSEGV"),
              };
            case "SIGKILL":
              return {
                ...getPrettyTaskRunError("TASK_PROCESS_MAYBE_OOM_KILLED"),
              };
            default:
              return {
                ...getPrettyTaskRunError("TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE"),
                message: error.message,
                stackTrace: error.stackTrace,
              };
          }
        }
      }

      if (error.name === "Error") {
        if (error.message === "ffmpeg was killed with signal SIGKILL") {
          return {
            ...getPrettyTaskRunError("TASK_PROCESS_OOM_KILLED"),
          };
        }
      }
      break;
    }
    case "STRING_ERROR": {
      break;
    }
    case "CUSTOM_ERROR": {
      break;
    }
    case "INTERNAL_ERROR": {
      if (error.code === TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE) {
        const signal = findSignalInMessage(error.message);

        switch (signal) {
          case "SIGTERM":
            return {
              ...getPrettyTaskRunError("TASK_PROCESS_SIGTERM"),
            };
          case "SIGSEGV":
            return {
              ...getPrettyTaskRunError("TASK_PROCESS_SIGSEGV"),
            };
          case "SIGKILL":
            return {
              ...getPrettyTaskRunError("TASK_PROCESS_MAYBE_OOM_KILLED"),
            };
          default: {
            return {
              ...getPrettyTaskRunError("TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE"),
              message: error.message,
              stackTrace: error.stackTrace,
            };
          }
        }
      }

      return {
        ...error,
        ...getPrettyTaskRunError(error.code),
      };
    }
  }

  return error;
}

export function exceptionEventEnhancer(
  exception: ExceptionEventProperties
): EnhanceError<ExceptionEventProperties> {
  switch (exception.type) {
    case "UnexpectedExitError": {
      if (exception.message?.startsWith("Unexpected exit with code -1")) {
        return {
          ...exception,
          ...prettyInternalErrors.TASK_PROCESS_MAYBE_OOM_KILLED,
        };
      }
      break;
    }
    case "Internal error": {
      if (exception.message?.startsWith(TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE)) {
        const signal = findSignalInMessage(exception.message);

        switch (signal) {
          case "SIGTERM":
            return {
              ...exception,
              ...getPrettyExceptionEvent("TASK_PROCESS_SIGTERM"),
            };
          case "SIGSEGV":
            return {
              ...exception,
              ...getPrettyExceptionEvent("TASK_PROCESS_SIGSEGV"),
            };
          case "SIGKILL":
            return {
              ...exception,
              ...getPrettyExceptionEvent("TASK_PROCESS_MAYBE_OOM_KILLED"),
            };
          default:
            return exception;
        }
      }
      break;
    }
    case "Error": {
      if (exception.message === "ffmpeg was killed with signal SIGKILL") {
        return {
          ...exception,
          ...prettyInternalErrors.TASK_PROCESS_OOM_KILLED,
        };
      }
      break;
    }
    case TaskRunErrorCodes.TASK_PROCESS_MAYBE_OOM_KILLED:
    case TaskRunErrorCodes.TASK_PROCESS_OOM_KILLED:
    case TaskRunErrorCodes.TASK_PROCESS_SIGTERM: {
      return {
        ...exception,
        ...getPrettyExceptionEvent(exception.type),
      };
    }
  }

  return exception;
}

export function internalErrorFromUnexpectedExit(
  error: UnexpectedExitError,
  dockerMode = true
): TaskRunInternalError {
  const internalError = {
    type: "INTERNAL_ERROR",
    code: TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE,
    message: `Process exited with code ${error.code} after signal ${error.signal}.`,
    stackTrace: error.stderr,
  } satisfies TaskRunInternalError;

  if (error.code === 137) {
    if (dockerMode) {
      return {
        ...internalError,
        code: TaskRunErrorCodes.TASK_PROCESS_OOM_KILLED,
      };
    } else {
      // Note: containerState reason and message could be checked to clarify the error, maybe the task monitor should be allowed to override these
      return {
        ...internalError,
        code: TaskRunErrorCodes.TASK_PROCESS_MAYBE_OOM_KILLED,
      };
    }
  }

  if (error.stderr?.includes("OOMErrorHandler")) {
    return {
      ...internalError,
      code: TaskRunErrorCodes.TASK_PROCESS_OOM_KILLED,
    };
  }

  if (error.signal === "SIGTERM") {
    return {
      ...internalError,
      code: TaskRunErrorCodes.TASK_PROCESS_SIGTERM,
    };
  }

  return {
    ...internalError,
    code: TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE,
  };
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
