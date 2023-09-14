import type {
  BackgroundTask,
  BackgroundTaskArtifact,
  BackgroundTaskMachineStatus,
  BackgroundTaskProviderStrategy,
} from "@trigger.dev/database";

export type ExternalMachine = {
  id: string;
  status: BackgroundTaskMachineStatus;
  data: any;
};

export type ExternalMachineConfig = {
  cpus: number;
  memory: number;
  diskSize: number;
  region: string;
  image: string;
  env: Record<string, string>;
};

export interface BackgroundTaskProvider {
  prepareArtifact(
    task: BackgroundTask,
    artifact: BackgroundTaskArtifact
  ): Promise<{ image: string; tag: string }>;

  get name(): BackgroundTaskProviderStrategy;
  get defaultRegion(): string;
  get registry(): string;

  getMachineForTask(id: string, task: BackgroundTask): Promise<ExternalMachine | undefined>;
  getMachinesForTask(task: BackgroundTask): Promise<Array<ExternalMachine>>;

  createMachineForTask(
    id: string,
    task: BackgroundTask,
    config: ExternalMachineConfig
  ): Promise<ExternalMachine>;

  cleanupForTask(task: BackgroundTask): Promise<void>;
}
