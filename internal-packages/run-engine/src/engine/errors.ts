import { assertExhaustive } from "@trigger.dev/core";
import type { TaskRunError } from "@trigger.dev/core/v3";
import type { RuntimeEnvironmentType, TaskRunStatus } from "@trigger.dev/database";

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
    case "TASK_RUN_UNCAUGHT_EXCEPTION":
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
    case "BATCH_ITEM_COULD_NOT_TRIGGER":
    case "PAYLOAD_TOO_LARGE":
    case "UNSPECIFIED_ERROR":
      return "SYSTEM_FAILURE";
    default:
      assertExhaustive(error.code);
  }
}

export type ServiceValidationErrorLevel = "error" | "warn" | "info";

export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public status?: number,
    public metadata?: Record<string, unknown>,
    public logLevel?: ServiceValidationErrorLevel
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

/**
 * Wraps an error thrown by `completeWaitpoint` AFTER the write-ahead completion guard was successfully
 * armed. Its presence is proof the guard is durably persisted and now owns eventual completion, so the
 * API boundary may return success for a RETRYABLE cause. A failure BEFORE the guard is armed (including
 * the arm's own enqueue failing) is NOT wrapped, so it propagates and the caller does not report
 * success. Detect with {@link isWaitpointCompletionGuardArmedError} (a branded property check, robust
 * across module boundaries) rather than the requested `armGuard` boolean.
 */
export class WaitpointCompletionGuardArmedError extends Error {
  readonly isWaitpointCompletionGuardArmed = true as const;
  readonly waitpointId: string;
  readonly cause?: unknown;
  constructor(waitpointId: string, options?: { cause?: unknown }) {
    super(`Waitpoint ${waitpointId} completion failed after its durable guard was armed`);
    this.name = "WaitpointCompletionGuardArmedError";
    this.waitpointId = waitpointId;
    this.cause = options?.cause;
  }
}

export function isWaitpointCompletionGuardArmedError(
  error: unknown
): error is WaitpointCompletionGuardArmedError {
  return (
    error instanceof Error &&
    (error as { isWaitpointCompletionGuardArmed?: unknown }).isWaitpointCompletionGuardArmed ===
      true
  );
}

export class ExecutionSnapshotNotFoundError extends Error {
  constructor(public readonly snapshotId: string) {
    super(`No execution snapshot found for id ${snapshotId}`);
    this.name = "ExecutionSnapshotNotFoundError";
  }
}

/**
 * A run has no execution snapshot in any store. Thrown by `getLatestExecutionSnapshot` for an
 * internal (unscoped) read; the environment-scoped read keeps its 404 `ServiceValidationError`.
 */
export class LatestExecutionSnapshotNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`No execution snapshot found for TaskRun ${runId}`);
    this.name = "LatestExecutionSnapshotNotFoundError";
  }
}

/**
 * A store-format waitpoint blocker reached the generic single-call registration seam. Registering a
 * MemoryDB blocker is a THREE-STEP BARRIER — it cannot be expressed by one `registerBlocks` call:
 *
 *   1. `absorbBlockers` (run-side): install the block id under a compare-and-set, add the ordered
 *      waitpoint references and the distinct pending set, and subtract any completion receipts that
 *      already arrived.
 *   2. The caller publishes the DURABLE blocked execution snapshot transition.
 *   3. `registerAndDeliver` (waitpoint-side): register the run as a watcher on each waitpoint and
 *      immediately deliver any completion the register reports, passing the step-1 absorb result.
 *
 * The transition in step 2 MUST land between steps 1 and 3 — the protocol prefers a recoverable
 * orphaned coordination record over a committed blocked run with no recoverable registration. A single
 * `registerBlocks` call would register wholly before (or after) the transition, so it is refused here
 * rather than left as a callable path that looks safe but violates the barrier. The barrier-aware
 * registration seam and its call-site wiring belong to the blocker-registration migration; until then a
 * store-format blocker must never be registered through this seam. Legacy (Postgres) blockers are
 * unaffected — READ COMMITTED lets their edge write and pending re-check straddle the transition safely.
 */
export class StoreWaitpointRegistrationUnsupported extends Error {
  readonly runId: string;
  readonly waitpointIds: string[];
  constructor(params: { runId: string; waitpointIds: string[] }) {
    super(
      `Cannot register store-format waitpoint(s) [${params.waitpointIds.join(
        ", "
      )}] against run ${params.runId} through the single-call seam: MemoryDB registration is a three-step ` +
        `barrier (absorb → publish blocked transition → register/deliver) that this seam cannot express`
    );
    this.name = "StoreWaitpointRegistrationUnsupported";
    this.runId = params.runId;
    this.waitpointIds = params.waitpointIds;
  }
}

/**
 * A run whose organization could hold MemoryDB block edges was asked to clear its block state inside a
 * rollback-capable Postgres lifecycle transaction (`tx`). Clearing MemoryDB cannot join that
 * transaction, so a clear-then-rollback would leave the run's store blockers destroyed with Postgres
 * unchanged. This fails loud BEFORE either store is mutated. Activation must instead clear MemoryDB
 * only AFTER the durable lifecycle transition has committed (a non-transactional post-transition
 * cleanup, which is allowed to clear both stores). In the dark default (never-enabled org, no store)
 * this is unreachable — the transactional clear stays legacy-only.
 */
export class TransactionalStoreClearUnsupported extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(
      `Cannot clear run ${runId} block state transactionally: the run may hold MemoryDB blockers, and a ` +
        `store clear cannot join the Postgres transaction. Clear MemoryDB only after the lifecycle ` +
        `transition durably commits.`
    );
    this.name = "TransactionalStoreClearUnsupported";
    this.runId = runId;
  }
}

/**
 * A store-format waitpoint id reached the router but no store coordinator is wired. A recognised
 * store id must never fall back to Postgres, so this fails loud rather than mis-routing. In the dark
 * default (no organisation enabled, no store minted) this is unreachable.
 */
export class StoreWaitpointWithoutStoreCoordinator extends Error {
  readonly waitpointId: string;
  constructor(waitpointId: string) {
    super(
      `Store-format waitpoint ${waitpointId} has no store coordinator to route to; refusing to fall back to Postgres`
    );
    this.name = "StoreWaitpointWithoutStoreCoordinator";
    this.waitpointId = waitpointId;
  }
}

export class UnclassifiableWaitpointId extends Error {
  readonly waitpointId: string;
  readonly waitpointIdLength: number;
  readonly cause?: unknown;
  constructor(waitpointId: string, options?: { cause?: unknown }) {
    super(
      `Unclassifiable waitpointId for completion: length ${waitpointId.length} matches neither cuid nor run-ops id — waitpointId=${JSON.stringify(
        waitpointId
      )}`
    );
    this.name = "UnclassifiableWaitpointId";
    this.waitpointId = waitpointId;
    this.waitpointIdLength = waitpointId.length;
    this.cause = options?.cause;
  }
}
