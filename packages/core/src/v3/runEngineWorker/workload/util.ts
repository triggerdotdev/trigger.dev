import { WORKLOAD_HEADERS } from "../consts.js";
import { createHeaders } from "../util.js";
import { WorkloadClientCommonOptions } from "./types.js";

export function getDefaultWorkloadHeaders(
  options: WorkloadClientCommonOptions
): Record<string, string> {
  return createHeaders({
    [WORKLOAD_HEADERS.DEPLOYMENT_ID]: options.deploymentId,
    [WORKLOAD_HEADERS.RUNNER_ID]: options.runnerId,
    [WORKLOAD_HEADERS.DEPLOYMENT_VERSION]: options.deploymentVersion,
    [WORKLOAD_HEADERS.PROJECT_REF]: options.projectRef,
  });
}
