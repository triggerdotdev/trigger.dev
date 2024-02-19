import { TaskResource } from "../schemas";

export type VersionedMessage<TMessage> = { version: "v1" } & TMessage;

// provider
export interface ProviderClientToServerEvents {
  LOG: (message: VersionedMessage<{ data: string }>) => void;
}

export interface ProviderServerToClientEvents {
  INDEX: (message: VersionedMessage<{ imageTag: string; contentHash: string }>) => void;
  INDEX_COMPLETE: (message: VersionedMessage<{ imageTag: string; contentHash: string }>) => void;
}

// prod worker
export interface ProdWorkerToDaemonEvents {
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

export interface DaemonToProdWorkerEvents {
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
