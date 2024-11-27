import { HEADER_NAME } from "../consts.js";
import { createHeaders } from "../util.js";
import { WorkerClientCommonOptions } from "./types.js";

export function getDefaultWorkerHeaders(
  options: WorkerClientCommonOptions
): Record<string, string> {
  return createHeaders({
    Authorization: `Bearer ${options.workerToken}`,
    [HEADER_NAME.WORKER_INSTANCE_NAME]: options.instanceName,
    [HEADER_NAME.WORKER_DEPLOYMENT_ID]: options.deploymentId,
    [HEADER_NAME.WORKER_MANAGED_SECRET]: options.managedWorkerSecret,
  });
}
