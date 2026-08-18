import { WORKER_HEADERS } from "../consts.js";
import { createHeaders } from "../util.js";
import type { SupervisorClientCommonOptions } from "./types.js";

export function getDefaultWorkerHeaders(
  options: SupervisorClientCommonOptions
): Record<string, string> {
  return createHeaders({
    Authorization: `Bearer ${options.workerToken}`,
    [WORKER_HEADERS.INSTANCE_NAME]: options.instanceName,
    [WORKER_HEADERS.DEPLOYMENT_ID]: options.deploymentId,
    [WORKER_HEADERS.MANAGED_SECRET]: options.managedWorkerSecret,
  });
}
