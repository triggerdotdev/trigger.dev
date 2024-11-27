import { WORKLOAD_HEADER_NAME } from "../consts.js";
import { createHeaders } from "../util.js";
import { WorkloadClientCommonOptions } from "./types.js";

export function getDefaultWorkloadHeaders(
  options: WorkloadClientCommonOptions
): Record<string, string> {
  return createHeaders({
    [WORKLOAD_HEADER_NAME.WORKLOAD_DEPLOYMENT_ID]: options.deploymentId,
  });
}
