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

/**
 * If you throw this, it will get converted into an INTERNAL_ERROR
 */
export class InternalError extends Error {
  public readonly code: TaskRunErrorCodes;
  public readonly skipRetrying: boolean;

  constructor({
    code,
    message,
    showStackTrace = true,
    skipRetrying = false,
  }: {
    code: TaskRunErrorCodes;
    message?: string;
    showStackTrace?: boolean;
    skipRetrying?: boolean;
  }) {
    super(`${code}: ${message ?? "No message"}`);
    this.name = "TriggerInternalError";
    this.code = code;
    this.message = message ?? "InternalError";

    if (!showStackTrace) {
      this.stack = undefined;
    }

    this.skipRetrying = skipRetrying;
  }
}

export function isInternalError(error: unknown): error is InternalError {
  return error instanceof Error && error.name === "TriggerInternalError";
}

export class AbortTaskRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortTaskRunError";
  }
}

const MANUAL_OOM_KILL_ERROR_MESSAGE = "MANUAL_OOM_KILL_ERROR";

/**
 * This causes an Out Of Memory error on the run (if it's uncaught).
 * This can be useful if you use a native package that detects it's run out of memory but doesn't kill Node.js
 */
export class OutOfMemoryError extends Error {
  constructor() {
    super(MANUAL_OOM_KILL_ERROR_MESSAGE);
    this.name = "OutOfMemoryError";
  }
}

export function isManualOutOfMemoryError(error: TaskRunError) {
  if (error.type === "BUILT_IN_ERROR") {
    if (error.message && error.message === MANUAL_OOM_KILL_ERROR_MESSAGE) {
      return true;
    }
  }
  return false;
}

