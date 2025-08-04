import {
  API_VERSION_HEADER_NAME,
  API_VERSION as CORE_API_VERSION,
} from "@trigger.dev/core/v3/serverOnly";
import { z } from "zod";

export const CURRENT_API_VERSION = CORE_API_VERSION;

export const NON_SPECIFIC_API_VERSION = "none";

export type API_VERSIONS = typeof CURRENT_API_VERSION | typeof NON_SPECIFIC_API_VERSION;

export function getApiVersion(request: Request): API_VERSIONS {
  const apiVersion = request.headers.get(API_VERSION_HEADER_NAME);

  if (apiVersion === CURRENT_API_VERSION) {
    return apiVersion;
  }

  return NON_SPECIFIC_API_VERSION;
}

// This has been copied from the core package to allow us to use these types in the webapp
export const RunStatusUnspecifiedApiVersion = z.enum([
  /// Task is waiting for a version update because it cannot execute without additional information (task, queue, etc.). Replaces WAITING_FOR_DEPLOY
  "PENDING_VERSION",
  /// Task hasn't been deployed yet but is waiting to be executed
  "WAITING_FOR_DEPLOY",
  /// Task is waiting to be executed by a worker
  "QUEUED",
  /// Task is currently being executed by a worker
  "EXECUTING",
  /// Task has failed and is waiting to be retried
  "REATTEMPTING",
  /// Task has been paused by the system, and will be resumed by the system
  "FROZEN",
  /// Task has been completed successfully
  "COMPLETED",
  /// Task has been canceled by the user
  "CANCELED",
  /// Task has been completed with errors
  "FAILED",
  /// Task has crashed and won't be retried, most likely the worker ran out of resources, e.g. memory or storage
  "CRASHED",
  /// Task was interrupted during execution, mostly this happens in development environments
  "INTERRUPTED",
  /// Task has failed to complete, due to an error in the system
  "SYSTEM_FAILURE",
  /// Task has been scheduled to run at a specific time
  "DELAYED",
  /// Task has expired and won't be executed
  "EXPIRED",
  /// Task has reached it's maxDuration and has been stopped
  "TIMED_OUT",
]);

export type RunStatusUnspecifiedApiVersion = z.infer<typeof RunStatusUnspecifiedApiVersion>;
