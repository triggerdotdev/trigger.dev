import {
  Machine,
  TaskResource,
  ProdTaskRunExecutionPayload,
  TaskRunExecutionResult,
  TaskRunExecution,
} from "../schemas";

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
  READY_FOR_EXECUTION: (message: VersionedMessage<{ attemptId: string }>) => void;
  TASK_HEARTBEAT: (message: VersionedMessage<{ runId: string }>) => void;
  WAIT_FOR_BATCH: (message: VersionedMessage<{ id: string; runs: string[] }>) => void;
  WAIT_FOR_DURATION: (message: VersionedMessage<{ ms: number }>) => void;
  WAIT_FOR_TASK: (message: VersionedMessage<{ id: string }>) => void;
}

export interface CoordinatorToProdWorkerEvents {
  INVOKE: (message: VersionedMessage<{ payload: any; context: any }>) => void;
  RESUME: (
    message: VersionedMessage<{
      attemptId: string;
      image: string;
      completion: TaskRunExecutionResult;
      execution: TaskRunExecution;
    }>
  ) => void;
  RESUME_WITH: (message: VersionedMessage<{ data: any }>) => void;
  EXECUTE_TASK_RUN: (
    message: VersionedMessage<{ payload: ProdTaskRunExecutionPayload }>,
    callback: (ack: { completion: TaskRunExecutionResult }) => void
  ) => void;
}

export interface ProdWorkerSocketData {
  taskId: string;
  apiKey: string;
  apiUrl: string;
  cliPackageVersion: string;
  contentHash: string;
  projectRef: string;
  attemptId?: string;
  podName: string;
}

// coordinator <--> platform
export interface CoordinatorToPlatformEvents {
  LOG: (message: VersionedMessage<{ taskId: string; text: string }>) => void;
  READY: (message: VersionedMessage<{ taskId: string }>) => void;
  READY_FOR_EXECUTION: (
    message: VersionedMessage<{ attemptId: string }>,
    callback: (
      ack:
        | {
            success: false;
          }
        | {
            success: true;
            payload: ProdTaskRunExecutionPayload;
          }
    ) => void
  ) => void;
  TASK_RUN_COMPLETED: (
    message: VersionedMessage<{
      execution: ProdTaskRunExecutionPayload["execution"];
      completion: TaskRunExecutionResult;
    }>
  ) => void;
  TASK_HEARTBEAT: (message: VersionedMessage<{ runId: string }>) => void;
}

export interface PlatformToCoordinatorEvents {
  INVOKE: (message: VersionedMessage<{ taskId: string; payload: any; context: any }>) => void;
  RESUME: (
    message: VersionedMessage<{
      attemptId: string;
      image: string;
      completion: TaskRunExecutionResult;
      execution: TaskRunExecution;
    }>
  ) => void;
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
