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
  //todo eventRepository
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
  //todo eventRepository
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
  //todo eventRepository
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
  //todo eventRepository
  runRetryScheduled: [
    {
      time: Date;
      run: {
        id: string;
        attemptNumber: number;
        queue: string;
        traceContext: Record<string, string | undefined>;
        taskIdentifier: string;
      };
      environment: AuthenticatedEnvironment;
      retryAt: Date;
    },
  ];
  //todo eventRepository
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
  //todo advanced logging
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
