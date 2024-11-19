import {
  DequeuedMessage,
  StartRunAttemptResult,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";

export type WorkerEvents = {
  runQueueMessage: [
    {
      time: Date;
      message: DequeuedMessage;
    },
  ];
  requestRunAttemptStart: [
    {
      time: Date;
      run: {
        id: string;
      };
      snapshot: {
        id: string;
      };
    },
  ];
  runAttemptStarted: [
    {
      time: Date;
    } & StartRunAttemptResult & {
        envVars: Record<string, string>;
      },
  ];
  runAttemptCompleted: [
    {
      time: Date;
      run: {
        id: string;
      };
      snapshot: {
        id: string;
      };
      completion: TaskRunExecutionResult;
    },
  ];
};

export type WorkerEventArgs<T extends keyof WorkerEvents> = WorkerEvents[T];
