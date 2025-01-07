import type { MachineResources } from "@trigger.dev/core/v3";

export type SupervisorClientCommonOptions = {
  apiUrl: string;
  workerToken: string;
  instanceName: string;
  deploymentId?: string;
  managedWorkerSecret?: string;
};

export type PreDequeueFn = () => Promise<{
  maxResources?: MachineResources;
  skipDequeue?: boolean;
}>;
