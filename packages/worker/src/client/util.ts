import { HEADER_NAME } from "../consts.js";
import { WorkerClientCommonOptions } from "./types.js";

/** Will ignore headers with falsey values */
function createHeaders(headersInit: Record<string, string | undefined>) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(headersInit)) {
    if (!value) {
      continue;
    }
    headers.set(key, value);
  }

  return Object.fromEntries(headers.entries());
}

export function getDefaultHeaders(options: WorkerClientCommonOptions): Record<string, string> {
  return createHeaders({
    Authorization: `Bearer ${options.workerToken}`,
    [HEADER_NAME.WORKER_INSTANCE_NAME]: options.instanceName,
    [HEADER_NAME.WORKER_DEPLOYMENT_ID]: options.deploymentId,
    [HEADER_NAME.WORKER_MANAGED_SECRET]: options.managedWorkerSecret,
  });
}
