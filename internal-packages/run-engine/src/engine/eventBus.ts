import { FlushedRunMetadata, TaskRunError } from "@trigger.dev/core/v3";
import {
  RuntimeEnvironmentType,
  TaskRunExecutionStatus,
  TaskRunStatus,
} from "@trigger.dev/database";
import { EventEmitter } from "events";
import { AuthenticatedEnvironment } from "../shared/index.js";

export type EventBusEvents = {
  runCreated: [
    {
      time: Date;
      runId: string;
    },
  ];
  runEnqueuedAfterDelay: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        queuedAt: Date;
        updatedAt: Date;
        createdAt: Date;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
      };
    },
  ];
  runDelayRescheduled: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        delayUntil: Date;
        updatedAt: Date;
        createdAt: Date;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
      };
    },
  ];
  runLocked: [
    {
      time: Date;
      run: {
        id: string;
        updatedAt: Date;
        status: TaskRunStatus;
        lockedAt: Date;
        lockedById: string;
        lockedToVersionId: string;
        lockedQueueId: string;
        startedAt: Date;
        baseCostInCents: number;
        machinePreset: string;
        taskVersion: string;
        sdkVersion: string;
        cliVersion: string;
        maxDurationInSeconds?: number;
        maxAttempts?: number;
        createdAt: Date;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
      };
    },
  ];
  runStatusChanged: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        updatedAt: Date;
        createdAt: Date;
      };
      organization: {
        id?: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
      };
    },
  ];
  runAttemptStarted: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        createdAt: Date;
        updatedAt: Date;
        attemptNumber: number;
        baseCostInCents: number;
        executedAt: Date | undefined;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
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
        updatedAt: Date;
      };
    },
  ];
  runExpired: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        spanId: string;
        ttl: string | null;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
        expiredAt: Date | null;
        updatedAt: Date;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
      };
    },
  ];
  runSucceeded: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        spanId: string;
        output: string | undefined;
        outputType: string;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
        usageDurationMs: number;
        costInCents: number;
        updatedAt: Date;
        attemptNumber: number;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
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
        updatedAt: Date;
        attemptNumber: number;
        usageDurationMs: number;
        costInCents: number;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
      };
    },
  ];
  runRetryScheduled: [
    {
      time: Date;
      run: {
        id: string;
        status: TaskRunStatus;
        friendlyId: string;
        spanId: string;
        attemptNumber: number;
        queue: string;
        traceContext: Record<string, string | undefined>;
        taskIdentifier: string;
        baseCostInCents: number;
        nextMachineAfterOOM?: string;
        updatedAt: Date;
        createdAt: Date;
        error: TaskRunError;
        taskEventStore?: string;
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
        status: TaskRunStatus;
        friendlyId: string;
        spanId: string;
        error: TaskRunError;
        taskEventStore: string;
        createdAt: Date;
        completedAt: Date | null;
        updatedAt: Date;
        attemptNumber: number;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
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
      cachedRunId?: string;
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
