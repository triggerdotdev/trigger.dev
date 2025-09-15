import { assertExhaustive } from "@trigger.dev/core";
import { TaskRunError } from "@trigger.dev/core/v3";
import { RuntimeEnvironmentType, TaskRunStatus } from "@trigger.dev/database";

export function runStatusFromError(
  error: TaskRunError,
  environmentType: RuntimeEnvironmentType
): TaskRunStatus {
  if (error.type !== "INTERNAL_ERROR") {
    return "COMPLETED_WITH_ERRORS";
  }

  //"CRASHED" should be used if it's a user-error or something they've misconfigured
  //e.g. not enough memory
  //"SYSTEM_FAILURE" should be used if it's an error from our system
  //e.g. a bug
  switch (error.code) {
    case "RECURSIVE_WAIT_DEADLOCK":
    case "TASK_INPUT_ERROR":
    case "TASK_OUTPUT_ERROR":
    case "TASK_MIDDLEWARE_ERROR":
      return "COMPLETED_WITH_ERRORS";
    case "TASK_RUN_CANCELLED":
      return "CANCELED";
    case "MAX_DURATION_EXCEEDED":
      return "TIMED_OUT";
    case "TASK_RUN_STALLED_EXECUTING":
    case "TASK_RUN_STALLED_EXECUTING_WITH_WAITPOINTS": {
      if (environmentType === "DEVELOPMENT") {
        return "CANCELED";
      }

      return "COMPLETED_WITH_ERRORS";
    }

    case "TASK_PROCESS_OOM_KILLED":
    case "TASK_PROCESS_MAYBE_OOM_KILLED":
    case "TASK_PROCESS_SIGSEGV":
    case "DISK_SPACE_EXCEEDED":
    case "OUTDATED_SDK_VERSION":
    case "HANDLE_ERROR_ERROR":
    case "TASK_RUN_CRASHED":
    case "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE":
      return "CRASHED";
    case "COULD_NOT_FIND_EXECUTOR":
    case "COULD_NOT_FIND_TASK":
    case "COULD_NOT_IMPORT_TASK":
    case "CONFIGURED_INCORRECTLY":
    case "TASK_ALREADY_RUNNING":
    case "TASK_PROCESS_SIGKILL_TIMEOUT":
    case "TASK_RUN_HEARTBEAT_TIMEOUT":
    case "TASK_DEQUEUED_INVALID_STATE":
    case "TASK_DEQUEUED_QUEUE_NOT_FOUND":
    case "TASK_RUN_DEQUEUED_MAX_RETRIES":
    case "TASK_HAS_N0_EXECUTION_SNAPSHOT":
    case "GRACEFUL_EXIT_TIMEOUT":
    case "POD_EVICTED":
    case "POD_UNKNOWN_ERROR":
    case "TASK_EXECUTION_ABORTED":
    case "TASK_EXECUTION_FAILED":
    case "TASK_PROCESS_SIGTERM":
    case "TASK_DID_CONCURRENT_WAIT":
      return "SYSTEM_FAILURE";
    default:
      assertExhaustive(error.code);
  }
}

export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public status?: number,
    public metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    console.error("This isn't implemented", { message });
    super(message);
  }
}

export class RunDuplicateIdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDuplicateIdempotencyKeyError";
  }
}

export class RunOneTimeUseTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunOneTimeUseTokenError";
  }
}
