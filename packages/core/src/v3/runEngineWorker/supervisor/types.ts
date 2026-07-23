import type { MachineResources } from "../../schemas/runEngine.js";

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
  onHttpRequestComplete?: (metric: SupervisorHttpRequestMetric) => void;
};

export type PreDequeueFn = () => Promise<{
  maxResources?: MachineResources;
  skipDequeue?: boolean;
}>;

export type PreSkipFn = () => Promise<void>;
