export interface WorkerServerToClientEvents {
  "run:notify": (message: { version: "1"; run: { friendlyId: string } }) => void;
}

export interface WorkerClientToServerEvents {
  "run:subscribe": (message: { version: "1"; runFriendlyIds: string[] }) => void;
  "run:unsubscribe": (message: { version: "1"; runFriendlyIds: string[] }) => void;
}

export interface WorkloadServerToClientEvents {
  "run:notify": (message: { version: "1"; run: { friendlyId: string } }) => void;
}

export interface WorkloadClientToServerEvents {
  "run:start": (message: {
    version: "1";
    run: { friendlyId: string };
    snapshot: { friendlyId: string };
  }) => void;
  "run:stop": (message: {
    version: "1";
    run: { friendlyId: string };
    snapshot: { friendlyId: string };
  }) => void;
}

export type WorkloadClientSocketData = {
  deploymentId: string;
  runnerId: string;
  runFriendlyId?: string;
  snapshotId?: string;
};
