import { TaskRun, TaskRunExecutionStatus, TaskRunStatus } from "@trigger.dev/database";
import { AuthenticatedEnvironment, MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { FlushedRunMetadata, TaskRunError } from "@trigger.dev/core/v3";
import { EventEmitter } from "events";

export type EventBusEvents = {
  runStatusChanged: [
    {
      time: Date;
      runId: string;
    },
  ];
  runAttemptStarted: [
    {
      time: Date;
      run: {
        id: string;
        attemptNumber: number;
        baseCostInCents: number;
      };
      organization: {
        id: string;
      };
    },
  ];
  runAttemptFailed: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        spanId: string;
        error: TaskRunError;
        attemptNumber: number;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
      };
    },
  ];
  runExpired: [
    {
      time: Date;
      run: {
        id: string;
        spanId: string;
        ttl: string | null;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
      };
    },
  ];
  runSucceeded: [
    {
      time: Date;
      run: {
        id: string;
        spanId: string;
        output: string | undefined;
        outputType: string;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
      };
    },
  ];
  runFailed: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        spanId: string;
        error: TaskRunError;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
      };
    },
  ];
  runRetryScheduled: [
    {
      time: Date;
      run: {
        id: string;
        friendlyId: string;
        spanId: string;
        attemptNumber: number;
        queue: string;
        traceContext: Record<string, string | undefined>;
        taskIdentifier: string;
        baseCostInCents: number;
        nextMachineAfterOOM?: string;
      };
      organization: {
        id: string;
      };
      environment: AuthenticatedEnvironment;
      retryAt: Date;
    },
  ];
  runCancelled: [
    {
      time: Date;
      run: {
        id: string;
        friendlyId: string;
        spanId: string;
        error: TaskRunError;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
      };
    },
  ];
  cachedRunCompleted: [
    {
      time: Date;
      span: {
        id: string;
        createdAt: Date;
      };
      hasError: boolean;
      blockedRunId: string;
    },
  ];
  runMetadataUpdated: [
    {
      time: Date;
      run: {
        id: string;
        metadata: FlushedRunMetadata;
      };
    },
  ];
  workerNotification: [
    {
      time: Date;
      run: {
        id: string;
      };
      snapshot: {
        id: string;
        executionStatus: TaskRunExecutionStatus;
      };
    },
  ];
  executionSnapshotCreated: [
    {
      time: Date;
      run: {
        id: string;
      };
      snapshot: {
        id: string;
        executionStatus: TaskRunExecutionStatus;
        description: string;
        runStatus: string;
        attemptNumber: number | null;
        checkpointId: string | null;
        workerId: string | null;
        runnerId: string | null;
        completedWaitpointIds: string[];
        isValid: boolean;
        error: string | null;
      };
    },
  ];
  incomingCheckpointDiscarded: [
    {
      time: Date;
      run: {
        id: string;
      };
      snapshot: {
        id: string;
        executionStatus: TaskRunExecutionStatus;
      };
      checkpoint: {
        metadata: Record<string, unknown>;
        discardReason: string;
      };
    },
  ];
};

export type EventBusEventArgs<T extends keyof EventBusEvents> = EventBusEvents[T];

export type EventBus = EventEmitter<EventBusEvents>;

/**
 * Sends a notification that a run has changed and we need to fetch the latest run state.
 * The worker will call `getRunExecutionData` via the API and act accordingly.
 */
export async function sendNotificationToWorker({
  runId,
  snapshot,
  eventBus,
}: {
  runId: string;
  snapshot: {
    id: string;
    executionStatus: TaskRunExecutionStatus;
  };
  eventBus: EventBus;
}) {
  eventBus.emit("workerNotification", {
    time: new Date(),
    run: {
      id: runId,
    },
    snapshot: {
      id: snapshot.id,
      executionStatus: snapshot.executionStatus,
    },
  });
}