export function isOOMRunError(error: TaskRunError) {
  if (error.type === "INTERNAL_ERROR") {
    if (
      error.code === "TASK_PROCESS_OOM_KILLED" ||
      error.code === "TASK_PROCESS_MAYBE_OOM_KILLED"
    ) {
      return true;
    }

    // For the purposes of retrying on a larger machine, we're going to treat this is an OOM error.
    // This is what they look like if we're executing using k8s. They then get corrected later, but it's too late.
    // {"code": "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE", "type": "INTERNAL_ERROR", "message": "Process exited with code -1 after signal SIGKILL."}
    if (
      error.code === "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE" &&
      error.message &&
      error.message.includes("-1")
    ) {
      if (error.message.includes("SIGKILL")) {
        return true;
      }

      if (error.message.includes("SIGABRT") && error.stackTrace) {
        const oomIndicators = [
          "JavaScript heap out of memory",
          "Reached heap limit",
          "FATAL ERROR: Reached heap limit Allocation failed",
        ];

        if (oomIndicators.some((indicator) => error.stackTrace!.includes(indicator))) {
          return true;
        }
      }
    }
  }

  if (error.type === "BUILT_IN_ERROR") {
    // ffmpeg also does weird stuff
    // { "name": "Error", "type": "BUILT_IN_ERROR", "message": "ffmpeg was killed with signal SIGKILL" }
    if (error.message && error.message.includes("ffmpeg was killed with signal SIGKILL")) {
      return true;
    }
  }

  // Special `OutOfMemoryError` for doing a manual OOM kill.
  // Useful if a native library does an OOM but doesn't actually crash the run and you want to manually
  if (isManualOutOfMemoryError(error)) {
    return true;
  }

  return false;
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

export class CompleteTaskWithOutput extends Error {
  public readonly output: unknown;

  constructor(output?: unknown) {
    super("Complete task with output");
    this.name = "CompleteTaskWithOutput";
    this.output = output;
  }
}

export function isCompleteTaskWithOutput(error: unknown): error is CompleteTaskWithOutput {
  return error instanceof Error && error.name === "CompleteTaskWithOutput";
}

export function parseError(error: unknown): TaskRunError {
  if (isInternalError(error)) {
    return {
      type: "INTERNAL_ERROR",
      code: error.code,
      message: error.message,
      stackTrace: error.stack ?? "",
    };
  }

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
        case "TASK_PROCESS_OOM_KILLED":
        case "TASK_PROCESS_MAYBE_OOM_KILLED":
        case "TASK_RUN_CANCELLED":
        case "MAX_DURATION_EXCEEDED":
        case "DISK_SPACE_EXCEEDED":
        case "OUTDATED_SDK_VERSION":
        case "TASK_RUN_HEARTBEAT_TIMEOUT":
        case "TASK_DID_CONCURRENT_WAIT":
        case "RECURSIVE_WAIT_DEADLOCK":
        // run engine errors
        case "TASK_DEQUEUED_INVALID_STATE":
        case "TASK_DEQUEUED_QUEUE_NOT_FOUND":
        case "TASK_HAS_N0_EXECUTION_SNAPSHOT":
        case "TASK_RUN_DEQUEUED_MAX_RETRIES":
          return false;

        //new heartbeat error
        //todo
        case "TASK_RUN_STALLED_EXECUTING":
        case "TASK_RUN_STALLED_EXECUTING_WITH_WAITPOINTS":
        case "GRACEFUL_EXIT_TIMEOUT":
        case "HANDLE_ERROR_ERROR":
        case "TASK_INPUT_ERROR":
        case "TASK_OUTPUT_ERROR":
        case "TASK_MIDDLEWARE_ERROR":
        case "POD_EVICTED":
        case "POD_UNKNOWN_ERROR":
        case "TASK_EXECUTION_ABORTED":
        case "TASK_EXECUTION_FAILED":
        case "TASK_RUN_CRASHED":
        case "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE":
        case "TASK_PROCESS_SIGTERM":
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

export function shouldLookupRetrySettings(error: TaskRunError): boolean {
  switch (error.type) {
    case "INTERNAL_ERROR": {
      switch (error.code) {
        case "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE":
          return true;

        default:
          return false;
      }
    }
    case "STRING_ERROR": {
      return false;
    }
    case "BUILT_IN_ERROR": {
      return false;
    }
    case "CUSTOM_ERROR": {
      return false;
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

export class SuspendedProcessError extends Error {
  constructor() {
    super("Suspended");

    this.name = "SuspendedProcessError";
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
  OUTDATED_SDK_VERSION: {
    message:
      "Your task is using an outdated version of the SDK. Please upgrade to the latest version.",
    link: {
      name: "Beta upgrade guide",
      href: links.docs.upgrade.beta,
    },
  },
  TASK_DID_CONCURRENT_WAIT: {
    message:
      "Parallel waits are not supported, e.g. using Promise.all() around our wait functions.",
    link: {
      name: "Read the docs for solutions",
      href: links.docs.troubleshooting.concurrentWaits,
    },
  },
  RECURSIVE_WAIT_DEADLOCK: {
    message:
      "This run will never execute because it was triggered recursively and the task has no remaining concurrency available.",
    link: {
      name: "See docs for help",
      href: links.docs.concurrency.recursiveDeadlock,
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
  } else if (trunc.includes("SIGABRT")) {
    return "SIGABRT";
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
            case "SIGABRT":
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

      if (isManualOutOfMemoryError(error)) {
        return {
          ...getPrettyTaskRunError("TASK_PROCESS_OOM_KILLED"),
        };
      }

      if (error.name === "TriggerApiError") {
        if (error.message.startsWith("Deadlock detected:")) {
          return {
            type: "BUILT_IN_ERROR",
            name: "Concurrency Deadlock Error",
            message: error.message,
            stackTrace: "",
            link: {
              name: "Read the docs",
              href: links.docs.concurrency.deadlock,
            },
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
          case "SIGABRT":
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
          case "SIGABRT":
            return {
              ...exception,
              ...getPrettyExceptionEvent("TASK_PROCESS_MAYBE_OOM_KILLED"),
            };
          default:
            return exception;
        }
      } else if (exception.message?.includes(TaskRunErrorCodes.RECURSIVE_WAIT_DEADLOCK)) {
        return {
          ...exception,
          ...prettyInternalErrors.RECURSIVE_WAIT_DEADLOCK,
        };
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

export function taskRunErrorToString(error: TaskRunError): string {
  switch (error.type) {
    case "INTERNAL_ERROR": {
      return `Internal error [${error.code}]${error.message ? `: ${error.message}` : ""}`;
    }
    case "BUILT_IN_ERROR": {
      return `${error.name}: ${error.message}`;
    }
    case "STRING_ERROR": {
      return error.raw;
    }
    case "CUSTOM_ERROR": {
      return error.raw;
    }
  }
}
