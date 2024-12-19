import { HEADER_NAME } from "../consts.js";
import { createHeaders } from "../util.js";
import { SupervisorClientCommonOptions } from "./types.js";

export function getDefaultWorkerHeaders(
  options: SupervisorClientCommonOptions
): Record<string, string> {
  return createHeaders({
    Authorization: `Bearer ${options.workerToken}`,
    [HEADER_NAME.WORKER_INSTANCE_NAME]: options.instanceName,
    [HEADER_NAME.WORKER_DEPLOYMENT_ID]: options.deploymentId,
    [HEADER_NAME.WORKER_MANAGED_SECRET]: options.managedWorkerSecret,
  });
}

function redactString(value: string, end = 10) {
  return value.slice(0, end) + "*".repeat(value.length - end);
}

function redactNumber(value: number, end = 10) {
  const str = String(value);
  const redacted = redactString(str, end);
  return Number(redacted);
}

export function redactKeys<T extends Record<string, any>>(obj: T, keys: Array<keyof T>): T {
  const redacted = { ...obj };
  for (const key of keys) {
    const value = obj[key];

    if (typeof value === "number") {
      redacted[key] = redactNumber(value) as any;
    } else if (typeof value === "string") {
      redacted[key] = redactString(value) as any;
    } else {
      continue;
    }
  }
  return redacted;
}
