import { MachineResources } from "../../schemas/runEngine.js";

export type SupervisorClientCommonOptions = {
  apiUrl: string;
  workerToken: string;
  instanceName: string;
  deploymentId?: string;
  managedWorkerSecret?: string;
  sendRunDebugLogs?: boolean;
};

export type PreDequeueFn = () => Promise<{
  maxResources?: MachineResources;
  skipDequeue?: boolean;
}>;

export type PreSkipFn = () => Promise<void>;
