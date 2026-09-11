import type { MachineResources } from "../../schemas/runEngine.js";
import type { AnyZodSchema } from "../../types/schemas.js";

export type SupervisorHttpRequestMetric = {
  name: string;
  method: string;
  status: string;
  outcome: "ok" | "http_error" | "invalid_response" | "network_error";
  durationMs: number;
};

export type SupervisorClientCommonOptions = {
  apiUrl: string;
  workerToken: string;
  instanceName: string;
  deploymentId?: string;
  managedWorkerSecret?: string;
  sendRunDebugLogs?: boolean;
  resolveResponseSchema?: <T extends AnyZodSchema>(schema: T) => T;
  onHttpRequestComplete?: (metric: SupervisorHttpRequestMetric) => void;
};

export type PreDequeueFn = () => Promise<{
  maxResources?: MachineResources;
  skipDequeue?: boolean;
}>;

export type PreSkipFn = () => Promise<void>;
