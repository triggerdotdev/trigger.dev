import { Machine, TaskResource } from "../schemas";

export type VersionedMessage<TMessage> = { version: "v1" } & TMessage;

// provider <--> platform
export interface ProviderClientToServerEvents {
  LOG: (message: VersionedMessage<{ data: string }>) => void;
}

export interface ProviderServerToClientEvents {
  HEALTH: (message: VersionedMessage<{}>, callback: (ack: { status: "ok" }) => void) => void;
  INDEX: (message: VersionedMessage<{ imageTag: string; contentHash: string }>) => void;
  INDEX_COMPLETE: (message: VersionedMessage<{ imageTag: string; contentHash: string }>) => void;
  INVOKE: (message: VersionedMessage<{ name: string; machine: Machine }>) => void;
  RESTORE: (
    message: VersionedMessage<{
      name: string;
      image: string;
      baseImage: string;
      machine: Machine;
    }>
  ) => void;
  DELETE: (
    message: VersionedMessage<{ name: string }>,
    callback: (ack: { message: string }) => void
  ) => void;
  GET: (message: VersionedMessage<{ name: string }>) => void;
}

// coordinator <--> prod worker
export interface ProdWorkerToCoordinatorEvents {
  LOG: (message: VersionedMessage<{ text: string }>, callback: () => {}) => void;
  INDEX_TASKS: (
    message: VersionedMessage<{
      tasks: TaskResource[];
      packageVersion: string;
    }>,
    callback: (params: { success: boolean }) => {}
  ) => void;
  READY: (message: VersionedMessage<{}>) => void;
  WAIT_FOR_DURATION: (message: VersionedMessage<{ seconds: string }>) => void;
  WAIT_FOR_EVENT: (message: VersionedMessage<{ name: string }>) => void;
}

export interface CoordinatorToProdWorkerEvents {
  INVOKE: (message: VersionedMessage<{ payload: any; context: any }>) => void;
  RESUME: (message: VersionedMessage<{}>) => void;
  RESUME_WITH: (message: VersionedMessage<{ data: any }>) => void;
}

export interface ProdWorkerSocketData {
  taskId: string;
  apiKey: string;
  apiUrl: string;
  cliPackageVersion: string;
  contentHash: string;
  projectRef: string;
}

// coordinator <--> platform
export interface CoordinatorToPlatformEvents {
  LOG: (message: VersionedMessage<{ taskId: string; text: string }>) => void;
  READY: (message: VersionedMessage<{ taskId: string }>) => void;
}

export interface PlatformToCoordinatorEvents {
  INVOKE: (message: VersionedMessage<{ taskId: string; payload: any; context: any }>) => void;
  RESUME: (message: VersionedMessage<{ taskId: string }>) => void;
  RESUME_WITH: (message: VersionedMessage<{ taskId: string; data: any }>) => void;
}

// coordinator <--> demo task
export interface DemoTaskToCoordinatorEvents {
  LOG: (message: VersionedMessage<{ text: string }>) => void;
  READY: (message: VersionedMessage<{}>) => void;
  WAIT_FOR_DURATION: (message: VersionedMessage<{ seconds: string }>) => void;
  WAIT_FOR_EVENT: (message: VersionedMessage<{ name: string }>) => void;
}

export interface CoordinatorToDemoTaskEvents {
  INVOKE: (message: VersionedMessage<{ payload: any; context: any }>) => void;
  RESUME: (message: VersionedMessage<{}>) => void;
  RESUME_WITH: (message: VersionedMessage<{ data: any }>) => void;
}

export interface DemoTaskSocketData {
  taskId: string;
}
