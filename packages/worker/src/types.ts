export interface WorkerServerToClientEvents {
  "run:notify": (message: { version: "1"; run: { id: string } }) => void;
}

export interface WorkerClientToServerEvents {
  "run:subscribe": (message: { version: "1"; runIds: string[] }) => void;
  "run:unsubscribe": (message: { version: "1"; runIds: string[] }) => void;
}

export interface WorkloadServerToClientEvents {
  "run:notify": (message: { version: "1"; run: { id: string } }) => void;
}

export interface WorkloadClientToServerEvents {
  "run:start": (message: { version: "1"; run: { id: string }; snapshot: { id: string } }) => void;
}

export type WorkloadClientSocketData = {
  deploymentId: string;
  runId?: string;
  snapshotId?: string;
};
