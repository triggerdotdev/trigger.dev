import { TaskRunExecutionResult } from "../../schemas/common.js";
import { DequeuedMessage, StartRunAttemptResult } from "../../schemas/runEngine.js";

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
        friendlyId: string;
      };
      snapshot: {
        friendlyId: string;
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
        friendlyId: string;
      };
      snapshot: {
        friendlyId: string;
      };
      completion: TaskRunExecutionResult;
    },
  ];
  runNotification: [
    {
      time: Date;
      run: {
        friendlyId: string;
      };
    },
  ];
};

export type WorkerEventArgs<T extends keyof WorkerEvents> = WorkerEvents[T];
