import { TaskRunExecutionStatus, TaskRunStatus } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "../shared";
import { TaskRunError } from "@trigger.dev/core/v3";

export type EventBusEvents = {
  //todo reportInvocationUsage()
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
  runExpired: [
    {
      time: Date;
      run: {
        id: string;
        spanId: string;
        ttl: string | null;
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
      };
    },
  ];
  runRetryScheduled: [
    {
      time: Date;
      run: {
        id: string;
        friendlyId: string;
        attemptNumber: number;
        queue: string;
        traceContext: Record<string, string | undefined>;
        taskIdentifier: string;
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
        spanId: string;
        error: TaskRunError;
      };
    },
  ];
  //todo send socket message to the worker
  workerNotification: [
    {
      time: Date;
      run: {
        id: string;
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
        completedWaitpointIds: string[];
        isValid: boolean;
        error: string | null;
      };
    },
  ];
};

export type EventBusEventArgs<T extends keyof EventBusEvents> = EventBusEvents[T];
