import { TaskRunExecutionStatus, TaskRunStatus } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "../shared/index.js";
import { FlushedRunMetadata, TaskRunError } from "@trigger.dev/core/v3";

export type EventBusEvents = {
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
